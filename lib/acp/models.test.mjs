import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapGrokModels } from "./models.ts";

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
    assert.equal(data.models["grok:grok-4.6"], "grok");
  });
});
