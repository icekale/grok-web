import { createFileRoute } from "@tanstack/react-router";
import { getSessionExport } from "@/lib/session-http";

export const Route = createFileRoute("/api/sessions/$id/export")({
  server: {
    handlers: {
      GET: ({ request, params }) => getSessionExport(request, params.id),
    },
  },
});
