import { composerDisplayId } from "./grok-model-label.ts";

export const GROK_EFFORT_LEVELS = ["low", "medium", "high", "xhigh"] as const;
const ADVERTISED_EFFORT_LEVELS = new Set(["none", "auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const GROK_46_EFFORT_LEVELS = ["low", "medium", "high", "xhigh"] as const;
const GROK_45_EFFORT_LEVELS = ["low", "medium", "high"] as const;

export type GrokEffortFamily = "grok-4.6" | "grok-4.5" | "none";

const GROK_EFFORT_RANK: Record<string, number> = {
  none: 0,
  off: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
  auto: 50,
};

export function grokEffortFamily(modelId?: string | null): GrokEffortFamily {
  if (!modelId) return "none";
  const displayId = composerDisplayId(modelId).toLowerCase();
  if (displayId.includes("imagine") || displayId.includes("composer")) return "none";
  if (displayId.includes("grok-4.6")) return "grok-4.6";
  if (displayId.includes("grok-4.5")) return "grok-4.5";
  return "none";
}

export function visibleGrokEffortLevels(available?: string[] | null, modelId?: string | null): string[] {
  const advertised = (available ?? []).filter((level) => ADVERTISED_EFFORT_LEVELS.has(level));
  const levels = [...new Set([...advertised, ...officialEffortFloor(modelId)])];
  return levels.sort((left, right) => (GROK_EFFORT_RANK[left] ?? 50) - (GROK_EFFORT_RANK[right] ?? 50));
}

export function thinkingLevelsForComposerModel(
  levels: Record<string, string[]>,
  provider?: string | null,
  modelId?: string | null,
): string[] | null {
  if (!modelId) return null;
  const exact = provider ? levels[`${provider}:${modelId}`] : undefined;
  if (exact?.length) return exact;
  const grokKey = levels[`grok:${modelId}`];
  if (grokKey?.length) return grokKey;
  const match = Object.entries(levels).find(([key, value]) => key.endsWith(`:${modelId}`) && value.length > 0);
  return match?.[1] ?? null;
}

export function defaultGrokEffortLevel(levels: string[], modelId?: string | null): string {
  const familyDefault = familyDefaultEffort(modelId);
  if (familyDefault && levels.includes(familyDefault)) return familyDefault;
  if (levels.includes("high")) return "high";
  if (levels.includes("xhigh")) return "xhigh";
  return levels[levels.length - 1] ?? "high";
}

export function familyDefaultEffort(modelId?: string | null): string | undefined {
  const family = grokEffortFamily(modelId);
  if (family === "none") return undefined;
  if (family === "grok-4.6" && modelId?.includes("/")) return "xhigh";
  return "high";
}

function isConcreteEffort(level: string | null | undefined): level is string {
  return typeof level === "string" && ADVERTISED_EFFORT_LEVELS.has(level) && level !== "auto";
}

export function shouldRespawnForEffort(spawned?: string | null, next?: string | null): boolean {
  return (spawned ?? "") !== (next ?? "");
}

export function persistedReasoningEffort(summary: unknown): string | undefined {
  if (!summary || typeof summary !== "object") return undefined;
  const effort = (summary as { reasoning_effort?: unknown }).reasoning_effort;
  return isConcreteEffort(typeof effort === "string" ? effort : undefined) ? effort : undefined;
}

export function resolvedGrokEffort(input: {
  persisted?: string | null;
  selected?: string | null;
  modelId?: string | null;
} = {}): string | undefined {
  const family = grokEffortFamily(input.modelId);
  if (family === "none" && input.modelId) return undefined;
  if (isLegalEffortForModel(input.persisted, input.modelId)) return input.persisted;
  if (isLegalEffortForModel(input.selected, input.modelId)) return input.selected;
  if (!input.modelId) return "high";
  return familyDefaultEffort(input.modelId);
}

function isLegalEffortForModel(level: string | null | undefined, modelId?: string | null): level is string {
  if (!isConcreteEffort(level)) return false;
  const family = grokEffortFamily(modelId);
  if (family === "none" && modelId) return false;
  if (level === "xhigh" && family === "grok-4.5") return false;
  if (family === "grok-4.6" || family === "grok-4.5" || !modelId) return true;
  return false;
}

function officialEffortFloor(modelId?: string | null): readonly string[] {
  const family = grokEffortFamily(modelId);
  if (family === "grok-4.6") return GROK_46_EFFORT_LEVELS;
  if (family === "grok-4.5") return GROK_45_EFFORT_LEVELS;
  return [];
}
