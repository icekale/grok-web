import { getAgentRuntime } from "@/lib/acp/runtime.ts";
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
  await getAgentRuntime().authLogout();
  invalidateModelsCache();
  return Response.json({ ok: true });
}
