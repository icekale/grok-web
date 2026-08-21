import { isToolPreset, TOOL_PRESET_VALUES, type ToolEntry, type ToolPreset } from "../tool-presets.ts";

export type AcpConfigOption = {
  id: string;
  name?: string;
  category?: string;
  type?: string;
  currentValue?: string | boolean;
  selected?: boolean;
  options?: Array<{ value?: string; id?: string; name?: string }>;
};

export function readAcpConfigOptions(value: unknown): AcpConfigOption[] {
  const options: AcpConfigOption[] = [];
  const seen = new Set<string>();
  const add = (item: unknown) => {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id) return;
    const key = `${item.category ?? ""}:${item.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    const option: AcpConfigOption = { id: item.id };
    if (typeof item.name === "string") option.name = item.name;
    if (typeof item.category === "string") option.category = item.category;
    if (typeof item.type === "string") option.type = item.type;
    if (typeof item.currentValue === "string" || typeof item.currentValue === "boolean") {
      option.currentValue = item.currentValue;
    }
    if (item.selected === true) option.selected = true;
    if (Array.isArray(item.options)) {
      option.options = item.options.filter((entry): entry is { value?: string; id?: string; name?: string } => (
        isRecord(entry)
      ));
    }
    options.push(option);
  };
  if (isRecord(value) && Array.isArray(value.configOptions)) {
    for (const item of value.configOptions) add(item);
  }
  const meta = isRecord(value) && isRecord(value._meta) ? value._meta : {};
  const config = isRecord(meta["x.ai/sessionConfig"]) ? meta["x.ai/sessionConfig"] : {};
  if (Array.isArray(config.options)) {
    for (const item of config.options) add(item);
  }
  return options;
}

export function applyConfigOptionUpdate(options: AcpConfigOption[], update: unknown): AcpConfigOption[] {
  if (!isRecord(update) || typeof update.sessionUpdate !== "string") return options;
  const kind = update.sessionUpdate;
  if (kind !== "config_option_update" && kind !== "session_config_option_update") return options;
  if (Array.isArray(update.configOptions)) {
    return readAcpConfigOptions({ configOptions: update.configOptions });
  }
  const id = stringField(update.configId) || stringField(update.id);
  if (!id) return options;
  const value = update.value ?? update.currentValue;
  return options.map((option) => {
    if (option.id === id) {
      return typeof value === "string" || typeof value === "boolean"
        ? { ...option, currentValue: value }
        : option;
    }
    if (option.category === "tools") {
      return { ...option, selected: option.id === id };
    }
    return option;
  });
}

export function hasToolsConfig(options: AcpConfigOption[]): boolean {
  return options.some(isToolsOption);
}

/** ACP-declared `none|read-only|default|full` ids only. Empty means no Shield chip. */
export function advertisedToolPresets(options: AcpConfigOption[]): ToolPreset[] {
  const found = new Set<ToolPreset>();
  for (const option of options) {
    if (option.category === "tools" && isToolPreset(option.id)) found.add(option.id);
    if (!isToolsSelect(option)) continue;
    for (const entry of option.options ?? []) {
      const value = entry.value ?? entry.id;
      if (isToolPreset(value)) found.add(value);
    }
  }
  return TOOL_PRESET_VALUES.filter((preset) => found.has(preset));
}

export function selectedToolsPreset(options: AcpConfigOption[]): ToolPreset | undefined {
  const select = options.find((option) => option.id === "tools" || option.name?.toLowerCase() === "tools");
  if (select && isToolPreset(select.currentValue)) return select.currentValue;
  const selected = options.find((option) => option.category === "tools" && option.selected === true);
  if (selected && isToolPreset(selected.id)) return selected.id;
  if (options.some((option) => option.category === "tools")) return "default";
  return undefined;
}

export function rememberToolsPreset(options: AcpConfigOption[], preset: ToolPreset): AcpConfigOption[] {
  if (options.length === 0) return options;
  return options.map((option) => {
    if (option.id === "tools" || option.name?.toLowerCase() === "tools") {
      return { ...option, currentValue: preset };
    }
    if (option.category === "tools") {
      return { ...option, selected: option.id === preset };
    }
    return option;
  });
}

export function toolEntriesForPreset(preset: ToolPreset): ToolEntry[] {
  if (preset === "none") return [];
  return [{ name: preset, description: preset, active: true }];
}

function isToolsSelect(option: AcpConfigOption): boolean {
  return option.id === "tools" || option.name?.toLowerCase() === "tools";
}

function isToolsOption(option: AcpConfigOption): boolean {
  return isToolsSelect(option) || option.category === "tools";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}
