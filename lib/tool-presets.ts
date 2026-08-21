export interface ToolEntry {
  name: string;
  description: string;
  active: boolean;
}

export const TOOL_PRESET_VALUES = ["none", "read-only", "default", "full"] as const;
export type ToolPreset = typeof TOOL_PRESET_VALUES[number];

export function isToolPreset(value: unknown): value is ToolPreset {
  return typeof value === "string" && (TOOL_PRESET_VALUES as readonly string[]).includes(value);
}

export function getPresetFromTools(tools: ToolEntry[]): ToolPreset {
  const activeTools = tools.filter((t) => t.active);
  if (activeTools.length === 0) return "none";
  for (const tool of activeTools) {
    if (isToolPreset(tool.name)) return tool.name;
  }
  return "default";
}

export function getToolNamesForPreset(preset: ToolPreset): string[] {
  return preset === "none" ? [] : [preset];
}
