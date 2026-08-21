import { epochMillis } from "./epoch-ms.ts";
import { grokCanonicalToolName, sanitizeGrokToolInput } from "./grok-tool-input.ts";

export type HistoryToolResult = {
  role: "toolResult";
  toolCallId: string;
  toolName?: string;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export type HistoryUserImage = {
  type: "image";
  source: {
    type: "base64";
    media_type?: string;
    data?: string;
  } | {
    type: "url";
    url?: string;
  };
};

export type HistoryUserBlock = { type: "text"; text: string } | HistoryUserImage;
export type HistoryUserContent = string | HistoryUserBlock[];

export type HistoryMessage =
  | { role: "user"; content: HistoryUserContent; timestamp?: number }
  | {
      role: "assistant";
      content: Array<
        | { type: "text"; text: string }
        | { type: "thinking"; thinking: string }
        | {
            type: "toolCall";
            toolCallId: string;
            toolName: string;
            input: Record<string, unknown>;
            status?: string;
          }
      >;
      model: string;
      provider: "grok";
      timestamp?: number;
    }
  | HistoryToolResult;

type AssistantMessage = Extract<HistoryMessage, { role: "assistant" }>;
type AssistantPart = AssistantMessage["content"][number];
type ToolCallPart = Extract<AssistantPart, { type: "toolCall" }>;

export function mapUpdatesJsonl(text: string): {
  messages: HistoryMessage[];
  entryIds: string[];
} {
  const messages: HistoryMessage[] = [];
  const entryIds: string[] = [];
  const toolOutputs = new Map<string, ToolOutputState>();
  let fallbackId = 0;
  let lastModelId: string | undefined;
  let current: HistoryMessage | null = null;
  let currentEntryId: string | undefined;

  const flush = () => {
    if (!current) return;
    messages.push(current);
    entryIds.push(currentEntryId ?? `msg-${fallbackId++}`);
    current = null;
    currentEntryId = undefined;
  };

  const begin = (message: HistoryMessage, eventId: string | undefined) => {
    flush();
    current = message;
    currentEntryId = eventId;
  };

  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isRecord(record)) continue;

    const params = isRecord(record.params) ? record.params : undefined;
    const update = params && isRecord(params.update) ? params.update : undefined;
    if (!update || typeof update.sessionUpdate !== "string") continue;

    const meta = isRecord(params._meta) ? params._meta : {};
    const eventId = typeof meta.eventId === "string" && meta.eventId ? meta.eventId : undefined;
    const modelId = typeof meta.modelId === "string" && meta.modelId ? meta.modelId : undefined;
    if (modelId) lastModelId = modelId;
    const timestamp =
      typeof record.timestamp === "number" && Number.isFinite(record.timestamp)
        ? epochMillis(record.timestamp)
        : undefined;
    const kind = update.sessionUpdate;

    if (kind === "turn_completed") {
      flush();
      continue;
    }

    if (kind === "user_message_chunk") {
      const { text: chunk, images } = userChunkParts(update.content);
      if (current?.role === "user") {
        appendUserContent(current, chunk, images);
        continue;
      }
      const lastUser = lastUserMessage(messages, current);
      // Grok sometimes replays the same prompt when a turn restarts, before
      // turn_completed. That is not a second user send.
      if (current?.role === "assistant" && images.length === 0 && lastUser === chunk) {
        continue;
      }
      const user: HistoryMessage = images.length > 0
        ? {
          role: "user",
          content: [...(chunk ? [{ type: "text" as const, text: chunk }] : []), ...images],
        }
        : { role: "user", content: chunk };
      if (timestamp !== undefined) user.timestamp = timestamp;
      begin(user, eventId);
      continue;
    }

    if (kind === "agent_thought_chunk" || kind === "agent_message_chunk" || kind === "tool_call") {
      if (current?.role !== "assistant") {
        const assistant: AssistantMessage = {
          role: "assistant",
          content: [],
          model: lastModelId ?? "grok-4.6",
          provider: "grok",
        };
        if (timestamp !== undefined) assistant.timestamp = timestamp;
        begin(assistant, eventId);
      } else if (modelId) {
        current.model = modelId;
      }

      const assistant = current as AssistantMessage;
      if (kind === "agent_thought_chunk") {
        appendThinking(assistant.content, contentText(update.content));
      } else if (kind === "agent_message_chunk") {
        appendText(assistant.content, contentText(update.content));
      } else {
        const toolCallId = stringField(update.toolCallId) || stringField(update.id);
        const toolName = grokCanonicalToolName(
          stringField(update.title) || stringField(update.toolName),
          stringField(update.kind),
        );
        assistant.content.push({
          type: "toolCall",
          toolCallId,
          toolName,
          input: sanitizeGrokToolInput(asRecord(update.input ?? update.rawInput)),
        });
        rememberToolOutput(toolOutputs, toolCallId, toolName, update);
      }
      continue;
    }

    if (kind === "tool_call_update") {
      const id = stringField(update.toolCallId) || stringField(update.id);
      if (!id) continue;
      const tool = findToolCall(current, messages, id);
      if (tool) {
        Object.assign(tool.input, sanitizeGrokToolInput(asRecord(update.input ?? update.rawInput)));
        if (typeof update.status === "string") tool.status = update.status;
      }
      rememberToolOutput(toolOutputs, id, tool?.toolName, update);
    }
  }

  flush();
  for (const [toolCallId, output] of toolOutputs) {
    if (!output.text) continue;
    const result: HistoryToolResult = {
      role: "toolResult",
      toolCallId,
      content: [{ type: "text", text: output.text }],
    };
    if (output.toolName) result.toolName = output.toolName;
    if (output.isError) result.isError = true;
    const owner = indexOfToolOwner(messages, toolCallId);
    const insertAt = owner < 0 ? messages.length : insertAfterOwner(messages, owner);
    messages.splice(insertAt, 0, result);
    entryIds.splice(insertAt, 0, toolCallId);
  }
  return { messages, entryIds };
}

export function historyUserText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => (
      isRecord(block) && block.type === "text" && typeof block.text === "string"
    ))
    .map((block) => block.text)
    .join("");
}

function lastUserMessage(
  messages: HistoryMessage[],
  current: HistoryMessage | null,
): string | undefined {
  if (current?.role === "user") return historyUserText(current.content);
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "user") return historyUserText(message.content);
  }
  return undefined;
}

function userChunkParts(content: unknown): { text: string; images: HistoryUserImage[] } {
  const items = Array.isArray(content) ? content : [content];
  let text = "";
  const images: HistoryUserImage[] = [];
  for (const item of items) {
    const image = asUserImage(item);
    if (image) {
      images.push(image);
      continue;
    }
    text += contentText(item);
  }
  return { text, images };
}

function asUserImage(value: unknown): HistoryUserImage | null {
  if (!isRecord(value) || value.type !== "image") return null;
  if (isRecord(value.source)) {
    const source = value.source;
    if (source.type === "base64" && typeof source.data === "string" && source.data) {
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: typeof source.media_type === "string" ? source.media_type : "image/png",
          data: source.data,
        },
      };
    }
    if (source.type === "url" && typeof source.url === "string" && source.url) {
      return { type: "image", source: { type: "url", url: source.url } };
    }
  }
  const mimeType = typeof value.mimeType === "string"
    ? value.mimeType
    : typeof value.media_type === "string"
      ? value.media_type
      : "image/png";
  if (typeof value.data === "string" && value.data) {
    return { type: "image", source: { type: "base64", media_type: mimeType, data: value.data } };
  }
  const url = typeof value.url === "string" ? value.url : typeof value.uri === "string" ? value.uri : "";
  if (url) return { type: "image", source: { type: "url", url } };
  return null;
}

function appendUserContent(
  message: Extract<HistoryMessage, { role: "user" }>,
  text: string,
  images: HistoryUserImage[],
): void {
  if (!text && images.length === 0) return;
  if (typeof message.content === "string") {
    if (images.length === 0) {
      message.content += text;
      return;
    }
    const blocks: HistoryUserBlock[] = [];
    const combined = message.content + text;
    if (combined) blocks.push({ type: "text", text: combined });
    blocks.push(...images);
    message.content = blocks;
    return;
  }
  if (text) {
    const last = message.content[message.content.length - 1];
    if (last?.type === "text") last.text += text;
    else message.content.push({ type: "text", text });
  }
  message.content.push(...images);
}

export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(toolResultText).join("");
  if (!isRecord(content)) return "";
  if (typeof content.text === "string") return content.text;
  if ("content" in content) return toolResultText(content.content);
  return "";
}

export type ToolOutputState = {
  text: string;
  toolName?: string;
  isError?: boolean;
  description?: string;
};

export function applyToolOutputUpdate(
  current: ToolOutputState,
  update: Record<string, unknown>,
  toolName?: string,
): ToolOutputState {
  const input = asRecord(update.input ?? update.rawInput);
  const description = (typeof input.description === "string" && input.description)
    || current.description
    || "";
  const chunk = toolResultText(update.content ?? update.rawOutput);
  const failed = update.status === "failed" || update.status === "error";
  const next: ToolOutputState = { ...current, text: current.text, description };
  if (toolName && !next.toolName) next.toolName = grokCanonicalToolName(toolName);
  if (chunk && chunk !== description) next.text += chunk;
  if (failed) next.isError = true;
  return next;
}

function rememberToolOutput(
  outputs: Map<string, ToolOutputState>,
  toolCallId: string,
  toolName: string | undefined,
  update: Record<string, unknown>,
): void {
  if (!toolCallId) return;
  const chunk = toolResultText(update.content ?? update.rawOutput);
  const failed = update.status === "failed" || update.status === "error";
  if (!chunk && !failed && !toolName) return;
  outputs.set(toolCallId, applyToolOutputUpdate(outputs.get(toolCallId) ?? { text: "" }, update, toolName));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {};
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (isRecord(content) && typeof content.text === "string") return content.text;
  return "";
}

function appendText(parts: AssistantPart[], text: string): void {
  if (!text) return;
  const last = parts[parts.length - 1];
  if (last?.type === "text") last.text += text;
  else parts.push({ type: "text", text });
}

function appendThinking(parts: AssistantPart[], thinking: string): void {
  if (!thinking) return;
  const last = parts[parts.length - 1];
  if (last?.type === "thinking") last.thinking += thinking;
  else parts.push({ type: "thinking", thinking });
}

function indexOfToolOwner(messages: HistoryMessage[], id: string): number {
  for (let i = 0; i < messages.length; i++) {
    if (toolInMessage(messages[i], id)) return i;
  }
  return -1;
}

function insertAfterOwner(messages: HistoryMessage[], owner: number): number {
  let index = owner + 1;
  while (index < messages.length && messages[index]?.role === "toolResult") index += 1;
  return index;
}

function findToolCall(
  current: HistoryMessage | null,
  messages: HistoryMessage[],
  id: string,
): ToolCallPart | undefined {
  const fromCurrent = current ? toolInMessage(current, id) : undefined;
  if (fromCurrent) return fromCurrent;
  for (let i = messages.length - 1; i >= 0; i--) {
    const found = toolInMessage(messages[i], id);
    if (found) return found;
  }
  return undefined;
}

function toolInMessage(message: HistoryMessage, id: string): ToolCallPart | undefined {
  if (message.role !== "assistant") return undefined;
  for (let i = message.content.length - 1; i >= 0; i--) {
    const part = message.content[i];
    if (part.type === "toolCall" && part.toolCallId === id) return part;
  }
  return undefined;
}
