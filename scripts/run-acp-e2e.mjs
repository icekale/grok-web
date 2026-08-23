#!/usr/bin/env node
import { createRequire } from "node:module";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { redactE2eText, sanitizeTraceArchive, validateArtifactDirectory } from "./e2e-artifacts.mjs";
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
  const artifactDir = join(ROOT, ".artifacts", "e2e");
  rmSync(artifactDir, { recursive: true, force: true });
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
    cleanup: async ({ preserveArtifacts = false } = {}) => {
      if (!preserveArtifacts) rmSync(artifactDir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    },
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

function findFile(root, suffix) {
  if (!existsSync(root)) return undefined;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(path, suffix);
      if (found) return found;
    } else if (entry.name.endsWith(suffix)) return path;
  }
  return undefined;
}
function writeFailureArtifacts(resources, exitCode) {
  mkdirSync(resources.artifactDir, { recursive: true });
  writeFileSync(join(resources.artifactDir, "chronology.json"), "[]\n");
  writeFileSync(join(resources.artifactDir, "server.log"), `${JSON.stringify({ status: "failed", exitCode })}\n`);
  const fixtureLog = existsSync(resources.logPath) ? readFileSync(resources.logPath, "utf8") : "";
  writeFileSync(join(resources.artifactDir, "fixture.log"), redactE2eText(fixtureLog, { roots: new Map([[resources.home, "<grok-home>"], [resources.projectA, "<project-a>"], [resources.projectB, "<project-b>"]]) }));
  const rawTrace = findFile(resources.rawOutputDir, ".zip");
  if (rawTrace) {
    writeFileSync(join(resources.artifactDir, "trace.zip"), sanitizeTraceArchive(readFileSync(rawTrace), { roots: new Map([[resources.home, "<grok-home>"], [resources.projectA, "<project-a>"], [resources.projectB, "<project-b>"]]) }));
  } else {
    writeFileSync(join(resources.artifactDir, "trace.zip"), zipSync({ "trace.trace": strToU8(JSON.stringify({ status: "failed", exitCode })) }));
  }
  if (!existsSync(join(resources.artifactDir, "screenshot.png"))) {
    writeFileSync(join(resources.artifactDir, "screenshot.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  }
  validateArtifactDirectory(resources.artifactDir, { roots: new Map([[resources.home, "<grok-home>"], [resources.projectA, "<project-a>"], [resources.projectB, "<project-b>"]]) });
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
    if (exitCode !== 0) writeFailureArtifacts(resources, exitCode);
    return exitCode;
  } finally {
    terminateProcessGroup(child);
    await resources.cleanup?.({ preserveArtifacts: exitCode !== 0 });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await runAcpE2e({ args: process.argv.slice(2) });
}
