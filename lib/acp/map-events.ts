export type AcpSseEvent = {
  type: string;
  [key: string]: unknown;
};

export class AcpTurnMapper {
  private started = false;
  private nextContentIndex = 0;
  private textIndex: number | undefined;
  private thinkingIndex: number | undefined;
  private readonly toolIndexById = new Map<string, number>();
  private readonly toolNameById = new Map<string, string>();
  private readonly partialContent: unknown[] = [];

  begin(): void {
    this.started = false;
    this.nextContentIndex = 0;
    this.textIndex = undefined;
    this.thinkingIndex = undefined;
    this.toolIndexById.clear();
    this.toolNameById.clear();
    this.partialContent.length = 0;
  }

  push(update: unknown): AcpSseEvent[] {
    if (!isRecord(update) || typeof update.sessionUpdate !== "string") return [];
    switch (update.sessionUpdate) {
      case "agent_thought_chunk":
        return this.textLike("thinking_delta", "thinking", contentText(update.content));
      case "agent_message_chunk":
        return this.textLike("text_delta", "text", contentText(update.content));
      case "tool_call":
        return this.toolCall(update);
      case "tool_call_update":
        return this.toolCallUpdate(update);
      default:
        return [];
    }
  }

  endTurn(): AcpSseEvent[] {
    return [{ type: "agent_end" }, { type: "prompt_done" }, { type: "agent_settled" }];
  }

  private startPrefix(): AcpSseEvent[] {
    if (this.started) return [];
    this.started = true;
    return [{ type: "agent_start" }];
  }

  private blockIndex(kind: "thinking" | "text"): number {
    if (kind === "thinking") {
      if (this.thinkingIndex === undefined) this.thinkingIndex = this.nextContentIndex++;
      return this.thinkingIndex;
    }
    if (this.textIndex === undefined) this.textIndex = this.nextContentIndex++;
    return this.textIndex;
  }

  private textLike(
    type: "thinking_delta" | "text_delta",
    kind: "thinking" | "text",
    delta: string,
  ): AcpSseEvent[] {
    const contentIndex = this.blockIndex(kind);
    return [
      ...this.startPrefix(),
      {
        type: "message_update",
        assistantMessageEvent: { type, delta, contentIndex },
      },
    ];
  }

  private toolCall(update: Record<string, unknown>): AcpSseEvent[] {
    const toolCallId = stringField(update.toolCallId) || stringField(update.id);
    const toolName =
      stringField(update.title) || stringField(update.toolName) || stringField(update.kind);
    const input = asRecord(update.input ?? update.rawInput);
    if (toolName) this.toolNameById.set(toolCallId, toolName);

    let contentIndex = this.toolIndexById.get(toolCallId);
    if (contentIndex === undefined) {
      contentIndex = this.nextContentIndex++;
      this.toolIndexById.set(toolCallId, contentIndex);
    }

    this.partialContent[contentIndex] = { type: "toolCall", toolCallId, toolName, input };
    return [
      ...this.startPrefix(),
      {
        type: "message_update",
        assistantMessageEvent: {
          type: "toolcall_start",
          contentIndex,
          id: toolCallId,
          toolName,
          partial: { content: this.partialContent.slice() },
        },
      },
    ];
  }

  private toolCallUpdate(update: Record<string, unknown>): AcpSseEvent[] {
    const toolCallId = stringField(update.toolCallId) || stringField(update.id);
    const toolName =
      stringField(update.title)
      || stringField(update.toolName)
      || stringField(update.kind)
      || this.toolNameById.get(toolCallId)
      || "";
    if (toolName) this.toolNameById.set(toolCallId, toolName);
    return [
      ...this.startPrefix(),
      {
        type: "tool_execution_update",
        toolCallId,
        toolName,
        partialResult: toolPartialResult(update),
      },
    ];
  }
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

function toolPartialResult(update: Record<string, unknown>): unknown {
  if ("partialResult" in update) return update.partialResult;
  if ("content" in update) return { content: update.content };
  if ("rawOutput" in update) return update.rawOutput;
  if (typeof update.status === "string") return { status: update.status };
  return undefined;
}
