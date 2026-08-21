import { createFileRoute } from "@tanstack/react-router";
import { getThinking } from "@/lib/session-http";

export const Route = createFileRoute("/api/sessions/$id/entries/$entryId/thinking")({
  server: {
    handlers: {
      GET: ({ request, params }) => getThinking(request, params.id, params.entryId),
    },
  },
});
