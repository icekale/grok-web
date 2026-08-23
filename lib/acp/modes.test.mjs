import assert from "node:assert/strict";
import test from "node:test";

const { readAcpModes } = await import("./modes.ts");

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
