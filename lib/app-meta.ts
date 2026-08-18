import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { grokWebMetaDir } from "./grok-home.ts";

export type AppMeta = { pinnedIds: string[]; archivedIds: string[] };

function metaFile(): string {
  return join(grokWebMetaDir(), "meta.json");
}

function emptyMeta(): AppMeta {
  return { pinnedIds: [], archivedIds: [] };
}

function idList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || seen.has(item)) continue;
    seen.add(item);
    ids.push(item);
  }
  return ids;
}

function withId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids : [...ids, id];
}

function withoutId(ids: string[], id: string): string[] {
  return ids.filter((item) => item !== id);
}

export async function readAppMeta(): Promise<AppMeta> {
  try {
    const parsed: unknown = JSON.parse(await readFile(metaFile(), "utf8"));
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return emptyMeta();
    }
    const body = parsed as Record<string, unknown>;
    return {
      pinnedIds: idList(body.pinnedIds),
      archivedIds: idList(body.archivedIds),
    };
  } catch {
    return emptyMeta();
  }
}

async function writeAppMeta(meta: AppMeta): Promise<AppMeta> {
  const dir = grokWebMetaDir();
  await mkdir(dir, { recursive: true });
  const dest = join(dir, "meta.json");
  const tmp = join(dir, "meta.json.tmp");
  await writeFile(tmp, `${JSON.stringify(meta)}\n`, "utf8");
  await rename(tmp, dest);
  return meta;
}

export async function pinSession(id: string, pinned: boolean): Promise<AppMeta> {
  const meta = await readAppMeta();
  if (pinned) {
    return writeAppMeta({
      pinnedIds: withId(meta.pinnedIds, id),
      archivedIds: withoutId(meta.archivedIds, id),
    });
  }
  return writeAppMeta({
    pinnedIds: withoutId(meta.pinnedIds, id),
    archivedIds: meta.archivedIds,
  });
}

export async function archiveSession(id: string, archived: boolean): Promise<AppMeta> {
  const meta = await readAppMeta();
  if (archived) {
    return writeAppMeta({
      pinnedIds: withoutId(meta.pinnedIds, id),
      archivedIds: withId(meta.archivedIds, id),
    });
  }
  return writeAppMeta({
    pinnedIds: meta.pinnedIds,
    archivedIds: withoutId(meta.archivedIds, id),
  });
}
