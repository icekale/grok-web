import { createAgentEventStream } from "@/lib/agent-event-stream";
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
    isStreaming: runtime.isBusy(id),
    streamingMessage: null,
    onEvent: (listener: (event: Record<string, unknown>) => void) => runtime.subscribe(id, listener),
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
