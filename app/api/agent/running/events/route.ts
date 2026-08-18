import { getAgentRuntime } from "@/lib/acp/runtime";

// GET /api/agent/running/events - SSE stream of the set of currently-running
// session ids. Pushes a snapshot immediately, then again every second.
export async function GET(req: Request) {
  const runtime = getAgentRuntime();
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const encode = (data: unknown) => {
        const text = `data: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(text));
      };

      const emit = () => {
        try {
          encode({ type: "running", runningSessionIds: runtime.listBusyIds() });
        } catch {
          // controller already closed
        }
      };

      emit();

      const poll = setInterval(emit, 1000);

      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(":\n\n"));
        } catch {
          // controller already closed
        }
      }, 30_000);

      const cleanup = () => {
        clearInterval(poll);
        clearInterval(heartbeat);
        try { controller.close(); } catch { /* already closed */ }
      };

      req.signal?.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
