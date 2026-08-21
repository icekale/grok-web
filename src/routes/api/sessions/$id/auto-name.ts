import { createFileRoute } from "@tanstack/react-router";
import { autoNameSession } from "@/lib/session-http";

export const Route = createFileRoute("/api/sessions/$id/auto-name")({
  server: {
    handlers: {
      POST: ({ params }) => autoNameSession(params.id),
    },
  },
});
