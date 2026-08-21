import { createFileRoute } from "@tanstack/react-router";
import { getSessionState } from "@/lib/session-http";

export const Route = createFileRoute("/api/sessions/$id/state")({
  server: {
    handlers: {
      GET: ({ request, params }) => getSessionState(request, params.id),
    },
  },
});
