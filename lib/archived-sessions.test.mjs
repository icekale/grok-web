import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const {
  parseArchivedSessionIds,
  readArchivedSessionIds,
  rememberArchivedSessionIds,
  writeArchivedSessionIds,
} = await jiti.import("./archived-sessions.ts");

test("parseArchivedSessionIds keeps string ids and ignores junk", () => {
  assert.deepEqual([...parseArchivedSessionIds(null)], []);
  assert.deepEqual([...parseArchivedSessionIds('["one","two"]')], ["one", "two"]);
  assert.deepEqual([...parseArchivedSessionIds('["ok",1,null]')], ["ok"]);
  assert.deepEqual([...parseArchivedSessionIds("{")], []);
  assert.deepEqual([...parseArchivedSessionIds('"nope"')], []);
});

test("rememberArchivedSessionIds fills the in-memory cache used by read", () => {
  rememberArchivedSessionIds(["one", 2, "two"]);
  assert.deepEqual([...readArchivedSessionIds()].sort(), ["one", "two"]);
});

test("writeArchivedSessionIds posts archive diffs to /api/meta", async () => {
  const posts = [];
  const previousFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  globalThis.window = globalThis;
  globalThis.fetch = async (url, init) => {
    posts.push({ url, method: init?.method, body: JSON.parse(init?.body ?? "null") });
    return new Response(JSON.stringify({ pinnedIds: [], archivedIds: ["keep", "added"] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    rememberArchivedSessionIds(["keep", "drop"]);
    writeArchivedSessionIds(new Set(["keep", "added"]));
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(posts, [
      { url: "/api/meta", method: "POST", body: { archive: { id: "added", value: true } } },
      { url: "/api/meta", method: "POST", body: { archive: { id: "drop", value: false } } },
    ]);
    assert.deepEqual([...readArchivedSessionIds()].sort(), ["added", "keep"]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
