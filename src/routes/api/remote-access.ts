import { createFileRoute } from "@tanstack/react-router";
import { GET as getRemoteAccess, PUT as putRemoteAccess } from "@/lib/remote-access-http";

export const Route = createFileRoute("/api/remote-access")({
  server: {
    handlers: {
      GET: ({ request }) => getRemoteAccess(request),
      PUT: ({ request }) => putRemoteAccess(request),
    },
  },
});
