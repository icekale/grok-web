import { createFileRoute } from "@tanstack/react-router";
import { GET as GETHandler } from "@/lib/git-diff-http";

export const Route = createFileRoute("/api/git/diff")({
  server: {
    handlers: {
      GET: ({ request }) => GETHandler(request),
    },
  },
});
