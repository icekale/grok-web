export function composerDisplayId(modelId: string): string {
  const slash = modelId.indexOf("/");
  return slash > 0 ? modelId.slice(slash + 1) : modelId;
}

export function composerProvider(modelId: string): string {
  const slash = modelId.indexOf("/");
  return slash > 0 ? modelId.slice(0, slash) : "grok";
}

export function sessionModelRef(modelId: string): { provider: string; id: string } {
  return { provider: composerProvider(modelId), id: modelId };
}

export function resolvedSessionModelId(requested: string, reported?: string | null): string {
  if (!reported) return requested;
  if (requested.includes("/") && !reported.includes("/") && composerDisplayId(requested) === reported) {
    return requested;
  }
  return reported;
}

export function composerModelLabel(modelId: string, name?: string | null): string {
  const id = composerDisplayId(modelId);
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (trimmed && !isGenericGrokLabel(trimmed)) return trimmed;
  if (isGenericGrokLabel(id)) return humanizeModelId("grok-4.6");
  return humanizeModelId(id);
}

function isGenericGrokLabel(name: string): boolean {
  return /^grok$/i.test(name);
}

function humanizeModelId(modelId: string): string {
  return modelId
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => {
      if (/^\d+(?:\.\d+)*$/.test(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}
