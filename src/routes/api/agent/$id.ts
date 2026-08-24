import { createFileRoute } from "@tanstack/react-router";
import { createAgentHandlers } from "@/lib/acp/http";
import { getAgentRuntime } from "@/lib/acp/runtime";
import { ensurePromptUsesVisibleModel } from "@/lib/session-model-retarget";

function agentHandlers() {
  const runtime = getAgentRuntime();
  return createAgentHandlers(runtime, {
    ensurePromptModel: (id) => ensurePromptUsesVisibleModel(runtime, id),
  });
}

export const Route = createFileRoute("/api/agent/$id")({
  server: {
    handlers: {
      GET: ({ request, params }) => agentHandlers().getSession(request, params.id),
      POST: ({ request, params }) => agentHandlers().postSession(request, params.id),
    },
  },
});
