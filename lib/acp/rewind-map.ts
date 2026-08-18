import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { mapUpdatesJsonl, type HistoryMessage } from "../history-map.ts";
import { findGrokSession } from "../session-index.ts";

export function promptIndexForEntry(
  entryId: string,
  messages: HistoryMessage[],
  entryIds: string[],
): number {
  const at = entryIds.indexOf(entryId);
  if (at === -1) throw new Error("Invalid entry ID for rewind");
  let index = -1;
  for (let i = 0; i <= at; i++) {
    if (messages[i]?.role === "user") index += 1;
  }
  if (index < 0) throw new Error("Invalid entry ID for rewind");
  return index;
}

export async function resolveSessionEntries(sessionId: string): Promise<{
  messages: HistoryMessage[];
  entryIds: string[];
}> {
  const session = await findGrokSession(sessionId);
  if (!session) throw new Error("Session not found");
  let text = "";
  try {
    text = await readFile(join(session.path, "updates.jsonl"), "utf8");
  } catch {
    text = "";
  }
  return mapUpdatesJsonl(text);
}
