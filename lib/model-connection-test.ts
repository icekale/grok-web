import { resolveModelDiscoveryAuth } from "./model-discovery-auth.ts";
import { normalizeProviderBaseUrl, safeDiscoveryFetch } from "./model-discovery.ts";
import type { DiscoveryLookup } from "./model-discovery.ts";

const PROMPT = "Reply with OK only.";
const TIMEOUT_MS = 20_000;

export type ModelTestResult = {
  ok: boolean;
  error?: string;
  latencyMs?: number;
  status?: number;
  responseText?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasHeader(headers: Headers, name: string): boolean {
  return headers.has(name);
}

function buildAuthHeaders(api: string, apiKey: string | undefined, configured: Record<string, string>): Headers {
  const headers = new Headers(configured);
  if (!hasHeader(headers, "accept")) headers.set("Accept", "application/json");
  if (!hasHeader(headers, "content-type")) headers.set("Content-Type", "application/json");
  if (!apiKey) return headers;
  if (api === "anthropic-messages") {
    if (!hasHeader(headers, "x-api-key")) headers.set("x-api-key", apiKey);
    if (!hasHeader(headers, "anthropic-version")) headers.set("anthropic-version", "2023-06-01");
  } else if (api === "google-generative-ai") {
    if (!hasHeader(headers, "x-goog-api-key")) headers.set("x-goog-api-key", apiKey);
  } else if (!hasHeader(headers, "authorization")) {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }
  return headers;
}

function joinPath(basePath: string, suffix: string): string {
  const trimmed = basePath.replace(/\/+$/, "");
  if (trimmed.endsWith(suffix)) return trimmed;
  return `${trimmed}${suffix}`;
}

export function buildModelTestRequest(input: {
  api: string;
  baseUrl: string;
  modelId: string;
  apiKey?: string;
  headers: Record<string, string>;
}): { url: string; body: string; headers: Headers } {
  const api = input.api || "openai-completions";
  const url = new URL(normalizeProviderBaseUrl(input.baseUrl, api));
  const path = url.pathname.replace(/\/+$/, "") || "";

  if (api === "anthropic-messages") {
    url.pathname = /\/messages$/i.test(path) ? path : joinPath(/\/v\d+(?:beta)?$/i.test(path) ? path : `${path}/v1`, "/messages");
  } else if (api === "google-generative-ai") {
    const root = /\/v\d+(?:beta)?$/i.test(path) ? path : `${path}/v1beta`;
    url.pathname = `${root}/models/${encodeURIComponent(input.modelId)}:generateContent`;
  } else if (api === "openai-responses" || api === "openai-codex-responses") {
    url.pathname = joinPath(path, "/responses");
  } else {
    url.pathname = joinPath(path, "/chat/completions");
  }

  let payload: Record<string, unknown>;
  if (api === "openai-responses" || api === "openai-codex-responses") {
    payload = { model: input.modelId, input: PROMPT, max_output_tokens: 16 };
  } else if (api === "anthropic-messages") {
    payload = { model: input.modelId, max_tokens: 16, messages: [{ role: "user", content: PROMPT }] };
  } else if (api === "google-generative-ai") {
    payload = {
      contents: [{ role: "user", parts: [{ text: PROMPT }] }],
      generationConfig: { maxOutputTokens: 16 },
    };
  } else {
    payload = { model: input.modelId, messages: [{ role: "user", content: PROMPT }], max_tokens: 16 };
  }

  return {
    url: url.toString(),
    body: JSON.stringify(payload),
    headers: buildAuthHeaders(api, input.apiKey, input.headers),
  };
}

export function extractModelTestText(api: string, payload: unknown): string {
  if (!isRecord(payload)) return "";
  if (api === "openai-responses" || api === "openai-codex-responses") {
    if (typeof payload.output_text === "string") return payload.output_text.trim();
    if (Array.isArray(payload.output)) {
      const parts: string[] = [];
      for (const item of payload.output) {
        if (!isRecord(item) || !Array.isArray(item.content)) continue;
        for (const block of item.content) {
          if (isRecord(block) && typeof block.text === "string") parts.push(block.text);
        }
      }
      return parts.join("").trim();
    }
  }
  if (api === "anthropic-messages" && Array.isArray(payload.content)) {
    return payload.content
      .filter(isRecord)
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("")
      .trim();
  }
  if (api === "google-generative-ai" && Array.isArray(payload.candidates) && isRecord(payload.candidates[0])) {
    const content = payload.candidates[0].content;
    if (isRecord(content) && Array.isArray(content.parts)) {
      return content.parts
        .filter(isRecord)
        .map((part) => typeof part.text === "string" ? part.text : "")
        .join("")
        .trim();
    }
  }
  if (Array.isArray(payload.choices) && isRecord(payload.choices[0])) {
    const choice = payload.choices[0];
    if (isRecord(choice.message) && typeof choice.message.content === "string") {
      return choice.message.content.trim();
    }
    if (typeof choice.text === "string") return choice.text.trim();
  }
  return "";
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

export async function testModelConnection(input: {
  providerName: string;
  provider: Record<string, unknown>;
  model: Record<string, unknown>;
  fetchImpl?: typeof fetch;
  lookup?: DiscoveryLookup;
}): Promise<ModelTestResult> {
  const modelId = typeof input.model.id === "string" ? input.model.id.trim() : "";
  if (!modelId) return { ok: false, error: "Model ID is required" };

  const api = typeof input.model.api === "string" && input.model.api.trim()
    ? input.model.api.trim()
    : (typeof input.provider.api === "string" && input.provider.api.trim()
      ? input.provider.api.trim()
      : "openai-completions");
  const baseUrl = typeof input.provider.baseUrl === "string" ? input.provider.baseUrl.trim() : "";
  if (!baseUrl) return { ok: false, error: "Base URL is required" };

  const auth = await resolveModelDiscoveryAuth(input.providerName, {
    ...input.provider,
    api,
    headers: { ...stringRecord(input.provider.headers), ...stringRecord(input.model.headers) },
  }, modelId);
  if (!auth.apiKey && Object.keys(auth.headers).length === 0) {
    return { ok: false, error: `No API key found for "${input.providerName}"` };
  }

  const normalized = normalizeProviderBaseUrl(baseUrl, api);
  const request = buildModelTestRequest({
    api,
    baseUrl: normalized,
    modelId,
    apiKey: auth.apiKey,
    headers: auth.headers,
  });
  const startedAt = Date.now();
  let status: number | undefined;
  try {
    const response = await safeDiscoveryFetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }, {
      fetchImpl: input.fetchImpl,
      lookup: input.lookup,
    });
    status = response.status;
    const latencyMs = Date.now() - startedAt;
    const text = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        error: text.slice(0, 500) || `Upstream returned HTTP ${response.status}`,
        latencyMs,
        status,
      };
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return { ok: false, error: "Upstream response was not valid JSON", latencyMs, status };
    }
    return {
      ok: true,
      latencyMs,
      status,
      responseText: extractModelTestText(api, payload).slice(0, 300),
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return { ok: false, error: "Test timed out", latencyMs, status };
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error), latencyMs, status };
  }
}
