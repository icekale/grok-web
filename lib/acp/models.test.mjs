import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapGrokModels, selectedGrokEffort, selectedGrokModelId } from "./models.ts";

describe("mapGrokModels", () => {
  it("maps ACP models into pi-web ModelsData", () => {
    const data = mapGrokModels({
      currentModelId: "grok-4.6",
      availableModels: [
        { modelId: "grok-4.6", name: "grok", _meta: { reasoningEfforts: [{ id: "xhigh" }, { id: "high" }] } },
        { modelId: "grok-4.5", name: "Grok 4.5", _meta: { reasoningEfforts: [{ id: "high" }] } },
      ],
    });
    assert.equal(data.defaultModel.provider, "grok");
    assert.equal(data.defaultModel.modelId, "grok-4.6");
    assert.ok(data.modelList.some((m) => m.provider === "grok" && m.id === "grok-4.5"));
    assert.deepEqual(data.thinkingLevels["grok:grok-4.6"], ["xhigh", "high"]);
    assert.equal(data.models["grok:grok-4.6"], "Grok 4.6");
  });

  it("keeps official Grok effort labels and pins the advertised current effort", () => {
    const data = mapGrokModels({
      currentModelId: "grok-4.6",
      availableModels: [
        {
          modelId: "grok-4.6",
          name: "grok",
          _meta: {
            reasoningEffort: "xhigh",
            reasoningEfforts: [
              { id: "xhigh", label: "Extra High Effort", default: false },
              { id: "high", label: "High Effort", default: true },
              { id: "medium", label: "Medium Effort" },
              { id: "low", label: "Low Effort" },
            ],
          },
        },
      ],
    });
    assert.deepEqual(data.thinkingLevels["grok:grok-4.6"], ["xhigh", "high", "medium", "low"]);
    assert.equal(data.thinkingLevelMaps["grok:grok-4.6"].xhigh, "Extra High Effort");
    assert.equal(data.thinkingLevelMaps["grok:grok-4.6"].high, "High Effort");
    assert.equal(data.thinkingLevelPins["grok/grok-4.6"], "xhigh");
  });

  it("groups namespaced custom models by the provider prefix", () => {
    const data = mapGrokModels({
      currentModelId: "cpa/grok-4.5",
      availableModels: [
        { modelId: "grok-4.5", name: "Grok 4.5" },
        { modelId: "cpa/grok-4.5", name: "Grok 4.5" },
      ],
    });
    assert.deepEqual(data.modelList.map((m) => `${m.provider}:${m.id}`), [
      "grok:grok-4.5",
      "cpa:cpa/grok-4.5",
    ]);
    assert.equal(data.defaultModel.provider, "cpa");
    assert.equal(data.defaultModel.modelId, "cpa/grok-4.5");
  });

  it("reads the selected official effort from session/new metadata", () => {
    const created = {
      sessionId: "s1",
      _meta: {
        "x.ai/sessionDetail": { currentModelId: "grok-4.6" },
        "x.ai/sessionConfig": {
          options: [
            { id: "grok-4.6", category: "model", selected: true },
            { id: "xhigh", category: "mode", label: "Extra High Effort", selected: true },
            { id: "high", category: "mode", label: "High Effort", selected: false },
          ],
        },
      },
    };
    assert.equal(selectedGrokEffort(created), "xhigh");
    assert.equal(selectedGrokModelId(created), "grok-4.6");
  });
});
