import { getAgentRuntime } from "@/lib/acp/runtime.ts";
import { clearGrokApiKey, hasGrokApiKey, writeGrokApiKey } from "@/lib/grok-settings/home-config.ts";
import { invalidateModelsCache } from "@/lib/models-cache";

type Params = { params: Promise<{ provider: string }> };

const API_KEY_PROVIDER = "xai.api_key";

function unknownProvider(provider: string) {
  return Response.json({ error: `Unknown provider: ${provider}` }, { status: 400 });
}

export async function GET(_req: Request, { params }: Params) {
  const { provider } = await params;
  if (provider !== API_KEY_PROVIDER) return unknownProvider(provider);
  const hasKey = hasGrokApiKey();
  let authenticated = false;
  try {
    authenticated = (await getAgentRuntime().authCheck()).authenticated === true;
  } catch {
    authenticated = false;
  }
  return Response.json({
    provider,
    displayName: "xAI API Key",
    configured: hasKey || authenticated,
    source: hasKey ? "api_key" : undefined,
    models: 0,
  });
}

export async function POST(req: Request, { params }: Params) {
  const { provider } = await params;
  if (provider !== API_KEY_PROVIDER) return unknownProvider(provider);
  try {
    const { apiKey } = await req.json() as { apiKey?: string };
    if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
      return Response.json({ error: "apiKey is required" }, { status: 400 });
    }
    writeGrokApiKey(apiKey.trim());
    try {
      await getAgentRuntime().authenticate(API_KEY_PROVIDER);
    } catch {
      // Persist the key even when ACP is unavailable.
    }
    invalidateModelsCache();
    return Response.json({ success: true });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  const { provider } = await params;
  if (provider !== API_KEY_PROVIDER) return unknownProvider(provider);
  try {
    clearGrokApiKey();
    try {
      await getAgentRuntime().authLogout();
    } catch {
      // Disk is already cleared if ACP logout fails.
    }
    invalidateModelsCache();
    return Response.json({ success: true });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
