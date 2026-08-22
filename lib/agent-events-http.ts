import { createAgentEventStream } from "@/lib/agent-event-stream";
import type { AgentEventLike } from "@/lib/agent-event-wire";
import { getAgentRuntime } from "@/lib/acp/runtime";

// GET /api/agent/[id]/events - SSE stream of agent events
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (req.signal.aborted) return new Response(null, { status: 204 });

  const runtime = getAgentRuntime();
  const sessionPromise = Promise.resolve({
    snapshot: () => runtime.getSessionSnapshot(id),
    onEvent: (listener: (entry: { sequence: number; event: AgentEventLike }) => void) => (
      runtime.subscribeSequenced(id, listener as (entry: { sequence: number; event: Record<string, unknown> }) => void)
    ),
  });

  const stream = createAgentEventStream(req, id, sessionPromise);

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
