import { readModelsConfig } from "./models-config-store.ts";
import { normalizeProviderBaseUrl } from "./model-discovery.ts";

export interface ModelDiscoveryAuth {
  apiKey?: string;
  headers: Record<string, string>;
}

export class ModelDiscoveryAuthProvenanceError extends Error {
  override name = "ModelDiscoveryAuthProvenanceError";
}

const ENV_REF = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;
const ENV_BRACE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function envName(value: unknown): string | undefined {
  const cleaned = cleanString(value);
  if (!cleaned) return undefined;
  return (ENV_BRACE.exec(cleaned) ?? ENV_REF.exec(cleaned))?.[1];
}

function resolveStoredValue(value: unknown): string | undefined {
  const cleaned = cleanString(value);
  if (!cleaned) return undefined;
  const name = envName(cleaned);
  if (!name) return cleaned;
  const env = process.env[name];
  return env?.trim() ? env : undefined;
}

function resolveRequestValue(
  value: unknown,
  storedValue: unknown,
  field: string,
  allowStored: boolean,
): string | undefined {
  const cleaned = cleanString(value);
  if (!cleaned) return allowStored ? resolveStoredValue(storedValue) : undefined;
  if (!envName(cleaned)) return cleaned;
  if (!allowStored || cleaned !== cleanString(storedValue)) {
    throw new ModelDiscoveryAuthProvenanceError(
      `Environment references in request ${field} must match stored provider configuration`,
    );
  }
  return resolveStoredValue(storedValue);
}

function resolveHeaders(storedValue: unknown, requestValue: unknown, allowStored: boolean): Record<string, string> {
  const headers = new Map<string, [string, string]>();
  const stored = isRecord(storedValue) ? storedValue : {};
  for (const [name, raw] of allowStored ? Object.entries(stored) : []) {
    const resolved = resolveStoredValue(raw);
    if (resolved !== undefined) headers.set(name.toLowerCase(), [name, resolved]);
  }
  if (!isRecord(requestValue)) return Object.fromEntries(headers.values());
  for (const [name, raw] of Object.entries(requestValue)) {
    const storedEntry = Object.entries(stored).find(([storedName]) => storedName.toLowerCase() === name.toLowerCase());
    const resolved = resolveRequestValue(raw, storedEntry?.[1], `header "${name}"`, allowStored);
    if (resolved !== undefined) headers.set(name.toLowerCase(), [name, resolved]);
  }
  return Object.fromEntries(headers.values());
}

function storedProvider(providerName: string): Record<string, unknown> {
  const stored = readModelsConfig();
  const providers = isRecord(stored.providers) ? stored.providers : {};
  return isRecord(providers[providerName]) ? providers[providerName] : {};
}

function storedModel(provider: Record<string, unknown>, modelId: string | undefined): Record<string, unknown> {
  if (!modelId || !Array.isArray(provider.models)) return {};
  const model = provider.models.find((model) => (
    isRecord(model) && cleanString(model.id) === modelId
  ));
  return isRecord(model) ? model : {};
}

function providerEndpoint(provider: Record<string, unknown>): string | undefined {
  const api = cleanString(provider.api) ?? "openai-completions";
  const baseUrl = normalizeProviderBaseUrl(provider.baseUrl, api);
  try {
    const url = new URL(baseUrl);
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return `${api}\n${url.toString()}`;
  } catch {
    return undefined;
  }
}

export async function resolveModelDiscoveryAuth(
  providerName: string,
  provider: Record<string, unknown>,
  modelId?: string,
): Promise<ModelDiscoveryAuth> {
  const stored = storedProvider(providerName);
  const model = storedModel(stored, modelId);
  const storedHeaders = {
    ...(isRecord(stored.headers) ? stored.headers : {}),
    ...(isRecord(model.headers) ? model.headers : {}),
  };
  const effectiveStored = {
    ...stored,
    api: cleanString(model.api) ?? stored.api,
  };
  const allowStored = providerEndpoint(provider) !== undefined
    && providerEndpoint(provider) === providerEndpoint(effectiveStored);
  const apiKey = resolveRequestValue(provider.apiKey, stored.apiKey, "API key", allowStored);
  const headers = resolveHeaders(storedHeaders, provider.headers, allowStored);
  return apiKey ? { apiKey, headers } : { headers };
}
