import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createJiti } from "jiti";

test("project trust route reports resources and persists approval", async () => {
  const root = mkdtempSync(join(tmpdir(), "grok-project-trust-route-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  mkdirSync(cwd);
  const previousHome = process.env.GROK_HOME;
  process.env.GROK_HOME = home;
  globalThis.__piAdditionalAllowedRoots ??= new Set();
  globalThis.__piAdditionalAllowedRoots.add(cwd);
  globalThis.__piAllowedRootsCache = undefined;

  const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
  const { setAgentRuntime, resetAgentRuntime } = await jiti.import("@/lib/acp/runtime.ts");
  setAgentRuntime({
    hasBusySessionForCwd: () => false,
    dropSessionsForCwd: async () => 0,
  });

  try {
    const { GET, POST } = await jiti.import("./route.ts");
    const get = () => GET(new Request(
      `http://127.0.0.1:30141/api/project-trust?cwd=${encodeURIComponent(cwd)}`,
    ));
    assert.deepEqual(await (await get()).json(), {
      requiresTrust: false,
      trusted: true,
    });

    mkdirSync(join(cwd, ".agents", "skills", "demo"), { recursive: true });
    writeFileSync(join(cwd, ".agents", "skills", "demo", "SKILL.md"), "# Demo\n");
    assert.deepEqual(await (await get()).json(), {
      requiresTrust: true,
      trusted: false,
    });

    const approved = await POST(new Request("http://127.0.0.1:30141/api/project-trust", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd }),
    }));
    assert.equal(approved.status, 200, await approved.clone().text());
    assert.deepEqual(await approved.json(), {
      requiresTrust: true,
      trusted: true,
    });
    assert.equal((await get()).status, 200);
    assert.equal((await (await get()).json()).trusted, true);
  } finally {
    resetAgentRuntime();
    globalThis.__piAdditionalAllowedRoots.delete(cwd);
    globalThis.__piAllowedRootsCache = undefined;
    if (previousHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = previousHome;
  }
});

test("project trust route keeps one canonical cwd if an alias is retargeted", async () => {
  const root = mkdtempSync(join(tmpdir(), "grok-project-trust-alias-"));
  const home = join(root, "home");
  const first = join(root, "first");
  const second = join(root, "second");
  const alias = join(root, "project");
  for (const cwd of [first, second]) {
    mkdirSync(join(cwd, ".agents", "skills", "demo"), { recursive: true });
    writeFileSync(join(cwd, ".agents", "skills", "demo", "SKILL.md"), "# Demo\n");
  }
  symlinkSync(first, alias, "dir");
  const canonicalFirst = realpathSync(first);
  const previousHome = process.env.GROK_HOME;
  process.env.GROK_HOME = home;
  globalThis.__piAdditionalAllowedRoots ??= new Set();
  globalThis.__piAdditionalAllowedRoots.add(alias);
  globalThis.__piAllowedRootsCache = undefined;

  const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
  const { setAgentRuntime, resetAgentRuntime } = await jiti.import("@/lib/acp/runtime.ts");
  const calls = [];
  setAgentRuntime({
    hasBusySessionForCwd: (cwd) => {
      calls.push(["busy", cwd]);
      rmSync(alias);
      symlinkSync(second, alias, "dir");
      return false;
    },
    dropSessionsForCwd: async (cwd) => {
      calls.push(["drop", cwd]);
      return 0;
    },
  });

  try {
    const { POST } = await jiti.import("./route.ts");
    const { getProjectTrustStatus } = await jiti.import("@/lib/project-trust.ts");
    const response = await POST(new Request("http://127.0.0.1:30141/api/project-trust", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: alias }),
    }));

    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(calls, [
      ["busy", canonicalFirst],
      ["drop", canonicalFirst],
    ]);
    assert.equal(getProjectTrustStatus(first, home).trusted, true);
    assert.equal(getProjectTrustStatus(second, home).trusted, false);
  } finally {
    resetAgentRuntime();
    globalThis.__piAdditionalAllowedRoots.delete(alias);
    globalThis.__piAllowedRootsCache = undefined;
    if (previousHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = previousHome;
  }
});

test("project trust API returns corrupt-store diagnostics with restricted status", async () => {
  const root = mkdtempSync(join(tmpdir(), "grok-project-trust-diagnostic-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  mkdirSync(join(cwd, ".agents", "skills", "demo"), { recursive: true });
  writeFileSync(join(cwd, ".agents", "skills", "demo", "SKILL.md"), "# Demo\n");
  mkdirSync(join(home, "grok-web"), { recursive: true });
  writeFileSync(join(home, "grok-web", "project-trust.json"), "{broken");
  const previousHome = process.env.GROK_HOME;
  process.env.GROK_HOME = home;
  globalThis.__piAdditionalAllowedRoots ??= new Set();
  globalThis.__piAdditionalAllowedRoots.add(cwd);
  globalThis.__piAllowedRootsCache = undefined;

  try {
    const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
    const { GET } = await jiti.import("./route.ts");
    const response = await GET(new Request(
      `http://127.0.0.1:30141/api/project-trust?cwd=${encodeURIComponent(cwd)}`,
    ));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.requiresTrust, true);
    assert.equal(body.trusted, false);
    assert.match(body.error, /project trust store/i);
  } finally {
    globalThis.__piAdditionalAllowedRoots.delete(cwd);
    globalThis.__piAllowedRootsCache = undefined;
    if (previousHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = previousHome;
  }
});
