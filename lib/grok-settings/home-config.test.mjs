import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { assertBindAllowed } from "../bind-guard.ts";
import {
  clearGrokApiKey,
  hasGrokApiKey,
  listGrokSkills,
  listMcpServers,
  loadGrokSettings,
  parseSimpleToml,
  readGrokAuth,
  readGrokConfig,
  readPermissionMode,
  sessionNewMeta,
  writeGrokApiKey,
  writeGrokWebSettings,
  writePermissionMode,
} from "./home-config.ts";

describe("grok home settings", () => {
  it("reads config, auth, mcp, and skills from GROK_HOME fixtures", () => {
    const home = mkdtempSync(join(tmpdir(), "grok-settings-"));
    writeFileSync(join(home, "config.toml"), `
disabled_mcp_servers = ["offbox"]

[ui]
permission_mode = "ask"

[mcp_servers.docs]
command = "npx"
enabled = true

[mcp_servers.offbox]
command = "echo"
enabled = false
`);
    writeFileSync(join(home, "auth.json"), JSON.stringify({ "grok.com": { ok: true } }));
    mkdirSync(join(home, "skills", "demo"), { recursive: true });
    writeFileSync(join(home, "skills", "demo", "SKILL.md"), "# demo\n");
    const cwd = mkdtempSync(join(tmpdir(), "grok-proj-"));
    mkdirSync(join(cwd, ".agents", "skills", "local"), { recursive: true });
    writeFileSync(join(cwd, ".agents", "skills", "local", "SKILL.md"), "# local\n");

    const settings = loadGrokSettings(home, cwd);
    assert.equal(settings.username, "grok");
    assert.equal(settings.home, home);
    assert.equal(settings.auth.loggedIn, true);
    assert.deepEqual(settings.auth.methods, ["grok.com"]);
    const mcpServers = listMcpServers(parseSimpleToml(readFileSync(join(home, "config.toml"), "utf8")));
    assert.ok(mcpServers.some((server) => server.name === "docs" && server.command === "npx" && server.enabled === true));
    assert.ok(mcpServers.some((server) => server.name === "offbox" && server.enabled === false));
    assert.ok(settings.mcpServers.some((server) => server.name === "docs" && server.command === "npx" && server.enabled === true));
    assert.ok(settings.mcpServers.some((server) => server.name === "offbox" && server.enabled === false));
    assert.ok(settings.skills.some((skill) => skill.name === "demo"));
    assert.ok(settings.skills.some((skill) => skill.name === "local"));
    assert.equal(mcpServers.length, 2);
    assert.equal(listGrokSkills(home).length, 1);
    assert.deepEqual(readGrokAuth(home).methods, ["grok.com"]);
  });

  it("persists grok-web settings under ~/.grok/grok-web", () => {
    const home = mkdtempSync(join(tmpdir(), "grok-settings-write-"));
    const file = writeGrokWebSettings({ theme: "dark" }, home);
    assert.match(file, /grok-web\/settings\.json$/);
    const settings = loadGrokSettings(home);
    assert.equal(settings.username, "grok");
    assert.equal(settings.auth.loggedIn, false);
  });

  it("writes and clears a top-level api_key without exposing it in loadGrokSettings.auth", () => {
    const home = mkdtempSync(join(tmpdir(), "grok-apikey-"));
    assert.equal(hasGrokApiKey(home), false);
    writeGrokApiKey("test-key", home);
    assert.equal(hasGrokApiKey(home), true);
    assert.match(readFileSync(join(home, "config.toml"), "utf8"), /api_key = "test-key"/);
    if (process.platform !== "win32") {
      assert.equal(statSync(join(home, "config.toml")).mode & 0o777, 0o600);
    }
    const auth = loadGrokSettings(home).auth;
    assert.equal(auth.loggedIn, false);
    assert.deepEqual(auth.methods, []);
    assert.doesNotMatch(JSON.stringify(auth), /test-key/);
    clearGrokApiKey(home);
    assert.equal(hasGrokApiKey(home), false);
  });

  it("only rewrites the top-level api_key line", () => {
    const home = mkdtempSync(join(tmpdir(), "grok-apikey-section-"));
    writeFileSync(join(home, "config.toml"), `[model.x]\napi_key = "keep-me"\n`);
    writeGrokApiKey("top-secret", home);
    const text = readFileSync(join(home, "config.toml"), "utf8");
    assert.match(text, /^api_key = "top-secret"$/m);
    assert.match(text, /\[model\.x\][\s\S]*api_key = "keep-me"/);
    clearGrokApiKey(home);
    const after = readFileSync(join(home, "config.toml"), "utf8");
    assert.doesNotMatch(after.split(/^\[/m)[0], /^api_key = /m);
    assert.match(after, /api_key = "keep-me"/);
  });

  it("treats a [model.*] api_key as configured and ignores mcp_servers keys", () => {
    const home = mkdtempSync(join(tmpdir(), "grok-apikey-model-"));
    writeFileSync(join(home, "config.toml"), `
[mcp_servers.docs]
api_key = "mcp-secret"
command = "true"
`);
    assert.equal(hasGrokApiKey(home), false);
    writeFileSync(join(home, "config.toml"), `
[mcp_servers.docs]
api_key = "mcp-secret"

[model."grok-4.6"]
api_key = "model-secret"
`);
    assert.equal(hasGrokApiKey(home), true);
  });

  it("rejects a non-loopback bind without a password", () => {
    assert.throws(() => assertBindAllowed("0.0.0.0", undefined), /GROK_WEB_PASSWORD|refuses/);
    assert.doesNotThrow(() => assertBindAllowed("127.0.0.1", undefined));
  });

  it("reads permission_mode from [ui], then top-level, then yolo", () => {
    assert.equal(readPermissionMode({}), "ask");
    assert.equal(readPermissionMode({ permission_mode: "auto" }), "auto");
    assert.equal(readPermissionMode({ yolo: true }), "always-approve");
    assert.equal(readPermissionMode({
      permission_mode: "always-approve",
      ui: { permission_mode: "ask" },
    }), "ask");
    assert.equal(readPermissionMode({ permission_mode: "bypassPermissions" }), "always-approve");
    assert.equal(readPermissionMode({ permission_mode: "default" }), "ask");
    assert.deepEqual(sessionNewMeta("ask"), {});
    assert.deepEqual(sessionNewMeta("auto"), { autoMode: true });
    assert.deepEqual(sessionNewMeta("always-approve"), { yoloMode: true });
  });

  it("writes [ui] permission_mode without touching api_key", () => {
    const home = mkdtempSync(join(tmpdir(), "grok-perm-"));
    writeFileSync(join(home, "config.toml"), `api_key = "keep-me"\nyolo = false\npermission_mode = "always-approve"\n`);
    writePermissionMode("ask", home);
    const text = readFileSync(join(home, "config.toml"), "utf8");
    assert.match(text, /api_key = "keep-me"/);
    assert.match(text, /\[ui\][\s\S]*permission_mode = "ask"/);
    assert.equal(readPermissionMode(parseSimpleToml(text)), "ask");
    writePermissionMode("always-approve", home);
    assert.equal(readPermissionMode(readGrokConfig(home)), "always-approve");
    writePermissionMode("auto", home);
    assert.equal(readPermissionMode(readGrokConfig(home)), "auto");
  });

  it("parses disabled_mcp_servers string arrays so listed servers stay disabled", () => {
    const parsed = parseSimpleToml(`
disabled_mcp_servers = ["ghost", "beta"]

[mcp_servers.ghost]
command = "true"

[mcp_servers.beta]
command = "true"
`);
    assert.deepEqual(parsed.disabled_mcp_servers, ["ghost", "beta"]);
    const servers = listMcpServers(parsed);
    assert.equal(servers.find((server) => server.name === "ghost")?.enabled, false);
    assert.equal(servers.find((server) => server.name === "beta")?.enabled, false);
  });
});

