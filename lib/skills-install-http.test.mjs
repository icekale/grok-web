import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createJiti } from "jiti";

test("project skill installation is denied before trust and allowed after approval", async () => {
  const root = mkdtempSync(join(tmpdir(), "grok-skill-install-trust-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "extensions", "demo.ts"), "export default () => {};\n");
  const previousHome = process.env.GROK_HOME;
  process.env.GROK_HOME = home;
  globalThis.__piAdditionalAllowedRoots ??= new Set();
  globalThis.__piAdditionalAllowedRoots.add(cwd);
  globalThis.__piAllowedRootsCache = undefined;

  const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
  const { handleSkillsInstall } = await jiti.import("./skills-install-http.ts");
  const { trustProject } = await jiti.import("@/lib/project-trust.ts");
  const calls = [];
  const fakeRunNpx = async (args, options) => {
    calls.push({ args, options });
    return { stdout: "Installation complete", stderr: "" };
  };
  const request = () => new Request("http://127.0.0.1:30141/api/skills/install", {
    method: "POST",
    headers: {
      host: "127.0.0.1:30141",
      origin: "http://127.0.0.1:30141",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    body: JSON.stringify({ package: "owner/repo@demo", scope: "project", cwd }),
  });

  try {
    const denied = await handleSkillsInstall(request(), fakeRunNpx);
    assert.equal(denied.status, 403);
    assert.equal(calls.length, 0);

    trustProject(cwd, home);
    const allowed = await handleSkillsInstall(request(), fakeRunNpx);
    assert.equal(allowed.status, 200, await allowed.clone().text());
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.cwd, cwd);
  } finally {
    globalThis.__piAdditionalAllowedRoots.delete(cwd);
    globalThis.__piAllowedRootsCache = undefined;
    if (previousHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = previousHome;
  }
});
