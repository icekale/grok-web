import { createFileRoute } from "@tanstack/react-router";
import { POST as POSTHandler } from "@/lib/skills-search-http";

export const Route = createFileRoute("/api/skills/search")({
  server: {
    handlers: {
      POST: ({ request }) => POSTHandler(request),
    },
  },
});
