export type AcpMode = { id: string; name: string; description?: string };
export type AcpModes = { current: string | null; available: AcpMode[] };
export type AcpModeSource = { type: "rpc" } | { type: "config"; configId: string };

const MODE_CONFIG_IDS = new Set(["mode", "permission_mode", "permissionMode", "permission-mode"]);
const MODE_IDS = new Set(["default", "ask", "plan", "auto", "bypassPermissions", "always-approve"]);

export function readAcpModeState(value: unknown): { modes: AcpModes; source: AcpModeSource | null } {
  const advertised = readAcpModes(value);
  if (advertised.available.length > 0) return { modes: advertised, source: { type: "rpc" } };
  const config = readAcpConfigModes(value);
  return config
    ? { modes: config.modes, source: { type: "config", configId: config.configId } }
    : { modes: advertised, source: null };
}

export function readAcpModes(value: unknown): AcpModes {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { current: null, available: [] };
  const record = value as { mode?: unknown; modes?: unknown };
  const modes = record.mode ?? record.modes;
  if (!modes || typeof modes !== "object" || Array.isArray(modes)) return { current: null, available: [] };
  return parseModeState(modes);
}

export function readAcpCurrentModeUpdate(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const update = value as { sessionUpdate?: unknown; currentModeId?: unknown };
  return update.sessionUpdate === "current_mode_update" && typeof update.currentModeId === "string" && update.currentModeId
    ? normalizeModeId(update.currentModeId)
    : null;
}

function readAcpConfigModes(value: unknown): { modes: AcpModes; configId: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const meta = isRecord(record._meta) ? record._meta : {};
  const sessionConfig = isRecord(meta["x.ai/sessionConfig"]) ? meta["x.ai/sessionConfig"] : {};
  const rawOptions = Array.isArray(record.configOptions)
    ? record.configOptions
    : Array.isArray(sessionConfig.options) ? sessionConfig.options : [];
  for (const raw of rawOptions) {
    if (!isRecord(raw)) continue;
    const id = typeof raw.id === "string" ? raw.id : "";
    const category = typeof raw.category === "string" ? raw.category.toLowerCase() : "";
    if (!MODE_CONFIG_IDS.has(id) && category !== "permission" && category !== "permissions" && category !== "mode") continue;
    const rawValues = Array.isArray(raw.options) ? raw.options : [];
    const available = rawValues.flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const rawId = typeof entry.value === "string" ? entry.value : typeof entry.id === "string" ? entry.id : "";
      const normalized = normalizeModeId(rawId);
      if (!normalized || !MODE_IDS.has(rawId) && !MODE_IDS.has(normalized)) return [];
      const name = typeof entry.name === "string" ? entry.name : typeof entry.label === "string" ? entry.label : displayModeName(normalized);
      return [{ id: normalized, name }];
    });
    const currentRaw = typeof raw.currentValue === "string"
      ? raw.currentValue
      : typeof raw.value === "string" ? raw.value
      : rawValues.find((entry) => isRecord(entry) && entry.selected === true)?.id;
    const current = typeof currentRaw === "string" ? normalizeModeId(currentRaw) : null;
    if (available.length > 0 && current && available.some((mode) => mode.id === current)) {
      return { modes: { current, available }, configId: id };
    }
  }
  return null;
}

function parseModeState(value: unknown): AcpModes {
  if (!isRecord(value)) return { current: null, available: [] };
  const currentRaw = typeof value.currentModeId === "string" ? value.currentModeId : null;
  const raw = value.availableModes;
  if (!Array.isArray(raw)) return { current: null, available: [] };
  const available = raw.filter((item): item is { id: string; name: string; description?: string } => (
    isRecord(item) && typeof item.id === "string" && typeof item.name === "string" && item.id.length > 0 && item.name.length > 0
  )).map((item) => ({
    id: item.id,
    name: item.name,
    ...(typeof item.description === "string" && item.description ? { description: item.description } : {}),
  }));
  const current = currentRaw && available.some((item) => item.id === currentRaw) ? currentRaw : null;
  return { current, available };
}

function normalizeModeId(value: string): string {
  return value === "ask" ? "default" : value === "always-approve" ? "bypassPermissions" : value;
}

function displayModeName(id: string): string {
  if (id === "default") return "Normal";
  if (id === "bypassPermissions") return "Always-approve";
  return id[0]?.toUpperCase() + id.slice(1) || id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
