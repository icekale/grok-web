const DROP_KEYS = new Set(["variant", "is_background"]);

export function sanitizeGrokToolInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (DROP_KEYS.has(key)) continue;
    if (value == null || value === "") continue;
    if (value === false && (key.startsWith("-") || key === "multiline")) continue;
    out[key] = value;
  }
  return out;
}

export function grokToolPreviewValue(input: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.replace(/\s+/g, " ").slice(0, 120);
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

export function grokCanonicalToolName(title = "", kind = ""): string {
  const titleLower = title.toLowerCase();
  const kindLower = kind.toLowerCase();
  if (
    titleLower === "run_terminal_command"
    || titleLower === "bash"
    || titleLower === "shell"
    || titleLower === "terminal"
    || titleLower === "execute"
    || kindLower === "execute"
    || kindLower === "bash"
    || /^execute\s/i.test(title)
  ) {
    return "bash";
  }
  return title || kind || "tool";
}
