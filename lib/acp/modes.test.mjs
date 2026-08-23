import assert from "node:assert/strict";
import test from "node:test";

const { readAcpCurrentModeUpdate, readAcpModeState, readAcpModes } = await import("./modes.ts");

test("reads ACP current mode updates", () => {
  assert.equal(readAcpCurrentModeUpdate({ sessionUpdate: "current_mode_update", currentModeId: "auto" }), "auto");
  assert.equal(readAcpCurrentModeUpdate({ sessionUpdate: "plan", currentModeId: "plan" }), null);
});

test("reads the ACP v1 singular mode field", () => {
  assert.deepEqual(readAcpModes({ mode: { currentModeId: "plan", availableModes: [{ id: "default", name: "Normal" }, { id: "plan", name: "Plan" }] } }), {
    current: "plan",
    available: [{ id: "default", name: "Normal" }, { id: "plan", name: "Plan" }],
  });
});

test("reads permission modes from a standard ACP config option", () => {
  assert.deepEqual(readAcpModeState({ configOptions: [{
    id: "permission_mode",
    currentValue: "auto",
    options: [
      { value: "default", name: "Normal" },
      { value: "auto", name: "Auto" },
      { value: "bypassPermissions", name: "Always-approve" },
    ],
  }] }), {
    modes: {
      current: "auto",
      available: [
        { id: "default", name: "Normal" },
        { id: "auto", name: "Auto" },
        { id: "bypassPermissions", name: "Always-approve" },
      ],
    },
    source: { type: "config", configId: "permission_mode" },
  });
});

test("reads only standard advertised ACP modes", () => {
  assert.deepEqual(readAcpModes({ modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }] } }), {
    current: "default",
    available: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }],
  });
});

test("rejects malformed or extension-widget mode shapes", () => {
  assert.deepEqual(readAcpModes({ modes: { currentModeId: 1, availableModes: [{ id: "plan" }, { id: "x", name: 4 }] } }), { current: null, available: [] });
  assert.deepEqual(readAcpModes({ widgets: [{ id: "plan", name: "Plan" }] }), { current: null, available: [] });
});
