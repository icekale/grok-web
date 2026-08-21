import { createFileRoute } from "@tanstack/react-router";
import { POST as POSTHandler } from "@/lib/default-cwd-http";

export const Route = createFileRoute("/api/default-cwd")({
  server: {
    handlers: {
      POST: () => POSTHandler(),
    },
  },
});
