import { createFileRoute } from "@tanstack/react-router";
import { GET, PUT } from "@/lib/runtime-profile-http";

export const Route = createFileRoute("/api/runtime-profile")({
  server: {
    handlers: {
      GET: ({ request }) => GET(request),
      PUT: ({ request }) => PUT(request),
    },
  },
});
