import { getAgentRuntime } from "@/lib/acp/runtime.ts";
import { grokAccountConnected } from "@/lib/grok-settings/home-config.ts";

export async function resolveOfficialGrokConnected(): Promise<boolean> {
  if (grokAccountConnected()) return true;
  try {
    return (await getAgentRuntime().authCheck()).authenticated === true;
  } catch {
    return false;
  }
}

export async function GET() {
  const grok = {
    id: "grok.com",
    name: "Grok",
    usesCallbackServer: false,
    loggedIn: await resolveOfficialGrokConnected(),
    supportsApiKey: true,
  };
  return Response.json({ providers: [grok] });
}
