import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  writeGrokApiKey,
  writeGrokWebSettings,
} from "./home-config.ts";

describe("grok home settings", () => {
  it("reads config, auth, mcp, and skills from GROK_HOME fixtures", () => {
    const home = mkdtempSync(join(tmpdir(), "grok-settings-"));
    writeFileSync(join(home, "config.toml"), `
[ui]
permission_mode = "ask"

[mcp.servers.docs]
command = "npx"
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
    assert.ok(settings.mcpServers.some((server) => server.name === "docs" && server.command === "npx"));
    assert.ok(settings.skills.some((skill) => skill.name === "demo"));
    assert.ok(settings.skills.some((skill) => skill.name === "local"));
    assert.equal(listMcpServers(parseSimpleToml(readFileSync(join(home, "config.toml"), "utf8"))).length, 1);
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
    const auth = loadGrokSettings(home).auth;
    assert.equal(auth.loggedIn, false);
    assert.deepEqual(auth.methods, []);
    assert.doesNotMatch(JSON.stringify(auth), /test-key/);
    clearGrokApiKey(home);
    assert.equal(hasGrokApiKey(home), false);
  });

  it("rejects a non-loopback bind without a password", () => {
    assert.throws(() => assertBindAllowed("0.0.0.0", undefined), /GROK_WEB_PASSWORD|refuses/);
    assert.doesNotThrow(() => assertBindAllowed("127.0.0.1", undefined));
  });
});

