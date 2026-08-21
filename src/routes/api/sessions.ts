import { createFileRoute } from "@tanstack/react-router";
import { getSessions } from "@/lib/session-http";

export const Route = createFileRoute("/api/sessions")({
  server: {
    handlers: {
      GET: ({ request }) => getSessions(request),
    },
  },
});
