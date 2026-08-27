import { createFileRoute } from "@tanstack/react-router";
import {
  GET as getMemory,
  POST as postMemory,
} from "@/lib/memory-http";

export const Route = createFileRoute("/api/memory")({
  server: {
    handlers: {
      GET: ({ request }) => getMemory(request),
      POST: ({ request }) => postMemory(request),
    },
  },
});
