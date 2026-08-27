import { createFileRoute } from "@tanstack/react-router";
import {
  GET as getHooks,
  POST as postHooks,
} from "@/lib/hooks-http";

export const Route = createFileRoute("/api/hooks")({
  server: {
    handlers: {
      GET: ({ request }) => getHooks(request),
      POST: ({ request }) => postHooks(request),
    },
  },
});
