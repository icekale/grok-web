import { createFileRoute } from "@tanstack/react-router";
import { POST as POSTHandler } from "@/app/api/git/discard/route";

export const Route = createFileRoute("/api/git/discard")({
  server: {
    handlers: {
      POST: ({ request }) => POSTHandler(request),
    },
  },
});
