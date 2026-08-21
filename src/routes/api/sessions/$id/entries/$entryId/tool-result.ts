import { createFileRoute } from "@tanstack/react-router";
import { getToolResult } from "@/lib/session-http";

export const Route = createFileRoute("/api/sessions/$id/entries/$entryId/tool-result")({
  server: {
    handlers: {
      GET: ({ request, params }) => getToolResult(request, params.id, params.entryId),
    },
  },
});
