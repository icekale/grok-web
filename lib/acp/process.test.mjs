import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { formatGrokMissingError, grokAgentArgs, grokAgentEnv, grokAgentSpawnOptions, resolveGrokBin } from "./process.ts";

describe("formatGrokMissingError", () => {
  it("includes GROK_BIN and the official install script", () => {
    const message = formatGrokMissingError();
    assert.match(message, /GROK_BIN/);
    assert.match(message, /x\.ai\/cli\/install\.sh/);
  });
});

describe("resolveGrokBin", () => {
  it("prefers GROK_BIN when the file exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grok-bin-"));
    const bin = join(dir, "grok");
    await writeFile(bin, "#!/bin/sh\n");
    await chmod(bin, 0o755);
    const prev = process.env.GROK_BIN;
    process.env.GROK_BIN = bin;
    try {
      assert.equal(resolveGrokBin(), bin);
    } finally {
      if (prev === undefined) delete process.env.GROK_BIN;
      else process.env.GROK_BIN = prev;
    }
  });

  it("falls back to GROK_HOME/bin/grok", async () => {
    const home = await mkdtemp(join(tmpdir(), "grok-home-"));
    await mkdir(join(home, "bin"), { recursive: true });
    const bin = join(home, "bin", "grok");
    await writeFile(bin, "#!/bin/sh\n");
    await chmod(bin, 0o755);
    const prevHome = process.env.GROK_HOME;
    const prevBin = process.env.GROK_BIN;
    delete process.env.GROK_BIN;
    process.env.GROK_HOME = home;
    try {
      assert.equal(resolveGrokBin(), bin);
    } finally {
      if (prevHome === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = prevHome;
      if (prevBin === undefined) delete process.env.GROK_BIN;
      else process.env.GROK_BIN = prevBin;
    }
  });

  it("throws grok-missing when neither exists", () => {
    const prevHome = process.env.GROK_HOME;
    const prevBin = process.env.GROK_BIN;
    process.env.GROK_HOME = "/tmp/grok-home-does-not-exist";
    process.env.GROK_BIN = "/tmp/grok-bin-does-not-exist";
    try {
      assert.throws(() => resolveGrokBin(), { message: formatGrokMissingError() });
    } finally {
      if (prevHome === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = prevHome;
      if (prevBin === undefined) delete process.env.GROK_BIN;
      else process.env.GROK_BIN = prevBin;
    }
  });
});

describe("grokAgentEnv", () => {
  it("removes the Web ingress secret but keeps provider environment", () => {
    const env = grokAgentEnv({
      GROK_WEB_PASSWORD: "web-secret",
      GROK_HOME: "/tmp/grok",
      XAI_API_KEY: "provider-secret",
      PATH: "/bin",
    });
    assert.equal(env.GROK_WEB_PASSWORD, undefined);
    assert.equal(env.GROK_HOME, "/tmp/grok");
    assert.equal(env.XAI_API_KEY, "provider-secret");
    assert.equal(env.PATH, "/bin");
  });

  it("does not inject a process-wide default_reasoning_effort", () => {
    const env = grokAgentEnv({
      PATH: "/bin",
      GROK_CONFIG: JSON.stringify({ models: { default: "cpa/grok-4.6" } }),
    });
    assert.equal(env.GROK_CONFIG, JSON.stringify({ models: { default: "cpa/grok-4.6" } }));
    assert.equal(grokAgentEnv({ PATH: "/bin" }).GROK_CONFIG, undefined);
  });
});

describe("grokAgentSpawnOptions", () => {
  it("puts the ACP child in its own process group so tool SIGINT cannot kill grok-web", () => {
    const options = grokAgentSpawnOptions({
      GROK_WEB_PASSWORD: "web-secret",
      PATH: "/bin",
    });
    assert.deepEqual(options.stdio, ["pipe", "pipe", "inherit"]);
    assert.equal(options.env.GROK_WEB_PASSWORD, undefined);
    assert.equal(options.detached, process.platform !== "win32");
  });
});

describe("grokAgentArgs", () => {
  it("starts stdio without always-approve", () => {
    assert.deepEqual(grokAgentArgs(), ["agent", "stdio"]);
    assert.ok(!grokAgentArgs().includes("--always-approve"));
    assert.ok(!grokAgentArgs().includes("--yolo"));
  });

  it("does not pass --reasoning-effort when no session effort is provided", () => {
    const capabilities = {
      version: "1",
      globalFlags: new Set(["--reasoning-effort"]),
      agentFlags: new Set(),
      stdioFlags: new Set(),
      agents: [],
      warnings: [],
    };
    assert.deepEqual(grokAgentArgs({
      version: 1,
      agent: null,
      agentProfilePath: null,
      sandbox: null,
      permissionMode: "default",
      allow: [],
      deny: [],
      disableWebSearch: false,
      disableSubagents: false,
      maxTurns: null,
      rules: null,
    }, capabilities), ["agent", "stdio"]);
  });

  it("passes the session effort as Grok's spawn fallback for omitted Responses fields", () => {
    const capabilities = {
      version: "1",
      globalFlags: new Set(["--reasoning-effort"]),
      agentFlags: new Set(["--reasoning-effort"]),
      stdioFlags: new Set(),
      agents: [],
      warnings: [],
    };
    const profile = {
      version: 1,
      agent: null,
      agentProfilePath: null,
      sandbox: null,
      permissionMode: "default",
      allow: [],
      deny: [],
      disableWebSearch: false,
      disableSubagents: false,
      maxTurns: null,
      rules: null,
    };
    assert.deepEqual(grokAgentArgs(profile, capabilities, "xhigh"), [
      "--reasoning-effort", "xhigh",
      "agent",
      "stdio",
    ]);
    assert.deepEqual(grokAgentArgs(profile, capabilities, "high"), [
      "--reasoning-effort", "high",
      "agent",
      "stdio",
    ]);
  });

  it("omits --reasoning-effort when Grok does not advertise the flag", () => {
    const capabilities = {
      version: "1",
      globalFlags: new Set(),
      agentFlags: new Set(),
      stdioFlags: new Set(),
      agents: [],
      warnings: [],
    };
    assert.deepEqual(grokAgentArgs({
      version: 1,
      agent: null,
      agentProfilePath: null,
      sandbox: null,
      permissionMode: "default",
      allow: [],
      deny: [],
      disableWebSearch: false,
      disableSubagents: false,
      maxTurns: null,
      rules: null,
    }, capabilities, "xhigh"), ["agent", "stdio"]);
  });

  it("builds layered validated argv without shell interpolation", () => {
    const profile = {
      version: 1,
      agent: null,
      agentProfilePath: "/trusted/profile.json",
      sandbox: "workspace",
      permissionMode: "acceptEdits",
      allow: ["Bash(git status:*)"],
      deny: ["Bash(rm -rf:*)"],
      disableWebSearch: true,
      disableSubagents: true,
      maxTurns: 40,
      rules: "Keep scope; $(not a shell)",
    };
    const capabilities = {
      version: "1.2.3",
      globalFlags: new Set(["--agent", "--sandbox", "--permission-mode", "--allow", "--deny", "--disable-web-search", "--no-subagents", "--max-turns", "--rules"]),
      agentFlags: new Set(["--agent-profile"]),
      stdioFlags: new Set(),
      agents: [],
      warnings: [],
    };
    assert.deepEqual(grokAgentArgs(profile, capabilities), [
      "--sandbox", "workspace",
      "--permission-mode", "acceptEdits",
      "--allow", "Bash(git status:*)",
      "--deny", "Bash(rm -rf:*)",
      "--disable-web-search",
      "--no-subagents",
      "--max-turns", "40",
      "--rules", "Keep scope; $(not a shell)",
      "agent",
      "--agent-profile", "/trusted/profile.json",
      "stdio",
    ]);
  });

  it("requires exact capability support for selected agents and flags", () => {
    const profile = { version: 1, agent: "builder", agentProfilePath: null, sandbox: null, permissionMode: "default", allow: [], deny: [], disableWebSearch: false, disableSubagents: false, maxTurns: null, rules: null };
    const capabilities = { version: "1", globalFlags: new Set(), agentFlags: new Set(), stdioFlags: new Set(), agents: [{ name: "builder" }], warnings: [] };
    assert.throws(() => grokAgentArgs(profile, capabilities), /--agent|capability/i);
  });
});
