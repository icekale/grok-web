import { getAgentRuntime } from "@/lib/acp/runtime.ts";
import { clearGrokApiKey, clearGrokAuth } from "@/lib/grok-settings/home-config.ts";
import { invalidateModelsCache } from "@/lib/models-cache";

const SUPPORTED = new Set(["grok.com", "xai.api_key"]);

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider } = await params;
  if (!SUPPORTED.has(provider)) {
    return Response.json({ error: `Unknown provider: ${provider}` }, { status: 400 });
  }
  clearGrokApiKey();
  try {
    await getAgentRuntime().authLogout();
  } catch {
    // ACP could not clear OAuth tokens; wipe auth.json so disconnect still holds.
    clearGrokAuth();
  }
  invalidateModelsCache();
  return Response.json({ ok: true });
}
