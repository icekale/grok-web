const MAX_SUMMARY_CHARS = 48;

function cleanLine(s: string): string {
  return s
    .replace(/^#{1,6}\s+/, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(s: string, max = MAX_SUMMARY_CHARS): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

/** Collapse-label for a thinking block. Null means keep the generic "Thinking" copy. */
export function extractThinkingSummary(content: string | null | undefined): string | null {
  if (!content?.trim()) return null;

  const bold = content.match(/\*\*(.+?)\*\*/);
  if (bold?.[1]?.trim()) return clip(cleanLine(bold[1]));

  const heading = content.match(/^#{1,4}\s+(.+)$/m);
  if (heading?.[1]?.trim()) return clip(cleanLine(heading[1]));

  for (const line of content.split(/\r?\n/)) {
    const t = cleanLine(line);
    if (!t || /^[-*+>]\s*$/.test(t) || t.length < 2) continue;
    return clip(t);
  }
  return null;
}
