import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  advertisedToolPresets,
  applyConfigOptionUpdate,
  hasToolsConfig,
  readAcpConfigOptions,
  selectedToolsPreset,
  toolEntriesForPreset,
} from "./config-options.ts";

describe("ACP config options", () => {
  it("reads standard configOptions and Grok sessionConfig metadata", () => {
    const options = readAcpConfigOptions({
      configOptions: [{ id: "tools", currentValue: "default" }],
      _meta: {
        "x.ai/sessionConfig": {
          options: [
            { id: "high", category: "mode", selected: true },
            { id: "full", category: "tools", selected: false },
          ],
        },
      },
    });
    assert.equal(hasToolsConfig(options), true);
    assert.equal(selectedToolsPreset(options), "default");
  });

  it("uses the selected Grok tools category when no currentValue is present", () => {
    const options = readAcpConfigOptions({
      _meta: {
        "x.ai/sessionConfig": {
          options: [
            { id: "read-only", category: "tools", selected: true },
            { id: "full", category: "tools", selected: false },
          ],
        },
      },
    });
    assert.equal(selectedToolsPreset(options), "read-only");
  });

  it("applies a config_option_update to the cached tools value", () => {
    const next = applyConfigOptionUpdate(
      [{ id: "tools", currentValue: "default" }],
      { sessionUpdate: "config_option_update", id: "tools", value: "full" },
    );
    assert.equal(selectedToolsPreset(next), "full");
    assert.deepEqual(toolEntriesForPreset("full"), [{ name: "full", description: "full", active: true }]);
    assert.deepEqual(toolEntriesForPreset("none"), []);
  });

  it("lists only ACP-declared tool preset ids", () => {
    assert.deepEqual(advertisedToolPresets([{ id: "tools", currentValue: "default" }]), []);
    assert.deepEqual(
      advertisedToolPresets([{
        id: "tools",
        currentValue: "default",
        options: [
          { value: "read-only" },
          { value: "full" },
          { value: "bash" },
        ],
      }]),
      ["read-only", "full"],
    );
    assert.deepEqual(
      advertisedToolPresets([
        { id: "read-only", category: "tools", selected: true },
        { id: "full", category: "tools", selected: false },
      ]),
      ["read-only", "full"],
    );
  });
});
