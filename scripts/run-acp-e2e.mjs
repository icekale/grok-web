#!/usr/bin/env node
import { createRequire } from "node:module";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const require = createRequire(import.meta.url);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PLAYWRIGHT_CLI = require.resolve("@playwright/test/cli");

export function buildAcpE2eEnv(input, base = process.env) {
  const env = { ...base };
  delete env.GROK_WEB_PASSWORD;
  return {
    ...env,
    CI: "1",
    NITRO_HOST: "127.0.0.1",
    GROK_WEB_E2E_ISOLATED: "1",
    GROK_WEB_E2E_PORT: String(input.port),
    GROK_WEB_E2E_PROJECT_A: input.projectA,
    GROK_WEB_E2E_PROJECT_B: input.projectB,
    GROK_WEB_ACP_FIXTURE_SCENARIO: "core",
    GROK_WEB_ACP_FIXTURE_LOG: input.logPath,
    GROK_WEB_ACP_FIXTURE_CONTROL: input.controlPath,
    GROK_WEB_ACP_FIXTURE_TEST_ID: "deterministic-acp",
    GROK_WEB_ACP_FIXTURE_ROOTS: JSON.stringify({ [input.projectA]: "<project-a>", [input.projectB]: "<project-b>" }),
    GROK_BIN: input.fixture,
    GROK_HOME: input.home,
    GROK_WEB_E2E_ARTIFACT_DIR: input.artifactDir,
    GROK_WEB_E2E_RAW_OUTPUT_DIR: input.rawOutputDir,
  };
}

export async function allocateLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function initGitProject(path, name) {
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "-q", path]);
  execFileSync("git", ["-C", path, "config", "user.email", "acp-e2e@localhost"]);
  execFileSync("git", ["-C", path, "config", "user.name", "ACP E2E"]);
  writeFileSync(join(path, "README.md"), `ACP E2E ${name}\n`);
  execFileSync("git", ["-C", path, "add", "README.md"]);
  execFileSync("git", ["-C", path, "commit", "-qm", "fixture"]);
}

export async function createAcpE2eResources() {
  const root = mkdtempSync(join(tmpdir(), "grok-web-acp-e2e-"));
  const home = join(root, "home");
  const projectA = join(root, "project-a");
  const projectB = join(root, "project-b");
  const artifactDir = join(root, "artifacts");
  const rawOutputDir = join(root, "raw-output");
  const logPath = join(root, "fixture.log");
  const controlPath = join(root, "fixture.control");
  mkdirSync(home, { recursive: true });
  mkdirSync(artifactDir, { recursive: true });
  mkdirSync(rawOutputDir, { recursive: true });
  writeFileSync(controlPath, "");
  initGitProject(projectA, "project-a");
  initGitProject(projectB, "project-b");
  const port = await allocateLoopbackPort();
  return {
    root,
    home,
    fixture: join(ROOT, "e2e/fixtures/acp-agent.mjs"),
    port,
    projectA,
    projectB,
    artifactDir,
    rawOutputDir,
    logPath,
    controlPath,
    cleanup: async () => rmSync(root, { recursive: true, force: true }),
  };
}

function waitForChild(child) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (code, signal) => {
      if (settled) return;
      settled = true;
      resolve(typeof code === "number" ? code : signal ? 128 : 1);
    };
    child.once("exit", done);
    child.once("error", () => done(1, null));
  });
}

function terminateProcessGroup(child) {
  if (!child || child.exitCode !== null || child.signalCode) {
    try { child.kill?.(); } catch {}
    return;
  }
  if (child.pid && process.platform !== "win32") {
    try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill?.("SIGTERM"); } catch {} }
  } else {
    try { child.kill?.("SIGTERM"); } catch {}
  }
}

export async function runAcpE2e({ args = [], launcher = (command, childArgs, options) => spawn(command, childArgs, options), resourceFactory = createAcpE2eResources } = {}) {
  const resources = await resourceFactory();
  let child;
  let exitCode = 1;
  try {
    const env = buildAcpE2eEnv(resources);
    child = launcher(PLAYWRIGHT_CLI, ["test", ...args], {
      cwd: ROOT,
      env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: "inherit",
    });
    exitCode = await waitForChild(child);
    return exitCode;
  } finally {
    terminateProcessGroup(child);
    await resources.cleanup?.();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await runAcpE2e({ args: process.argv.slice(2) });
}
