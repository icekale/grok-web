import { createFileRoute } from "@tanstack/react-router";
import { createAgentHandlers } from "@/lib/acp/http";
import { getAgentRuntime } from "@/lib/acp/runtime";

export const Route = createFileRoute("/api/agent/new")({
  server: {
    handlers: {
      POST: ({ request }) => createAgentHandlers(getAgentRuntime()).postNew(request),
    },
  },
});
