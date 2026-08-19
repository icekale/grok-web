import { createFileRoute } from "@tanstack/react-router";
import { POST as POSTHandler } from "@/app/api/git/commit/route";

export const Route = createFileRoute("/api/git/commit")({
  server: {
    handlers: {
      POST: ({ request }) => POSTHandler(request),
    },
  },
});
