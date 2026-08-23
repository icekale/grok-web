import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const { preflightLiveE2e, runLiveE2e } = await import("./run-live-e2e.mjs");

function homeWithAuth(methods = ["grok.com"], key = false) {
  const home = mkdtempSync(join(tmpdir(), "grok-web-live-home-"));
  if (methods) writeFileSync(join(home, "auth.json"), JSON.stringify(Object.fromEntries(methods.map((method) => [method, {}]))));
  if (key) writeFileSync(join(home, "config.toml"), "api_key = \"test-only-placeholder\"\n");
  return home;
}

const baseEnv = { GROK_WEB_LIVE_E2E: "1" };

test("live preflight fails closed before spawn for missing opt-in and home", () => {
  assert.throws(() => preflightLiveE2e({ env: {}, resolveBinary: () => process.execPath }), /GROK_WEB_LIVE_E2E/);
  assert.throws(() => preflightLiveE2e({ env: baseEnv, resolveBinary: () => process.execPath }), /GROK_WEB_LIVE_E2E_HOME/);
});

test("live preflight rejects default, relative, nonexistent, and fixture homes", () => {
  const defaultHome = join(tmpdir(), "operator", ".grok");
  for (const home of [defaultHome, "relative/home", "/path/does/not/exist", "/repo/e2e/fixtures/acp-agent.mjs"]) {
    assert.throws(() => preflightLiveE2e({ env: { ...baseEnv, GROK_WEB_LIVE_E2E_HOME: home }, defaultHome, resolveBinary: () => process.execPath }), /dedicated|absolute|fixture|exist|default/i);
  }
});

test("live preflight distinguishes official Grok authentication from custom providers", () => {
  const home = homeWithAuth(["xai.api_key"]);
  assert.throws(() => preflightLiveE2e({ env: { ...baseEnv, GROK_WEB_LIVE_E2E_HOME: home }, resolveBinary: () => process.execPath }), /authenticated|grok.com|api key/i);
});

test("live preflight accepts exact grok.com auth or the top-level official key", () => {
  const authHome = homeWithAuth(["grok.com"]);
  const keyHome = homeWithAuth([], true);
  for (const home of [authHome, keyHome]) {
    const result = preflightLiveE2e({ env: { ...baseEnv, GROK_WEB_LIVE_E2E_HOME: home }, resolveBinary: () => process.execPath });
    assert.equal(result.home, realpathSync(home));
    assert.equal(result.binary, process.execPath);
  }
});

test("live preflight accepts the current official auth.x.ai device credential", () => {
  const home = homeWithAuth(["https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828"]);
  const result = preflightLiveE2e({ env: { ...baseEnv, GROK_WEB_LIVE_E2E_HOME: home }, resolveBinary: () => process.execPath });
  assert.equal(result.home, realpathSync(home));
});

test("live child environment pins the dedicated home", async () => {
  const home = homeWithAuth(["grok.com"]);
  let launchedEnv;
  const launcher = (_command, _args, options) => {
    launchedEnv = options.env;
    return { pid: undefined, once(event, callback) { if (event === "exit") queueMicrotask(() => callback(0, null)); return this; }, kill() {} };
  };
  const code = await runLiveE2e({ env: { ...baseEnv, GROK_WEB_LIVE_E2E_HOME: home }, launcher, preflight: () => ({ home, binary: process.execPath }), cleanup: () => {}, snapshotWorktrees: () => new Set() });
  assert.equal(code, 0);
  assert.equal(launchedEnv.GROK_HOME, home);
});

test("runLiveE2e never spawns when preflight fails", async () => {
  let spawned = false;
  await assert.rejects(runLiveE2e({ env: {}, launcher: () => { spawned = true; throw new Error("must not spawn"); } }), /GROK_WEB_LIVE_E2E/);
  assert.equal(spawned, false);
});
