import { createFileRoute } from "@tanstack/react-router";
import { POST as POSTHandler } from "@/lib/vision-toolkit-health-http";

export const Route = createFileRoute("/api/vision-toolkit/health")({
  server: {
    handlers: {
      POST: ({ request }) => POSTHandler(request),
    },
  },
});
