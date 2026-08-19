import { getAgentRuntime } from "@/lib/acp/runtime.ts";
import { readGrokAuth } from "@/lib/grok-settings/home-config.ts";

export async function GET() {
  const grok = {
    id: "grok.com",
    name: "Grok",
    usesCallbackServer: false,
    loggedIn: false,
    supportsApiKey: true,
  };
  try {
    grok.loggedIn = (await getAgentRuntime().authCheck()).authenticated === true;
  } catch {
    grok.loggedIn = readGrokAuth().loggedIn;
  }
  return Response.json({ providers: [grok] });
}
