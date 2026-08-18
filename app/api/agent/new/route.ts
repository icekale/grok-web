import { createAgentHandlers } from "@/lib/acp/http";
import { getAgentRuntime } from "@/lib/acp/runtime";

// POST /api/agent/new  body: { cwd: string; type: string; message?: string; ... }
export async function POST(req: Request) {
  return createAgentHandlers(getAgentRuntime()).postNew(req);
}
