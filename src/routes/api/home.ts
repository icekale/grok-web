import { createFileRoute } from "@tanstack/react-router";
import { GET as GETHandler } from "@/lib/home-http";

export const Route = createFileRoute("/api/home")({
  server: {
    handlers: {
      GET: () => GETHandler(),
    },
  },
});
