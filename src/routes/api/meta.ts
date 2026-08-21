import { createFileRoute } from "@tanstack/react-router";
import { postMeta } from "@/lib/session-http";

export const Route = createFileRoute("/api/meta")({
  server: {
    handlers: {
      POST: ({ request }) => postMeta(request),
    },
  },
});
