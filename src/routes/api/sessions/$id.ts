import { createFileRoute } from "@tanstack/react-router";
import { deleteSession, getSessionDetail, patchSession } from "@/lib/session-http";

export const Route = createFileRoute("/api/sessions/$id")({
  server: {
    handlers: {
      GET: ({ request, params }) => getSessionDetail(request, params.id),
      PATCH: ({ request, params }) => patchSession(request, params.id),
      DELETE: ({ params }) => deleteSession(params.id),
    },
  },
});
