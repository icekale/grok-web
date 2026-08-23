import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { getGrokSettings, legacyToRuntime, putGrokSettings, runtimeToLegacy } from "./grok-settings/http.ts";
import { readRuntimeProfile } from "./runtime-profile.ts";

const request = (permissionMode) => new Request("http://127.0.0.1/api/settings", {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ permissionMode }),
});

test("legacy permission PUT converges on the authoritative runtime profile", async () => {
  for (const [legacy, runtimeMode] of Object.entries(legacyToRuntime)) {
    const home = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "grok-settings-"));
    const calls = [];
    const runtime = {
      async applyRuntimeProfile(profile, store) {
        calls.push(profile.permissionMode);
        store.write(profile);
        return { status: "applied", profile };
      },
    };
    const response = await putGrokSettings(request(legacy), home, runtime);
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [runtimeMode]);
    assert.equal(readRuntimeProfile(home).permissionMode, runtimeMode);
    assert.equal((await getGrokSettings(home).json()).permissionMode, runtimeToLegacy(runtimeMode));
  }
});

test("legacy PUT delegates busy errors without writing a second permission source", async () => {
  const home = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "grok-settings-"));
  const runtime = { async applyRuntimeProfile() { throw Object.assign(new Error("Grok is busy"), { status: 409, code: "runtime_busy" }); } };
  const response = await putGrokSettings(request("auto"), home, runtime);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "runtime_busy");
  assert.equal(readRuntimeProfile(home).permissionMode, "default");
});

test("legacy GET keeps old config compatibility until a runtime profile exists", async () => {
  const home = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "grok-settings-"));
  await putGrokSettings(request(undefined), home, { async applyRuntimeProfile() { return { status: "applied" }; } });
  const response = getGrokSettings(home);
  assert.equal((await response.json()).permissionMode, "ask");
});
