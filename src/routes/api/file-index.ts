import { createFileRoute } from "@tanstack/react-router";
import { GET as GETHandler } from "@/lib/file-index-http";

export const Route = createFileRoute("/api/file-index")({
  server: {
    handlers: {
      GET: ({ request }) => GETHandler(request),
    },
  },
});
