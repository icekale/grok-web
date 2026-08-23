import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_RUNTIME_PROFILE } from "./runtime-profile.ts";

const { createRuntimeProfileHandlers } = await import("./runtime-profile-http.ts");

function request(method, body) {
  return new Request("http://127.0.0.1/api/runtime-profile", {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("GET returns authoritative profile and capability snapshot", async () => {
  const handlers = createRuntimeProfileHandlers({
    readProfile: () => DEFAULT_RUNTIME_PROFILE,
    discover: async () => ({ version: "1", globalFlags: new Set(["--sandbox"]), agentFlags: new Set(), stdioFlags: new Set(), agents: [], warnings: [] }),
  });
  const response = await handlers.GET(request("GET"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.profile, DEFAULT_RUNTIME_PROFILE);
  assert.equal(body.capabilities.globalFlags.includes("--sandbox"), true);
  assert.equal(body.restartRequired, false);
});

test("PUT rejects invalid JSON profile and maps busy/apply statuses", async () => {
  let stored = DEFAULT_RUNTIME_PROFILE;
  let mode = "applied";
  const handlers = createRuntimeProfileHandlers({
    readProfile: () => stored,
    writeProfile: (next) => { stored = next; },
    apply: async (next) => mode === "busy" ? (() => { const error = new Error("busy"); error.status = 409; error.code = "runtime_busy"; throw error; })() : { status: "applied", profile: next },
    discover: async () => ({ version: "1", globalFlags: new Set(), agentFlags: new Set(), stdioFlags: new Set(), agents: [], warnings: [] }),
  });
  const invalid = await handlers.PUT(request("PUT", { ...DEFAULT_RUNTIME_PROFILE, apiKey: "secret" }));
  assert.equal(invalid.status, 400);
  mode = "busy";
  const busy = await handlers.PUT(request("PUT", { ...DEFAULT_RUNTIME_PROFILE, permissionMode: "plan" }));
  assert.equal(busy.status, 409);
  mode = "applied";
  const applied = await handlers.PUT(request("PUT", { ...DEFAULT_RUNTIME_PROFILE, permissionMode: "plan" }));
  assert.equal(applied.status, 200);
  assert.equal((await applied.json()).status, "applied");
});
