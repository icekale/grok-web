import { createFileRoute } from "@tanstack/react-router";
import {
  GET as getProjectTrust,
  POST as postProjectTrust,
} from "@/lib/project-trust-http";

export const Route = createFileRoute("/api/project-trust")({
  server: {
    handlers: {
      GET: ({ request }) => getProjectTrust(request),
      POST: ({ request }) => postProjectTrust(request),
    },
  },
});
