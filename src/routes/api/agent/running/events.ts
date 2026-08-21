import { createFileRoute } from "@tanstack/react-router";
import { GET as getRunningEvents } from "@/lib/agent-running-events-http";

export const Route = createFileRoute("/api/agent/running/events")({
  server: {
    handlers: {
      GET: ({ request }) => getRunningEvents(request),
    },
  },
});
