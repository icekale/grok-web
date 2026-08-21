import { createFileRoute } from "@tanstack/react-router";
import { handleGitWrite } from "@/lib/git-http";

export const Route = createFileRoute("/api/git/stage")({
  server: {
    handlers: {
      POST: ({ request }) => handleGitWrite(request, "stage"),
    },
  },
});
