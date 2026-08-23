export type AcpMode = { id: string; name: string };
export type AcpModes = { current: string | null; available: AcpMode[] };

export function readAcpModes(value: unknown): AcpModes {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { current: null, available: [] };
  const modes = (value as { modes?: unknown }).modes;
  if (!modes || typeof modes !== "object" || Array.isArray(modes)) return { current: null, available: [] };
  const current = typeof (modes as { currentModeId?: unknown }).currentModeId === "string" ? (modes as { currentModeId: string }).currentModeId : null;
  const raw = (modes as { availableModes?: unknown }).availableModes;
  if (!Array.isArray(raw)) return { current: null, available: [] };
  const available = raw.filter((item): item is { id: string; name: string } => (
    item !== null && typeof item === "object" && typeof (item as { id?: unknown }).id === "string"
    && typeof (item as { name?: unknown }).name === "string"
    && (item as { id: string }).id.length > 0
    && (item as { name: string }).name.length > 0
  )).map((item) => ({ id: item.id, name: item.name }));
  return current && available.some((item) => item.id === current) ? { current, available } : { current: null, available };
}
