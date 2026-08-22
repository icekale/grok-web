import { isEventIncludedInSnapshot, toClientAgentEvent, type AgentEventLike } from "./agent-event-wire";
import type { SessionSnapshotEvent } from "./agent-events";
import type { ContextUsage } from "./pi-types";
import { getPromptGeneration } from "./prompt-generation";

export type AgentEventStreamContextUsage = ContextUsage;

export interface AgentEventStreamSession {
  readonly isStreaming?: boolean;
  readonly streamingMessage?: unknown;
  readonly contextUsage?: AgentEventStreamContextUsage | Promise<AgentEventStreamContextUsage | null> | null;
  snapshot?: () => Promise<Omit<SessionSnapshotEvent, "type" | "sessionId"> | SessionSnapshotEvent>;
  onEvent(listener: (entry: AgentEventLike | { sequence: number; event: AgentEventLike }) => void): () => void;
}

const HEARTBEAT_INTERVAL_MS = 30_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Open the SSE transport immediately, then publish the session snapshot only
 * after the agent is ready and its event listener has been installed.
 */
export function createAgentEventStream(
  req: Request,
  sessionId: string,
  sessionPromise: Promise<AgentEventStreamSession>,
): ReadableStream<Uint8Array> {
  let cancelStream: (closeController: boolean) => void = () => {};

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let unsubscribe: (() => void) | null = null;
      let abortHandler: (() => void) | null = null;

      const cleanup = (closeController: boolean) => {
        if (closed) return;
        closed = true;
        if (heartbeat !== null) clearInterval(heartbeat);
        unsubscribe?.();
        unsubscribe = null;
        if (abortHandler) req.signal.removeEventListener("abort", abortHandler);
        if (closeController) {
          try { controller.close(); } catch { /* stream already closed */ }
        }
      };
      cancelStream = cleanup;

      const enqueueText = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup(false);
        }
      };
      const encode = (data: unknown) => {
        enqueueText(`data: ${JSON.stringify(data)}\n\n`);
      };
      let streamPromptGeneration = getPromptGeneration(sessionId);
      const forwardEvent = (event: AgentEventLike, snapshot: unknown = undefined) => {
        if (isEventIncludedInSnapshot(event, snapshot)) return;
        const clientEvent = toClientAgentEvent(event);
        if (clientEvent) {
          // Stamp the generation that was current when the event was emitted;
          // the client drops terminal events older than its latest prompt.
          encode({ ...clientEvent, promptGeneration: streamPromptGeneration });
        }
      };

      const publishSession = async () => {
        try {
          const session = await sessionPromise;
          if (closed) return;

          const modernSnapshot = typeof session.snapshot === "function";
          const bufferedEvents: Array<{ sequence: number; event: AgentEventLike }> = [];
          let snapshotPublished = false;
          const handleEvent = (entry: AgentEventLike | { sequence: number; event: AgentEventLike }) => {
            const normalized: { sequence: number; event: AgentEventLike } = modernSnapshot
              && entry && typeof entry === "object" && "event" in entry
              ? entry as { sequence: number; event: AgentEventLike }
              : { sequence: Number.MAX_SAFE_INTEGER, event: entry as AgentEventLike };
            if (!snapshotPublished) {
              bufferedEvents.push(normalized);
              return;
            }
            forwardEvent(normalized.event);
          };

          const stopListening = session.onEvent(handleEvent);
          if (closed) {
            stopListening();
            return;
          }
          unsubscribe = stopListening;

          if (modernSnapshot) {
            const snapshot = await session.snapshot!();
            if (closed) return;
            const snapshotEvent = { ...snapshot, type: "session_snapshot" as const, sessionId };
            streamPromptGeneration = Number(snapshot.promptGeneration ?? streamPromptGeneration);
            encode(snapshotEvent);
            for (const entry of bufferedEvents) {
              if (entry.sequence > Number(snapshot.eventSequence ?? 0)) forwardEvent(entry.event);
            }
            snapshotPublished = true;
          } else {
            const snapshot = session.isStreaming === true ? session.streamingMessage : null;
            encode({
              type: "connected",
              sessionId,
              isStreaming: session.isStreaming,
            });
            const contextUsage = await session.contextUsage;
            if (closed) return;
            if (contextUsage && contextUsage.contextWindow > 0) {
              encode({ type: "context_usage", contextUsage });
            }
            for (const entry of bufferedEvents) forwardEvent(entry.event, snapshot);
            if (snapshot !== undefined && snapshot !== null) {
              encode({ type: "message_start", message: snapshot });
            }
            snapshotPublished = true;
          }
        } catch (error) {
          if (closed) return;
          encode({
            type: "startup_error",
            errorMessage: `Failed to start agent: ${errorMessage(error)}`,
          });
          cleanup(true);
        }
      };

      // Attach the rejection handler before checking the request signal. The
      // route may already have started a shared cold-start promise.
      void publishSession();

      abortHandler = () => cleanup(true);
      if (req.signal.aborted) {
        cleanup(true);
        return;
      }
      req.signal.addEventListener("abort", abortHandler, { once: true });

      heartbeat = setInterval(() => enqueueText(":\n\n"), HEARTBEAT_INTERVAL_MS);

      // Force the response headers through without claiming that the agent is
      // ready. The client waits for the later `connected` data event.
      enqueueText(":\n\n");
    },
    cancel() {
      cancelStream(false);
    },
  });
}
