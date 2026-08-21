import { createFileRoute } from "@tanstack/react-router";
import { GET as getSettings, PUT as putSettings } from "@/lib/settings-http";

export const Route = createFileRoute("/api/settings")({
  server: {
    handlers: {
      GET: ({ request }) => getSettings(request),
      PUT: ({ request }) => putSettings(request),
    },
  },
});
