/** grok-web SSE wire. Event names may match the old transport; this is not a Pi SDK. */

export type ClientAssistantMessageEvent =
  | { type: "text_start"; contentIndex: number }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number; content: string }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "thinking_end"; contentIndex: number; content: string }
  | { type: "toolcall_start"; contentIndex: number; id?: string; toolName?: string }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; id?: string; toolName?: string }
  | {
    type: "toolcall_end";
    contentIndex: number;
    toolCall: {
      type?: string;
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    };
  };

export type ClientMessageUpdateEvent = {
  type: "message_update";
  assistantMessageEvent: ClientAssistantMessageEvent;
  message?: unknown;
};

export type SessionSnapshotEvent = {
  type: "session_snapshot";
  sessionId: string;
  promptGeneration: number;
  busy: boolean;
  streamingMessage: unknown | null;
  queuedMessages: { steering: string[]; followUp: string[] };
  pendingPermissions: Array<Record<string, unknown>>;
  model: { provider: string; id: string };
  thinkingLevel?: string;
  toolPresets: unknown[];
  contextUsage?: unknown;
  eventSequence: number;
};

export type GrokWireEvent =
  | SessionSnapshotEvent
  | { type: "connected"; sessionId: string; isStreaming?: boolean }
  | { type: "context_usage"; contextUsage: unknown }
  | { type: "agent_start" }
  | { type: "agent_end" }
  | { type: "agent_settled" }
  | { type: "prompt_done" }
  | { type: "prompt_error"; errorMessage?: string }
  | { type: "extension_error"; error?: string }
  | { type: "message_start"; message?: unknown }
  | ClientMessageUpdateEvent
  | { type: "message_end"; message?: unknown }
  | { type: "tool_execution_start"; toolCallId?: string; toolName?: string }
  | { type: "tool_execution_update"; toolCallId: string; toolName?: string; partialResult?: unknown }
  | { type: "tool_execution_end"; toolCallId?: string }
  | { type: "queue_update"; steering?: string[]; followUp?: string[] }
  | { type: "auto_retry_start"; attempt?: number; maxAttempts?: number; errorMessage?: string }
  | { type: "auto_retry_end" }
  | { type: "auto_compaction_start" }
  | { type: "compaction_start" }
  | { type: "auto_compaction_end"; errorMessage?: string; aborted?: unknown; result?: unknown; reason?: string }
  | { type: "compaction_end"; errorMessage?: string; aborted?: unknown; result?: unknown; reason?: string }
  | { type: "extension_ui_request"; id: string; method: string; [k: string]: unknown }
  | { type: "permission_resolved"; sessionId: string; id: string; result: string }
  | { type: string; [k: string]: unknown };

export interface AgentEventLike {
  type: string;
  [key: string]: unknown;
}

const OMITTED_EVENT_TYPES = new Set([
  "turn_start",
  "turn_end",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolCallMetadata(
  event: Record<string, unknown>,
): { id: string; toolName: string } | null {
  if (
    (event.type !== "toolcall_start" && event.type !== "toolcall_delta")
    || !isObject(event.partial)
  ) return null;
  const content = event.partial.content;
  const contentIndex = event.contentIndex;
  if (!Array.isArray(content) || typeof contentIndex !== "number") return null;

  const block = content[contentIndex];
  if (!isObject(block) || block.type !== "toolCall") return null;
  const id = typeof block.id === "string"
    ? block.id
    : (typeof block.toolCallId === "string" ? block.toolCallId : null);
  const toolName = typeof block.name === "string"
    ? block.name
    : (typeof block.toolName === "string" ? block.toolName : null);
  return id !== null && toolName !== null ? { id, toolName } : null;
}

/** Drop turn markers and strip cumulative `partial` from streamed deltas. */
export function toClientAgentEvent(
  event: AgentEventLike,
): GrokWireEvent | null {
  if (!event || typeof event.type !== "string") return null;
  if (OMITTED_EVENT_TYPES.has(event.type)) return null;

  if (event.type === "message_update") {
    const assistantMessageEvent = event.assistantMessageEvent;
    if (
      typeof assistantMessageEvent !== "object"
      || assistantMessageEvent === null
      || Array.isArray(assistantMessageEvent)
    ) return null;

    if (!("partial" in assistantMessageEvent)) {
      return {
        type: "message_update",
        assistantMessageEvent,
      } as ClientMessageUpdateEvent;
    }

    const metadata = toolCallMetadata(assistantMessageEvent as Record<string, unknown>);
    const { partial: _partial, ...deltaEvent } = assistantMessageEvent;
    void _partial;
    return {
      type: "message_update",
      assistantMessageEvent: metadata ? { ...deltaEvent, ...metadata } : deltaEvent,
    } as ClientMessageUpdateEvent;
  }

  if (event.type === "tool_execution_update") {
    return {
      type: "tool_execution_update",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      partialResult: event.partialResult,
    };
  }

  if (event.type === "agent_end") return { type: "agent_end" };
  return event;
}

export function isEventIncludedInSnapshot(
  event: AgentEventLike,
  snapshot: unknown,
): boolean {
  return snapshot !== undefined
    && Boolean(event)
    && (event.type === "message_start" || event.type === "message_update")
    && event.message === snapshot;
}
