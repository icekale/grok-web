import type { ModelsData } from "../models-cache.ts";
import { composerModelLabel, composerProvider } from "../grok-model-label.ts";

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
  const thinkingLevelMaps: Record<string, Record<string, string | null>> = {};
  const thinkingLevelPins: Record<string, string> = {};

  for (const model of listed.availableModels) {
    const provider = composerProvider(model.modelId);
    const key = `${provider}:${model.modelId}`;
    const name = composerModelLabel(model.modelId, model.name);
    models[key] = name;
    modelList.push({ id: model.modelId, name, provider });
    const efforts = reasoningEfforts(model._meta);
    thinkingLevels[key] = efforts.map((effort) => effort.id);
    const labels: Record<string, string | null> = {};
    for (const effort of efforts) {
      if (effort.label) labels[effort.id] = effort.label;
    }
    if (Object.keys(labels).length > 0) thinkingLevelMaps[key] = labels;
    const pin = currentReasoningEffort(model._meta, efforts);
    if (pin) thinkingLevelPins[`${provider}/${model.modelId}`] = pin;
  }

  return {
    models,
    modelList,
    defaultModel: listed.currentModelId
      ? { provider: composerProvider(listed.currentModelId), modelId: listed.currentModelId }
      : null,
    thinkingLevels,
    thinkingLevelMaps,
    thinkingLevelPins,
  };
}

const SELECTED_EFFORT_IDS = new Set(["none", "auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function selectedGrokEffort(result: unknown): string | undefined {
  if (!isRecord(result) || !isRecord(result._meta)) return undefined;
  const config = result._meta["x.ai/sessionConfig"];
  if (!isRecord(config) || !Array.isArray(config.options)) return undefined;
  for (const option of config.options) {
    if (
      isRecord(option)
      && option.category === "mode"
      && option.selected === true
      && typeof option.id === "string"
      && SELECTED_EFFORT_IDS.has(option.id)
    ) {
      return option.id;
    }
  }
  return undefined;
}

export function selectedGrokModelId(result: unknown): string | undefined {
  if (!isRecord(result) || !isRecord(result._meta)) return undefined;
  const detail = result._meta["x.ai/sessionDetail"];
  if (isRecord(detail) && typeof detail.currentModelId === "string" && detail.currentModelId) {
    return detail.currentModelId;
  }
  return undefined;
}

function reasoningEfforts(meta: unknown): Array<{ id: string; label?: string; default?: boolean }> {
  if (!isRecord(meta) || !Array.isArray(meta.reasoningEfforts)) return [];
  const efforts: Array<{ id: string; label?: string; default?: boolean }> = [];
  for (const effort of meta.reasoningEfforts) {
    if (!isRecord(effort) || typeof effort.id !== "string" || !effort.id) continue;
    efforts.push({
      id: effort.id,
      label: typeof effort.label === "string" ? effort.label : undefined,
      default: effort.default === true,
    });
  }
  return efforts;
}

function currentReasoningEffort(
  meta: unknown,
  efforts: Array<{ id: string; default?: boolean }>,
): string | undefined {
  if (isRecord(meta) && typeof meta.reasoningEffort === "string" && meta.reasoningEffort) {
    return meta.reasoningEffort;
  }
  return efforts.find((effort) => effort.default)?.id ?? efforts[0]?.id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
