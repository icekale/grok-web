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

export type GrokWireEvent =
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
  | { type: string; [k: string]: unknown };
