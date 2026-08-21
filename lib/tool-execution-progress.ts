import { toolResultText } from "./history-map.ts";

const MAX_PROGRESS_LENGTH = 500;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getToolExecutionProgress(partialResult: unknown): string | null {
  if (!isObject(partialResult)) return null;

  const text = toolResultText(partialResult.content ?? partialResult);
  const lines = text.split(/\r?\n/);
  let latest = "";
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    latest = lines[index].trim();
    if (latest) break;
  }
  if (!latest) return null;

  const normalized = latest.replace(/\s+/g, " ");
  return normalized.length <= MAX_PROGRESS_LENGTH
    ? normalized
    : `...${normalized.slice(-(MAX_PROGRESS_LENGTH - 3))}`;
}
