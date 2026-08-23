import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const {
  DEFAULT_RUNTIME_PROFILE,
  readRuntimeProfile,
  runtimeProfilePath,
  validateRuntimeProfile,
  writeRuntimeProfile,
} = await import("./runtime-profile.ts");

function home() {
  const value = mkdtempSync(join(tmpdir(), "grok-web-profile-"));
  mkdirSync(join(value, "grok-web"), { recursive: true });
  return value;
}

test("absence reads strict default profile at the Grok Web path", () => {
  const value = home();
  assert.deepEqual(readRuntimeProfile(value), DEFAULT_RUNTIME_PROFILE);
  assert.equal(runtimeProfilePath(value), join(value, "grok-web", "runtime-profile.json"));
});

test("writes a schema-controlled profile atomically with private permissions", () => {
  const value = home();
  const profile = { ...DEFAULT_RUNTIME_PROFILE, permissionMode: "acceptEdits", allow: ["Bash(git status:*)"], maxTurns: 40 };
  writeRuntimeProfile(profile, value);
  assert.deepEqual(readRuntimeProfile(value), profile);
  assert.equal(statSync(runtimeProfilePath(value)).mode & 0o777, 0o600);
  assert.doesNotMatch(readFileSync(runtimeProfilePath(value), "utf8"), /apiKey|password|token|env/i);
});

test("rejects unsupported, secret-bearing, conflicting, duplicate, and unbounded values", () => {
  const value = home();
  const cases = [
    { version: 2 },
    { apiKey: "secret" },
    { agent: "one", agentProfilePath: join(value, "profile.json") },
    { allow: ["Bash(x)", "Bash(x)"] },
    { allow: ["Bash(x)"], deny: ["Bash(x)"] },
    { allow: [" "] },
    { maxTurns: 0 },
    { maxTurns: 1001 },
    { rules: "x".repeat(5001) },
    { unknown: true },
  ];
  for (const patch of cases) assert.throws(() => validateRuntimeProfile({ ...DEFAULT_RUNTIME_PROFILE, ...patch }, { home }), /invalid|unsupported|conflict|duplicate|bound|secret|unknown/i);
});

test("accepts a trusted regular profile file and rejects missing, directory, and symlink escape paths", () => {
  const value = home();
  const profile = join(value, "grok-web", "agent.json");
  writeFileSync(profile, "{}\n");
  assert.deepEqual(validateRuntimeProfile({ ...DEFAULT_RUNTIME_PROFILE, agentProfilePath: profile }, { home: value }).agentProfilePath, profile);
  const directory = join(value, "grok-web", "directory");
  mkdirSync(directory);
  assert.throws(() => validateRuntimeProfile({ ...DEFAULT_RUNTIME_PROFILE, agentProfilePath: directory }, { home: value }), /regular|file|path/i);
  assert.throws(() => validateRuntimeProfile({ ...DEFAULT_RUNTIME_PROFILE, agentProfilePath: join(value, "missing.json") }, { home: value }), /regular|exist|path/i);
  const outside = mkdtempSync(join(tmpdir(), "grok-web-outside-"));
  const link = join(value, "grok-web", "escape.json");
  symlinkSync(join(outside, "secret.json"), link);
  writeFileSync(join(outside, "secret.json"), "secret\n");
  assert.throws(() => validateRuntimeProfile({ ...DEFAULT_RUNTIME_PROFILE, agentProfilePath: link }, { home: value }), /trusted|root|path/i);
});

test("ignores unknown fields from a valid file and omits them on the next write", () => {
  const value = home();
  writeFileSync(runtimeProfilePath(value), JSON.stringify({ ...DEFAULT_RUNTIME_PROFILE, futureFlag: true }));
  assert.deepEqual(readRuntimeProfile(value), DEFAULT_RUNTIME_PROFILE);
  writeRuntimeProfile(readRuntimeProfile(value), value);
  assert.doesNotMatch(readFileSync(runtimeProfilePath(value), "utf8"), /futureFlag/);
});
