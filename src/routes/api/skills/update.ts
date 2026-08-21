import { createFileRoute } from "@tanstack/react-router";
import { POST as POSTHandler } from "@/lib/skills-update-http";

export const Route = createFileRoute("/api/skills/update")({
  server: {
    handlers: {
      POST: ({ request }) => POSTHandler(request),
    },
  },
});
