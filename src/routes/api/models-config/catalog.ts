import { createFileRoute } from "@tanstack/react-router";
import { GET as GETHandler } from "@/lib/models-config-catalog-http";

export const Route = createFileRoute("/api/models-config/catalog")({
  server: {
    handlers: {
      GET: ({ request }) => GETHandler(request),
    },
  },
});
