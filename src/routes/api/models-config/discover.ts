import { createFileRoute } from "@tanstack/react-router";
import { POST as POSTHandler } from "@/lib/models-config-discover-http";

export const Route = createFileRoute("/api/models-config/discover")({
  server: {
    handlers: {
      POST: ({ request }) => POSTHandler(request),
    },
  },
});
