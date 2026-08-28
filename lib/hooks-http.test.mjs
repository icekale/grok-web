import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });

const cwd = mkdtempSync(join(tmpdir(), "grok-hooks-cwd-"));
globalThis.__piAdditionalAllowedRoots ??= new Set();
globalThis.__piAdditionalAllowedRoots.add(cwd);
globalThis.__piAllowedRootsCache = undefined;

const fakeBin = join(cwd, "fake-grok");
writeFileSync(
  fakeBin,
  "#!/bin/sh\nprintf '%s\\n' '{\"projectTrusted\":false,\"projectRoot\":\"/Users/someone/project\",\"hooks\":[]}'\n",
);
chmodSync(fakeBin, 0o755);

function postHeaders() {
  return {
    host: "127.0.0.1:30141",
    origin: "http://127.0.0.1:30141",
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
  };
}

describe("/api/hooks", () => {
  const previousHome = process.env.GROK_HOME;
  const previousBin = process.env.GROK_BIN;
  const previousTrust = process.env.GROK_FOLDER_TRUST;
  const home = mkdtempSync(join(tmpdir(), "grok-hooks-home-"));

  afterEach(() => {
    process.env.GROK_HOME = previousHome;
    process.env.GROK_BIN = previousBin;
    if (previousTrust === undefined) delete process.env.GROK_FOLDER_TRUST;
    else process.env.GROK_FOLDER_TRUST = previousTrust;
  });

  async function load() {
    process.env.GROK_HOME = home;
    process.env.GROK_BIN = fakeBin;
    delete process.env.GROK_FOLDER_TRUST;
    return jiti.import("./hooks-http.ts");
  }

  it("GET requires cwd", async () => {
    const { GET } = await load();
    const res = await GET(new Request("http://127.0.0.1:30141/api/hooks"));
    assert.equal(res.status, 400);
  });

  it("GET lists inspect hooks", async () => {
    const { GET } = await load();
    const res = await GET(new Request(`http://127.0.0.1:30141/api/hooks?cwd=${encodeURIComponent(cwd)}`));
    assert.equal(res.status, 200, await res.clone().text());
    const body = await res.json();
    assert.equal(body.projectTrusted, false);
    assert.deepEqual(body.hooks, []);
  });

  it("POST add writes a user hook file", async () => {
    const { POST } = await load();
    const res = await POST(new Request("http://127.0.0.1:30141/api/hooks", {
      method: "POST",
      headers: postHeaders(),
      body: JSON.stringify({
        cwd,
        action: "add",
        event: "SessionStart",
        type: "command",
        command: "echo hi",
      }),
    }));
    assert.equal(res.status, 200, await res.clone().text());
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.match(body.target, /hooks\/web-sessionstart-/);
  });

  it("writes recycle through recycleProcessAndReload", async () => {
    const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("./hooks-http.ts", import.meta.url), "utf8"));
    assert.match(source, /recycleProcessAndReload/);
    assert.doesNotMatch(source, /runtime\.recycleProcess\(\)/);
  });

  it("GET reports folderTrustEnabled from config.toml", async () => {
    writeFileSync(join(home, "config.toml"), "[folder_trust]\nenabled = false\n");
    const { GET } = await load();
    const res = await GET(new Request(`http://127.0.0.1:30141/api/hooks?cwd=${encodeURIComponent(cwd)}`));
    assert.equal(res.status, 200, await res.clone().text());
    const body = await res.json();
    assert.equal(body.folderTrustEnabled, false);
  });

  it("POST trust writes inspect.projectRoot not cwd", async () => {
    const { POST } = await load();
    const res = await POST(new Request("http://127.0.0.1:30141/api/hooks", {
      method: "POST",
      headers: postHeaders(),
      body: JSON.stringify({ cwd, action: "trust" }),
    }));
    assert.equal(res.status, 200, await res.clone().text());
    const text = (await import("node:fs")).readFileSync(join(home, "trusted_folders.toml"), "utf8");
    assert.match(text, /\[folders\."\/Users\/someone\/project"\]/);
    assert.match(text, /trusted = true/);
    assert.doesNotMatch(text, new RegExp(cwd.replaceAll("/", "\\/")));
  });

  it("POST without JSON is 415", async () => {
    const { POST } = await load();
    const res = await POST(new Request("http://127.0.0.1:30141/api/hooks", {
      method: "POST",
      headers: { host: "127.0.0.1:30141", origin: "http://127.0.0.1:30141", "sec-fetch-site": "same-origin" },
      body: "{}",
    }));
    assert.equal(res.status, 415);
  });
});
