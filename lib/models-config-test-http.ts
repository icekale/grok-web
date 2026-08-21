import { testModelConnection } from "@/lib/model-connection-test";
import { ModelDiscoveryAuthProvenanceError } from "@/lib/model-discovery-auth";
import { assertSafeDiscoveryTarget, normalizeProviderBaseUrl } from "@/lib/model-discovery";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return Response.json({ ok: false, error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return Response.json(
      { ok: false, error: "Content-Type must be application/json" },
      { status: 415 },
    );
  }

  try {
    const body = await req.json() as { providerName?: unknown; provider?: unknown; model?: unknown };
    const providerName = typeof body.providerName === "string" ? body.providerName.trim() : "";
    if (!providerName) return Response.json({ ok: false, error: "providerName is required" }, { status: 400 });
    if (!isRecord(body.provider)) return Response.json({ ok: false, error: "provider is required" }, { status: 400 });
    if (!isRecord(body.model)) return Response.json({ ok: false, error: "model is required" }, { status: 400 });

    const modelId = typeof body.model.id === "string" ? body.model.id.trim() : "";
    if (!modelId) return Response.json({ ok: false, error: "Model ID is required" }, { status: 400 });
    const baseUrl = typeof body.provider.baseUrl === "string" ? body.provider.baseUrl.trim() : "";
    if (!baseUrl) return Response.json({ ok: false, error: "Base URL is required" }, { status: 400 });
    const api = typeof body.model.api === "string" && body.model.api.trim()
      ? body.model.api.trim()
      : (typeof body.provider.api === "string" && body.provider.api.trim()
        ? body.provider.api.trim()
        : "openai-completions");
    try {
      assertSafeDiscoveryTarget(new URL(normalizeProviderBaseUrl(baseUrl, api)));
    } catch {
      return Response.json({
        ok: false,
        error: "Base URL is invalid or targets a link-local or special-use address",
      }, { status: 400 });
    }

    const result = await testModelConnection({
      providerName,
      provider: body.provider,
      model: body.model,
    });
    return Response.json(result);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof ModelDiscoveryAuthProvenanceError) {
      return Response.json({
        ok: false,
        error: error instanceof SyntaxError ? "Request body was not valid JSON" : errorMessage(error),
      }, { status: 400 });
    }
    return Response.json({ ok: false, error: errorMessage(error) }, { status: 500 });
  }
}
