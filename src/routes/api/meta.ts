import { createFileRoute } from "@tanstack/react-router";
import { POST as postMeta } from "@/app/api/meta/route";

export const Route = createFileRoute("/api/meta")({
  server: {
    handlers: {
      POST: ({ request }) => postMeta(request),
    },
  },
});
