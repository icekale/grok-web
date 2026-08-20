import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writePrivateFileAtomicSync } from "./atomic-file.ts";
import { grokHome } from "./grok-home.ts";
import { syncSettingsModelsToGrokConfig } from "./grok-model-table.ts";
import { invalidateModelsCache } from "./models-cache.ts";
import { normalizeProviderBaseUrl } from "./model-discovery.ts";

const MODEL_COST_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeModelCost(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const providedKeys = MODEL_COST_KEYS.filter((key) => value[key] !== undefined);
  if (providedKeys.length === 0) return undefined;
  if (providedKeys.some((key) => (
    typeof value[key] !== "number" || !Number.isFinite(value[key])
  ))) return undefined;

  return Object.fromEntries([
    ...Object.entries(value),
    ...MODEL_COST_KEYS.map((key) => [key, value[key] ?? 0]),
  ]);
}

/** Complete partial cost groups with zero; omit a cost group only when it is empty. */
export function normalizeModelsConfigCosts(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = structuredClone(data);
  if (!isRecord(normalized.providers)) return normalized;

  for (const provider of Object.values(normalized.providers)) {
    if (!isRecord(provider) || !Array.isArray(provider.models)) continue;
    for (const model of provider.models) {
      if (!isRecord(model) || !("cost" in model)) continue;
      const cost = normalizeModelCost(model.cost);
      if (cost) model.cost = cost;
      else delete model.cost;
    }
  }
  return normalized;
}

function sanitizeModelsConfig(data: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(data.providers)) return data;

  const providers = Object.fromEntries(Object.entries(data.providers).map(([providerId, provider]) => {
    if (!isRecord(provider)) return [providerId, provider];
    const normalizedBaseUrl = normalizeProviderBaseUrl(provider.baseUrl, provider.api);
    const normalized = normalizedBaseUrl ? { ...provider, baseUrl: normalizedBaseUrl } : provider;
    if (!Array.isArray(provider.models)) return [providerId, normalized];
    const models = provider.models.filter((model) => (
      !isRecord(model) || typeof model.id !== "string" || model.id.trim().length > 0
    ));
    return [providerId, { ...normalized, models }];
  }));

  return { ...data, providers };
}

export function getModelsConfigPath(): string {
  return join(grokHome(), "models.json");
}

export class ModelsConfigError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ModelsConfigError";
    this.status = status;
  }
}

export function readModelsConfig(
  modelsPath = getModelsConfigPath(),
): Record<string, unknown> {
  if (!existsSync(modelsPath)) return { providers: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(modelsPath, "utf8"));
  } catch {
    throw new ModelsConfigError("Models config is not valid JSON", 500);
  }
  if (!isRecord(parsed)) {
    throw new ModelsConfigError("Models config root must be an object", 500);
  }
  return parsed;
}

export function writeModelsConfig(
  data: Record<string, unknown>,
  modelsPath = getModelsConfigPath(),
): void {
  if (!isRecord(data)) {
    throw new ModelsConfigError("Models config root must be an object");
  }
  const dir = dirname(modelsPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const normalized = normalizeModelsConfigCosts(sanitizeModelsConfig(data));
  writePrivateFileAtomicSync(modelsPath, JSON.stringify(normalized, null, 2));
  if (modelsPath === getModelsConfigPath()) syncSettingsModelsToGrokConfig(normalized);
  invalidateModelsCache();
}
