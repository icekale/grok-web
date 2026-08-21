import { createFileRoute } from "@tanstack/react-router";
import { GET as GETHandler, PUT as PUTHandler } from "@/lib/ui-locale-http";

export const Route = createFileRoute("/api/ui-locale")({
  server: {
    handlers: {
      GET: ({ request }) => GETHandler(request),
      PUT: ({ request }) => PUTHandler(request),
    },
  },
});
