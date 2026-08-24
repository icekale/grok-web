import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { ensurePromptUsesVisibleModel, settingsFallbackFor } from "./session-model-retarget.ts";

function mockRuntime(model) {
  const calls = [];
  return {
    calls,
    send: async (sessionId, command) => {
      calls.push({ sessionId, command });
      if (command.type === "get_state") return { model };
      return { ok: true };
    },
  };
}

describe("ensurePromptUsesVisibleModel", () => {
  it("leaves the session alone when official Grok is connected", async () => {
    const runtime = mockRuntime({ provider: "grok", id: "grok-4.6" });
    await ensurePromptUsesVisibleModel(runtime, "sess", {
      officialConnected: async () => true,
      fallback: { provider: "cpa", modelId: "cpa/grok-4.6" },
    });
    assert.deepEqual(runtime.calls, []);
  });

  it("leaves a namespaced Settings model alone while official Grok is disconnected", async () => {
    const runtime = mockRuntime({ provider: "cpa", id: "cpa/grok-4.6" });
    await ensurePromptUsesVisibleModel(runtime, "sess", {
      officialConnected: async () => false,
      fallback: { provider: "cpa", modelId: "cpa/grok-4.5" },
    });
    assert.deepEqual(runtime.calls.map((call) => call.command.type), ["get_state"]);
  });

  it("agent routes retarget official models before a prompt", async () => {
    const sessionRoute = await readFile(new URL("../src/routes/api/agent/$id.ts", import.meta.url), "utf8");
    const newRoute = await readFile(new URL("../src/routes/api/agent/new.ts", import.meta.url), "utf8");
    const http = await readFile(new URL("./acp/http.ts", import.meta.url), "utf8");
    assert.match(sessionRoute, /ensurePromptUsesVisibleModel/);
    assert.match(newRoute, /ensurePromptUsesVisibleModel/);
    assert.match(http, /await options\.ensurePromptModel\?\.\(id\)/);
    assert.match(http, /loadSessionIfNeeded/);
  });

  it("prefers the Settings grok-4.6 row over the first 4.5 row", () => {
    assert.deepEqual(settingsFallbackFor("grok-4.5", [
      { providerId: "cpa", id: "grok-4.5", name: "Grok 4.5" },
      { providerId: "cpa", id: "grok-4.6", name: "Grok 4.6" },
    ]), { provider: "cpa", modelId: "cpa/grok-4.6" });
  });

  it("switches a leftover official model to the visible Settings fallback", async () => {
    const runtime = mockRuntime({ provider: "grok", id: "grok-4.6" });
    await ensurePromptUsesVisibleModel(runtime, "sess", {
      officialConnected: async () => false,
      fallback: { provider: "cpa", modelId: "cpa/grok-4.6" },
    });
    assert.deepEqual(runtime.calls.map((call) => call.command), [
      { type: "get_state" },
      { type: "set_model", provider: "cpa", modelId: "cpa/grok-4.6" },
    ]);
  });
});
