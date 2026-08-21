import { createFileRoute } from "@tanstack/react-router";
import { GET as GETHandler } from "@/lib/models-http";

export const Route = createFileRoute("/api/models")({
  server: {
    handlers: {
      GET: ({ request }) => GETHandler(request),
    },
  },
});
