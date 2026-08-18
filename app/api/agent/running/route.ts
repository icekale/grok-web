import { createAgentHandlers } from "@/lib/acp/http";
import { getAgentRuntime } from "@/lib/acp/runtime";

// GET /api/agent/running - Lightweight snapshot for visible-tab polling.
export async function GET() {
  return createAgentHandlers(getAgentRuntime()).getRunning();
}
