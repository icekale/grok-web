export type HistoryMessage =
  | { role: "user"; content: string; timestamp?: number }
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
    };

type AssistantMessage = Extract<HistoryMessage, { role: "assistant" }>;
type AssistantPart = AssistantMessage["content"][number];
type ToolCallPart = Extract<AssistantPart, { type: "toolCall" }>;

export function mapUpdatesJsonl(text: string): {
  messages: HistoryMessage[];
  entryIds: string[];
} {
  const messages: HistoryMessage[] = [];
  const entryIds: string[] = [];
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
        ? record.timestamp
        : undefined;
    const kind = update.sessionUpdate;

    if (kind === "user_message_chunk") {
      const chunk = contentText(update.content);
      if (current?.role === "user") {
        current.content += chunk;
      } else {
        const user: HistoryMessage = { role: "user", content: chunk };
        if (timestamp !== undefined) user.timestamp = timestamp;
        begin(user, eventId);
      }
      continue;
    }

    if (kind === "agent_thought_chunk" || kind === "agent_message_chunk" || kind === "tool_call") {
      if (current?.role !== "assistant") {
        const assistant: AssistantMessage = {
          role: "assistant",
          content: [],
          model: lastModelId ?? "grok",
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
        assistant.content.push({
          type: "toolCall",
          toolCallId: stringField(update.toolCallId) || stringField(update.id),
          toolName:
            stringField(update.title) || stringField(update.kind) || stringField(update.toolName),
          input: asRecord(update.input ?? update.rawInput),
        });
      }
      continue;
    }

    if (kind === "tool_call_update") {
      const id = stringField(update.toolCallId) || stringField(update.id);
      if (!id) continue;
      const tool = findToolCall(current, messages, id);
      if (!tool) continue;
      Object.assign(tool.input, asRecord(update.input ?? update.rawInput));
      if (typeof update.status === "string") tool.status = update.status;
    }
  }

  flush();
  return { messages, entryIds };
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
