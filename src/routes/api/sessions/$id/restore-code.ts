import { createFileRoute } from "@tanstack/react-router";
import { createRestoreCodeHandlers } from "@/lib/restore-code-http";

export const Route = createFileRoute("/api/sessions/$id/restore-code")({
  server: {
    handlers: {
      POST: ({ request, params }) => createRestoreCodeHandlers().POST(request, params),
    },
  },
});
