import { createFileRoute } from "@tanstack/react-router";
import { GET as getAgentEvents } from "@/lib/agent-events-http";

export const Route = createFileRoute("/api/agent/$id/events")({
  server: {
    handlers: {
      GET: ({ request, params }) => getAgentEvents(request, {
        params: Promise.resolve({ id: params.id }),
      }),
    },
  },
});
