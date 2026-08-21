import { createFileRoute } from "@tanstack/react-router";
import { getSessionContext } from "@/lib/session-http";

export const Route = createFileRoute("/api/sessions/$id/context")({
  server: {
    handlers: {
      GET: ({ request, params }) => getSessionContext(request, params.id),
    },
  },
});
