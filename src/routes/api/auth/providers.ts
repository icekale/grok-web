import { createFileRoute } from "@tanstack/react-router";
import { GET as GETHandler } from "@/lib/auth-providers-http";

export const Route = createFileRoute("/api/auth/providers")({
  server: {
    handlers: {
      GET: () => GETHandler(),
    },
  },
});
