let cachedArchivedIds: Set<string> | null = null;

export function parseArchivedSessionIds(raw: string | null): Set<string> {
  try {
    const value = JSON.parse(raw ?? "[]") as unknown;
    return Array.isArray(value)
      ? new Set(value.filter((item): item is string => typeof item === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}

export function rememberArchivedSessionIds(ids: Iterable<unknown>): Set<string> {
  cachedArchivedIds = new Set(
    [...ids].filter((item): item is string => typeof item === "string"),
  );
  return new Set(cachedArchivedIds);
}

export function readArchivedSessionIds(): Set<string> {
  return cachedArchivedIds ? new Set(cachedArchivedIds) : new Set();
}

export function writeArchivedSessionIds(ids: Set<string>): void {
  const next = new Set([...ids].filter((item): item is string => typeof item === "string"));
  const prev = cachedArchivedIds ?? new Set();
  cachedArchivedIds = next;
  if (typeof window === "undefined") return;
  for (const id of next) {
    if (!prev.has(id)) void postArchive(id, true);
  }
  for (const id of prev) {
    if (!next.has(id)) void postArchive(id, false);
  }
}

async function postArchive(id: string, value: boolean): Promise<void> {
  try {
    await fetch("/api/meta", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archive: { id, value } }),
    });
  } catch {
    // Browser persistence is best-effort.
  }
}
