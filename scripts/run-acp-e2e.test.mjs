import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const { buildAcpE2eEnv, runAcpE2e } = await import("./run-acp-e2e.mjs");

test("buildAcpE2eEnv maps isolated runner resources without secrets", () => {
  const env = buildAcpE2eEnv({
    home: "/tmp/home",
    fixture: "/repo/e2e/fixtures/acp-agent.mjs",
    port: 41234,
    projectA: "/tmp/a",
    projectB: "/tmp/b",
    artifactDir: "/tmp/artifacts",
    rawOutputDir: "/tmp/raw",
    logPath: "/tmp/fixture.log",
    controlPath: "/tmp/control",
  });
  assert.equal(env.GROK_HOME, "/tmp/home");
  assert.equal(env.GROK_BIN, "/repo/e2e/fixtures/acp-agent.mjs");
  assert.equal(env.GROK_WEB_E2E_PORT, "41234");
  assert.equal(env.GROK_WEB_E2E_PROJECT_A, "/tmp/a");
  assert.equal(env.GROK_WEB_E2E_PROJECT_B, "/tmp/b");
  assert.equal(env.GROK_WEB_E2E_ISOLATED, "1");
  assert.equal(env.NITRO_HOST, "127.0.0.1");
  assert.equal("GROK_WEB_PASSWORD" in env, false);
});

test("runAcpE2e forwards CLI args and removes runner resources after failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "grok-web-runner-test-"));
  let launch;
  const child = {
    killed: false,
    kill() { this.killed = true; },
    once(event, callback) { if (event === "exit") queueMicrotask(() => callback(7, null)); return this; },
  };
  const code = await runAcpE2e({
    root,
    args: ["--grep", "ACP core"],
    resourceFactory: async () => ({
      home: root,
      fixture: "/repo/e2e/fixtures/acp-agent.mjs",
      port: 41235,
      projectA: root,
      projectB: root,
      artifactDir: join(root, "artifacts"),
      rawOutputDir: join(root, "raw"),
      logPath: join(root, "fixture.log"),
      controlPath: join(root, "control"),
      cleanup: async () => rmSync(root, { recursive: true, force: true }),
    }),
    launcher: (command, args, options) => {
      launch = { command, args, options };
      return child;
    },
    cleanup: async () => {},
  });
  assert.equal(code, 7);
  assert.ok(launch.command.endsWith("@playwright/test/cli.js"));
  assert.deepEqual(launch.args.slice(-2), ["--grep", "ACP core"]);
  assert.equal(launch.options.shell, false);
  assert.equal(child.killed, true);
  assert.equal(existsSync(root), false);
});
