import { createFileRoute } from "@tanstack/react-router";
import { POST as POSTHandler } from "@/app/api/git/stage/route";

export const Route = createFileRoute("/api/git/stage")({
  server: {
    handlers: {
      POST: ({ request }) => POSTHandler(request),
    },
  },
});
