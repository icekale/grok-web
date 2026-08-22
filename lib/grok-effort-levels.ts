export const GROK_EFFORT_LEVELS = ["low", "medium", "high", "xhigh"] as const;
const ADVERTISED_EFFORT_LEVELS = new Set(["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);

const GROK_EFFORT_RANK: Record<string, number> = {
  none: 0,
  off: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
};

export function visibleGrokEffortLevels(available?: string[] | null): string[] {
  const levels = (available ?? []).filter((level) => ADVERTISED_EFFORT_LEVELS.has(level));
  return [...new Set(levels)].sort((left, right) => (GROK_EFFORT_RANK[left] ?? 50) - (GROK_EFFORT_RANK[right] ?? 50));
}

export function defaultGrokEffortLevel(levels: string[]): string {
  if (levels.includes("xhigh")) return "xhigh";
  if (levels.includes("high")) return "high";
  return levels[levels.length - 1] ?? "high";
}
