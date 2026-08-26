import { isBashToolName, isEditToolName, isWriteToolName } from "./tool-names.ts";

export type ActivityGroupKind = "search" | "bash" | "edit" | "read" | "other";

export function activityGroupKind(toolName: string): ActivityGroupKind {
  if (isBashToolName(toolName)) return "bash";
  if (isEditToolName(toolName) || isWriteToolName(toolName)) return "edit";
  const name = toolName.toLowerCase();
  if (
    name.includes("grep")
    || name.includes("glob")
    || name.includes("search")
    || name === "find"
  ) return "search";
  if (name.includes("read") || name === "cat") return "read";
  return "other";
}

export type ActivityBlockItem<T extends { type?: string; toolName?: string } = { type?: string; toolName?: string }> = {
  block: T;
  originalIndex: number;
};

export type ActivityEntry<T extends { type?: string; toolName?: string } = { type?: string; toolName?: string }> =
  | { type: "single"; item: ActivityBlockItem<T> }
  | { type: "group"; kind: Exclude<ActivityGroupKind, "other">; items: ActivityBlockItem<T>[] };

export function groupActivityBlocks<T extends { type?: string; toolName?: string }>(
  items: ActivityBlockItem<T>[],
): ActivityEntry<T>[] {
  const grouped: ActivityEntry<T>[] = [];
  let i = 0;
  while (i < items.length) {
    const item = items[i];
    const kind = item.block.type === "toolCall" && item.block.toolName
      ? activityGroupKind(item.block.toolName)
      : "other";
    if (kind === "other") {
      grouped.push({ type: "single", item });
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < items.length) {
      const next = items[j];
      if (next.block.type !== "toolCall" || !next.block.toolName) break;
      if (activityGroupKind(next.block.toolName) !== kind) break;
      j += 1;
    }
    if (j - i >= 2) grouped.push({ type: "group", kind, items: items.slice(i, j) });
    else grouped.push({ type: "single", item });
    i = j - i >= 2 ? j : i + 1;
  }
  return grouped;
}
