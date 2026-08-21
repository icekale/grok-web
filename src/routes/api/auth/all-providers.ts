import { createFileRoute } from "@tanstack/react-router";
import { GET as GETHandler } from "@/lib/auth-all-providers-http";

export const Route = createFileRoute("/api/auth/all-providers")({
  server: {
    handlers: {
      GET: () => GETHandler(),
    },
  },
});
