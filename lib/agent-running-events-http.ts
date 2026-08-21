import { getAgentRuntime } from "@/lib/acp/runtime";

// GET /api/agent/running/events - SSE stream of the set of currently-running
// session ids. Pushes a snapshot immediately, then again every second.
export async function GET(req: Request) {
  const runtime = getAgentRuntime();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let cancelled = false;
      const emit = () => {
        if (cancelled) return;
        try {
          const text = `data: ${JSON.stringify({ type: "running", runningSessionIds: runtime.listBusyIds() })}\n\n`;
          controller.enqueue(encoder.encode(text));
        } catch {
          // controller already closed
        }
      };

      emit();

      const poll = setInterval(emit, 1000);

      const heartbeat = setInterval(() => {
        if (cancelled) return;
        try {
          controller.enqueue(encoder.encode(":\n\n"));
        } catch {
          // controller already closed
        }
      }, 30_000);

      cleanup = () => {
        if (cancelled) return;
        cancelled = true;
        clearInterval(poll);
        clearInterval(heartbeat);
        try { controller.close(); } catch { /* already closed */ }
      };

      req.signal?.addEventListener("abort", cleanup, { once: true });
    },
    cancel() {
      cleanup();
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
