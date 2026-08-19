import { getAgentRuntime } from "@/lib/acp/runtime.ts";
import { hasGrokApiKey, readGrokAuth } from "@/lib/grok-settings/home-config.ts";

export async function GET() {
  const grok = {
    id: "grok.com",
    name: "Grok",
    usesCallbackServer: false,
    loggedIn: hasGrokApiKey() || readGrokAuth().loggedIn,
    supportsApiKey: true,
  };
  try {
    if ((await getAgentRuntime().authCheck()).authenticated === true) grok.loggedIn = true;
  } catch {
    // disk login state already applied
  }
  return Response.json({ providers: [grok] });
}
