import { createFileRoute } from "@tanstack/react-router";
import { handleGitWrite } from "@/lib/git-http";

export const Route = createFileRoute("/api/git/commit")({
  server: {
    handlers: {
      POST: ({ request }) => handleGitWrite(request, "commit"),
    },
  },
});
