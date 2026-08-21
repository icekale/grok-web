import { createFileRoute } from "@tanstack/react-router";
import { POST as POSTHandler } from "@/lib/cwd-validate-http";

export const Route = createFileRoute("/api/cwd/validate")({
  server: {
    handlers: {
      POST: ({ request }) => POSTHandler(request),
    },
  },
});
