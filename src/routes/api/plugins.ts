import { createFileRoute } from "@tanstack/react-router";
import {
  GET as getPlugins,
  POST as postPlugins,
} from "@/lib/mcp-http";

export const Route = createFileRoute("/api/plugins")({
  server: {
    handlers: {
      GET: ({ request }) => getPlugins(request),
      POST: ({ request }) => postPlugins(request),
    },
  },
});
