import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { archiveSession, pinSession, readAppMeta } from "./app-meta.ts";

describe("app-meta", () => {
  it("pins and archives without touching session dirs", async () => {
    const home = await mkdtemp(join(tmpdir(), "grok-meta-"));
    const prev = process.env.GROK_HOME;
    process.env.GROK_HOME = home;
    try {
      assert.deepEqual(await readAppMeta(), { pinnedIds: [], archivedIds: [] });
      await pinSession("a", true);
      await archiveSession("b", true);
      const meta = await readAppMeta();
      assert.deepEqual(meta.pinnedIds, ["a"]);
      assert.deepEqual(meta.archivedIds, ["b"]);
      await archiveSession("a", true);
      const after = await readAppMeta();
      assert.ok(!after.pinnedIds.includes("a"));
      assert.ok(after.archivedIds.includes("a"));
    } finally {
      if (prev === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = prev;
    }
  });
});
