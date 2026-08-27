import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false });
const cwd = mkdtempSync(join(tmpdir(), "grok-memory-cwd-"));
globalThis.__piAdditionalAllowedRoots ??= new Set();
globalThis.__piAdditionalAllowedRoots.add(cwd);
globalThis.__piAllowedRootsCache = undefined;

function postHeaders() {
  return {
    host: "127.0.0.1:30141",
    origin: "http://127.0.0.1:30141",
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
  };
}

describe("/api/memory", () => {
  const previousHome = process.env.GROK_HOME;
  const home = mkdtempSync(join(tmpdir(), "grok-memory-home-"));

  afterEach(() => {
    if (previousHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = previousHome;
  });

  async function load() {
    process.env.GROK_HOME = home;
    return jiti.import("./memory-http.ts");
  }

  it("GET requires cwd", async () => {
    const { GET } = await load();
    const res = await GET(new Request("http://127.0.0.1:30141/api/memory"));
    assert.equal(res.status, 400);
  });

  it("enable then remember writes MEMORY.md", async () => {
    const { GET, POST } = await load();
    const enabled = await POST(new Request("http://127.0.0.1:30141/api/memory", {
      method: "POST",
      headers: postHeaders(),
      body: JSON.stringify({ cwd, action: "enable" }),
    }));
    assert.equal(enabled.status, 200, await enabled.clone().text());
    const remembered = await POST(new Request("http://127.0.0.1:30141/api/memory", {
      method: "POST",
      headers: postHeaders(),
      body: JSON.stringify({ cwd, action: "remember", text: "always open PRs" }),
    }));
    assert.equal(remembered.status, 200, await remembered.clone().text());
    const body = await remembered.json();
    assert.equal(body.enabled, true);
    assert.match(readFileSync(join(home, "memory", "MEMORY.md"), "utf8"), /always open PRs/);
    const listed = await GET(new Request(`http://127.0.0.1:30141/api/memory?cwd=${encodeURIComponent(cwd)}`));
    assert.equal((await listed.json()).files[0].scope, "global");
  });
});
