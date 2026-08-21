import { createFileRoute } from "@tanstack/react-router";
import { POST as POSTHandler } from "@/lib/models-config-test-http";

export const Route = createFileRoute("/api/models-config/test")({
  server: {
    handlers: {
      POST: ({ request }) => POSTHandler(request),
    },
  },
});
