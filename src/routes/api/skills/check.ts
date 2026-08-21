import { createFileRoute } from "@tanstack/react-router";
import { POST as POSTHandler } from "@/lib/skills-check-http";

export const Route = createFileRoute("/api/skills/check")({
  server: {
    handlers: {
      POST: ({ request }) => POSTHandler(request),
    },
  },
});
