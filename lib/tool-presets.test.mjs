import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  TOOL_PRESET_VALUES,
  composerShowsToolPreset,
  getPresetFromTools,
  getToolNamesForPreset,
  isToolPreset,
} = await jiti.import("./tool-presets.ts");

test("keeps ACP config option ids and does not map Pi tool names", () => {
  assert.deepEqual([...TOOL_PRESET_VALUES], ["none", "read-only", "default", "full"]);
  assert.equal(isToolPreset("full"), true);
  assert.equal(isToolPreset("bash"), false);
  assert.deepEqual(getToolNamesForPreset("none"), []);
  assert.deepEqual(getToolNamesForPreset("read-only"), ["read-only"]);
  assert.deepEqual(getToolNamesForPreset("default"), ["default"]);
  assert.deepEqual(getToolNamesForPreset("full"), ["full"]);
});

test("reads the selected ACP preset id from active tool entries", () => {
  assert.equal(getPresetFromTools([]), "none");
  assert.equal(
    getPresetFromTools([{ name: "read-only", description: "read-only", active: true }]),
    "read-only",
  );
  assert.equal(
    getPresetFromTools([
      { name: "full", description: "full", active: true },
      { name: "web_search", description: "web_search", active: true },
    ]),
    "full",
  );
  assert.equal(
    getPresetFromTools([{ name: "bash", description: "bash", active: true }]),
    "default",
  );
});

test("hides the composer tool chip unless ACP advertised presets", () => {
  assert.equal(composerShowsToolPreset(["default", "full"]), true);
  assert.equal(composerShowsToolPreset([]), false);
});

test("returns fresh tool arrays that callers can safely modify", () => {
  const names = getToolNamesForPreset("read-only");
  names.push("custom");
  assert.deepEqual(getToolNamesForPreset("read-only"), ["read-only"]);
});
