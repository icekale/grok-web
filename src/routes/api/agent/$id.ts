import { createFileRoute } from "@tanstack/react-router";
import { createAgentHandlers } from "@/lib/acp/http";
import { getAgentRuntime } from "@/lib/acp/runtime";

export const Route = createFileRoute("/api/agent/$id")({
  server: {
    handlers: {
      GET: ({ request, params }) => createAgentHandlers(getAgentRuntime()).getSession(request, params.id),
      POST: ({ request, params }) => createAgentHandlers(getAgentRuntime()).postSession(request, params.id),
    },
  },
});
