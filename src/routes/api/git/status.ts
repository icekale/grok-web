import { createFileRoute } from "@tanstack/react-router";
import { GET as GETHandler } from "@/lib/git-status-http";

export const Route = createFileRoute("/api/git/status")({
  server: {
    handlers: {
      GET: ({ request }) => GETHandler(request),
    },
  },
});
