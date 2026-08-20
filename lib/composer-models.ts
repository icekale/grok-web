import type { ModelsData } from "./models-cache.ts";
import { composerDisplayId, composerModelLabel } from "./grok-model-label.ts";

export { composerDisplayId, composerModelLabel } from "./grok-model-label.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type SettingsComposerModel = {
  providerId: string;
  id: string;
  name: string;
  api?: string;
  baseUrl?: string;
  apiKey?: string;
  contextWindow?: number;
};

export function collectSettingsComposerModels(settings: Record<string, unknown>): SettingsComposerModel[] {
  const rows: SettingsComposerModel[] = [];
  const providers = isRecord(settings.providers) ? settings.providers : {};
  for (const [providerId, provider] of Object.entries(providers)) {
    if (!isRecord(provider) || !Array.isArray(provider.models)) continue;
    for (const model of provider.models) {
      if (!isRecord(model) || typeof model.id !== "string") continue;
      const id = model.id.trim();
      if (!id) continue;
      rows.push({
        providerId,
        id,
        name: composerModelLabel(id, typeof model.name === "string" ? model.name : undefined),
        api: typeof provider.api === "string" ? provider.api : undefined,
        baseUrl: typeof provider.baseUrl === "string" ? provider.baseUrl : undefined,
        apiKey: typeof provider.apiKey === "string" ? provider.apiKey : undefined,
        contextWindow: typeof model.contextWindow === "number" ? model.contextWindow : undefined,
      });
    }
  }
  return rows;
}

export function defaultSettingsPickerId(row: SettingsComposerModel): string {
  return `${row.providerId}/${row.id}`;
}

export {
  GROK_EFFORT_LEVELS,
  defaultGrokEffortLevel,
  visibleGrokEffortLevels,
} from "./grok-effort-levels.ts";

export function mergeComposerModels(
  acp: ModelsData,
  settings: Record<string, unknown>,
  pickerId: (row: SettingsComposerModel) => string = defaultSettingsPickerId,
): ModelsData {
  const resolved = collectSettingsComposerModels(settings).map((row) => ({
    id: pickerId(row),
    name: row.name,
    provider: row.providerId,
  }));
  const overlay = new Map(resolved.map((row) => [row.id, row]));
  const modelList: ModelsData["modelList"] = [];
  const seen = new Set<string>();

  for (const model of acp.modelList) {
    const extra = overlay.get(model.id);
    const entry = extra
      ? { id: model.id, name: extra.name, provider: extra.provider }
      : { ...model, name: composerModelLabel(composerDisplayId(model.id), model.name) };
    modelList.push(entry);
    seen.add(entry.id);
  }
  for (const extra of resolved) {
    if (seen.has(extra.id)) continue;
    modelList.push(extra);
    seen.add(extra.id);
  }

  const models: Record<string, string> = {};
  for (const model of modelList) models[`${model.provider}:${model.id}`] = model.name;
  if (modelList.length === 0) {
    for (const [key, name] of Object.entries(acp.models)) {
      const id = key.includes(":") ? key.slice(key.indexOf(":") + 1) : key;
      models[key] = composerModelLabel(id, name);
    }
  }

  const thinkingLevels = { ...acp.thinkingLevels };
  const thinkingLevelMaps = { ...acp.thinkingLevelMaps };
  const thinkingLevelPins = { ...acp.thinkingLevelPins };
  for (const model of modelList) {
    assignThinkingAlias(
      acp,
      { thinkingLevels, thinkingLevelMaps, thinkingLevelPins },
      `${model.provider}:${model.id}`,
      `${model.provider}/${model.id}`,
      model.id,
    );
  }

  const defaultOverlay = acp.defaultModel ? overlay.get(acp.defaultModel.modelId) : undefined;
  return {
    ...acp,
    models: Object.keys(models).length > 0 ? models : acp.models,
    modelList,
    thinkingLevels,
    thinkingLevelMaps,
    thinkingLevelPins,
    defaultModel: defaultOverlay && acp.defaultModel
      ? { provider: defaultOverlay.provider, modelId: acp.defaultModel.modelId }
      : acp.defaultModel,
  };
}

function assignThinkingAlias(
  acp: ModelsData,
  target: {
    thinkingLevels: Record<string, string[]>;
    thinkingLevelMaps: Record<string, Record<string, string | null>>;
    thinkingLevelPins: Record<string, string>;
  },
  key: string,
  pinKey: string,
  modelId: string,
): void {
  if (!target.thinkingLevels[key]?.length) {
    const sourceKey = findThinkingSourceKey(acp.thinkingLevels, modelId);
    if (sourceKey) {
      target.thinkingLevels[key] = acp.thinkingLevels[sourceKey];
      if (acp.thinkingLevelMaps[sourceKey]) target.thinkingLevelMaps[key] = acp.thinkingLevelMaps[sourceKey];
    }
  }
  if (!target.thinkingLevelPins[pinKey]) {
    const displayId = composerDisplayId(modelId);
    const sourcePin = acp.thinkingLevelPins[`grok/${modelId}`]
      ?? acp.thinkingLevelPins[`grok/${displayId}`]
      ?? acp.thinkingLevelPins[pinKey];
    if (sourcePin) target.thinkingLevelPins[pinKey] = sourcePin;
  }
}

function findThinkingSourceKey(thinkingLevels: Record<string, string[]>, modelId: string): string | undefined {
  if (thinkingLevels[modelId]?.length) return modelId;
  const displayId = composerDisplayId(modelId);
  const exact = `grok:${modelId}`;
  if (thinkingLevels[exact]?.length) return exact;
  const display = `grok:${displayId}`;
  if (thinkingLevels[display]?.length) return display;
  return Object.keys(thinkingLevels).find((key) => key.endsWith(`:${displayId}`) && thinkingLevels[key].length);
}
