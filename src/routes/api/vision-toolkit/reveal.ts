import { createFileRoute } from "@tanstack/react-router";
import { POST as POSTHandler } from "@/lib/vision-toolkit-reveal-http";

export const Route = createFileRoute("/api/vision-toolkit/reveal")({
  server: {
    handlers: {
      POST: ({ request }) => POSTHandler(request),
    },
  },
});
