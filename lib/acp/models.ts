import type { ModelsData } from "../models-cache.ts";

type AcpModel = {
  modelId: string;
  name?: string;
  _meta?: unknown;
};

type AcpModelsList = {
  currentModelId: string;
  availableModels: AcpModel[];
};

export function mapGrokModels(listed: AcpModelsList): ModelsData {
  const models: Record<string, string> = {};
  const modelList: ModelsData["modelList"] = [];
  const thinkingLevels: Record<string, string[]> = {};

  for (const model of listed.availableModels) {
    const key = `grok:${model.modelId}`;
    const name = model.name ?? model.modelId;
    models[key] = name;
    modelList.push({ id: model.modelId, name, provider: "grok" });
    thinkingLevels[key] = reasoningEffortIds(model._meta);
  }

  return {
    models,
    modelList,
    defaultModel: listed.currentModelId
      ? { provider: "grok", modelId: listed.currentModelId }
      : null,
    thinkingLevels,
    thinkingLevelMaps: {},
    thinkingLevelPins: {},
  };
}

function reasoningEffortIds(meta: unknown): string[] {
  if (!isRecord(meta) || !Array.isArray(meta.reasoningEfforts)) return [];
  const ids: string[] = [];
  for (const effort of meta.reasoningEfforts) {
    if (isRecord(effort) && typeof effort.id === "string") ids.push(effort.id);
  }
  return ids;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
