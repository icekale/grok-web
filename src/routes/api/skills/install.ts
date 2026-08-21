import { createFileRoute } from "@tanstack/react-router";
import { POST as POSTHandler } from "@/lib/skills-install-http";

export const Route = createFileRoute("/api/skills/install")({
  server: {
    handlers: {
      POST: ({ request }) => POSTHandler(request),
    },
  },
});
