#!/usr/bin/env node
import { createRequire } from "node:module";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hasGrokApiKey, readGrokAuth } from "../lib/grok-settings/home-config.ts";
import { allocateLoopbackPort } from "./run-acp-e2e.mjs";

const require = createRequire(import.meta.url);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PLAYWRIGHT_CLI = require.resolve("@playwright/test/cli");

function defaultBinary(home, env) {
  const explicit = env.GROK_WEB_LIVE_E2E_GROK_BIN || env.GROK_BIN;
  if (explicit && existsSync(explicit)) return resolve(explicit);
  const homeBinary = join(home, "bin", "grok");
  if (existsSync(homeBinary)) return homeBinary;
  try {
    const found = execFileSync("which", ["grok"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return found && existsSync(found) ? found : undefined;
  } catch {
    return undefined;
  }
}

export function preflightLiveE2e({ env = process.env, defaultHome = join(homedir(), ".grok"), resolveBinary = (home) => defaultBinary(home, env), readAuth = readGrokAuth, hasApiKey = hasGrokApiKey } = {}) {
  if (env.GROK_WEB_LIVE_E2E !== "1") throw new Error("Set GROK_WEB_LIVE_E2E=1 to opt into live E2E.");
  const homeValue = env.GROK_WEB_LIVE_E2E_HOME;
  if (!homeValue) throw new Error("Set GROK_WEB_LIVE_E2E_HOME to an absolute dedicated authenticated Grok home.");
  if (!isAbsolute(homeValue)) throw new Error("GROK_WEB_LIVE_E2E_HOME must be an absolute dedicated home.");
  const home = resolve(homeValue);
  if (!existsSync(home)) throw new Error("GROK_WEB_LIVE_E2E_HOME does not exist.");
  if (home === resolve(defaultHome)) throw new Error("Live E2E refuses the default operator Grok home; use a dedicated home.");
  if (/(?:e2e[\\/]fixtures|acp-agent\.mjs)/i.test(home)) throw new Error("Live E2E refuses the repository ACP fixture as a Grok home.");
  const binary = resolveBinary(home);
  if (!binary || !existsSync(binary)) throw new Error("No real Grok binary is resolvable; set GROK_WEB_LIVE_E2E_GROK_BIN.");
  if (/(?:e2e[\\/]fixtures|acp-agent\.mjs)/i.test(binary)) throw new Error("Live E2E refuses the repository ACP fixture binary.");
  const auth = readAuth(home);
  if (!auth.methods.includes("grok.com") && !hasApiKey(home)) {
    throw new Error("Dedicated Grok home is not authenticated: use grok.com OAuth or the official top-level API key.");
  }
  return { home, binary };
}

function initProject(path) {
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "-q", path]);
  execFileSync("git", ["-C", path, "config", "user.email", "live-e2e@localhost"]);
  execFileSync("git", ["-C", path, "config", "user.name", "Live E2E"]);
  writeFileSync(join(path, "README.md"), "Live E2E temporary project\n");
  execFileSync("git", ["-C", path, "add", "README.md"]);
  execFileSync("git", ["-C", path, "commit", "-qm", "live e2e fixture"]);
}

function waitForExit(child) {
  return new Promise((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit(typeof code === "number" ? code : signal ? 128 : 1));
    child.once("error", () => resolveExit(1));
  });
}

export async function runLiveE2e({ args = [], env = process.env, launcher = (command, childArgs, options) => spawn(command, childArgs, options), preflight = preflightLiveE2e } = {}) {
  const checked = preflight({ env });
  const root = mkdtempSync(join(tmpdir(), "grok-web-live-e2e-"));
  const project = join(root, "project");
  initProject(project);
  const port = await allocateLoopbackPort();
  const runEnv = { ...env };
  delete runEnv.GROK_WEB_PASSWORD;
  Object.assign(runEnv, {
    CI: "1",
    NITRO_HOST: "127.0.0.1",
    GROK_WEB_E2E_ISOLATED: "1",
    GROK_WEB_E2E_PORT: String(port),
    GROK_WEB_E2E_PROJECT_A: project,
    GROK_WEB_LIVE_E2E_HOME: checked.home,
    GROK_BIN: checked.binary,
  });
  let child;
  try {
    child = launcher(PLAYWRIGHT_CLI, ["test", "e2e/live.spec.ts", ...args], {
      cwd: ROOT,
      env: runEnv,
      shell: false,
      detached: process.platform !== "win32",
      stdio: "inherit",
    });
    return await waitForExit(child);
  } finally {
    try {
      if (child?.pid && process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
      else child?.kill?.("SIGTERM");
    } catch {}
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await runLiveE2e({ args: process.argv.slice(2) });
