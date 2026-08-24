import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  defaultGrokEffortLevel,
  grokEffortFamily,
  persistedReasoningEffort,
  resolvedGrokEffort,
  shouldRespawnForEffort,
  visibleGrokEffortLevels,
} from "./grok-effort-levels.ts";

describe("grokEffortFamily", () => {
  it("classifies official, namespaced, and effortless models", () => {
    assert.equal(grokEffortFamily("grok-4.6"), "grok-4.6");
    assert.equal(grokEffortFamily("cpa/grok-4.6"), "grok-4.6");
    assert.equal(grokEffortFamily("grok-4.5"), "grok-4.5");
    assert.equal(grokEffortFamily("cpa/grok-4.5"), "grok-4.5");
    assert.equal(grokEffortFamily("cpa/grok-imagine-image-2.0"), "none");
    assert.equal(grokEffortFamily("cpa/grok-composer-2.5-fast"), "none");
    assert.equal(grokEffortFamily(undefined), "none");
  });
});

describe("resolvedGrokEffort", () => {
  it("uses the official catalog default for un-namespaced grok-4.6", () => {
    assert.equal(resolvedGrokEffort({ modelId: "grok-4.6" }), "high");
  });

  it("uses the generated table default for namespaced grok-4.6", () => {
    assert.equal(resolvedGrokEffort({ modelId: "cpa/grok-4.6" }), "xhigh");
  });

  it("defaults grok-4.5 official and custom to high and never invents xhigh", () => {
    assert.equal(resolvedGrokEffort({ modelId: "grok-4.5" }), "high");
    assert.equal(resolvedGrokEffort({ modelId: "cpa/grok-4.5" }), "high");
    assert.equal(resolvedGrokEffort({ persisted: "xhigh", modelId: "cpa/grok-4.5" }), "high");
    assert.equal(resolvedGrokEffort({ selected: "xhigh", modelId: "grok-4.5" }), "high");
  });

  it("keeps a selected effort that the new model still advertises", () => {
    assert.equal(resolvedGrokEffort({ selected: "low", modelId: "cpa/grok-4.6" }), "low");
    assert.equal(resolvedGrokEffort({ selected: "high", modelId: "cpa/grok-4.6" }), "high");
    assert.equal(resolvedGrokEffort({ selected: "medium", modelId: "grok-4.5" }), "medium");
    assert.equal(resolvedGrokEffort({ selected: "off", modelId: "grok-4.6" }), "off");
  });

  it("prefers persisted session effort over ACP selected low when both are legal", () => {
    assert.equal(resolvedGrokEffort({ persisted: "xhigh", selected: "low", modelId: "cpa/grok-4.6" }), "xhigh");
    assert.equal(resolvedGrokEffort({ persisted: "high", selected: "low", modelId: "grok-4.6" }), "high");
  });

  it("does not send effort for imagine or composer", () => {
    assert.equal(resolvedGrokEffort({ modelId: "cpa/grok-imagine-image-2.0" }), undefined);
    assert.equal(resolvedGrokEffort({ selected: "xhigh", modelId: "cpa/grok-composer-2.5-fast" }), undefined);
  });

  it("without a model id uses a concrete selection or the official catalog default", () => {
    assert.equal(resolvedGrokEffort({ selected: "low" }), "low");
    assert.equal(resolvedGrokEffort({}), "high");
    assert.equal(resolvedGrokEffort({ selected: "", persisted: "" }), "high");
  });
});

describe("visibleGrokEffortLevels", () => {
  it("floors grok-4.5 to the official trio and grok-4.6 to four levels", () => {
    assert.deepEqual(visibleGrokEffortLevels([], "cpa/grok-4.5"), ["low", "medium", "high"]);
    assert.deepEqual(visibleGrokEffortLevels([], "grok-4.5"), ["low", "medium", "high"]);
    assert.deepEqual(visibleGrokEffortLevels([], "cpa/grok-4.6"), ["low", "medium", "high", "xhigh"]);
    assert.deepEqual(visibleGrokEffortLevels([], "cpa/grok-imagine-image-2.0"), []);
    assert.deepEqual(visibleGrokEffortLevels([]), []);
  });
});

describe("defaultGrokEffortLevel", () => {
  it("follows the model family instead of always picking the highest advertised level", () => {
    assert.equal(defaultGrokEffortLevel(["low", "medium", "high", "xhigh"], "grok-4.6"), "high");
    assert.equal(defaultGrokEffortLevel(["low", "medium", "high", "xhigh"], "cpa/grok-4.6"), "xhigh");
    assert.equal(defaultGrokEffortLevel(["low", "medium", "high"], "cpa/grok-4.5"), "high");
  });
});

describe("persistedReasoningEffort", () => {
  it("reads summary.json reasoning_effort and ignores junk", () => {
    assert.equal(persistedReasoningEffort({ reasoning_effort: "xhigh" }), "xhigh");
    assert.equal(persistedReasoningEffort({ reasoning_effort: "low" }), "low");
    assert.equal(persistedReasoningEffort({ reasoning_effort: "nope" }), undefined);
    assert.equal(persistedReasoningEffort({}), undefined);
  });
});

describe("shouldRespawnForEffort", () => {
  it("recycles only when the spawn fallback would disagree with the session", () => {
    assert.equal(shouldRespawnForEffort(undefined, "xhigh"), true);
    assert.equal(shouldRespawnForEffort("xhigh", "xhigh"), false);
    assert.equal(shouldRespawnForEffort("xhigh", "high"), true);
    assert.equal(shouldRespawnForEffort("xhigh", undefined), true);
    assert.equal(shouldRespawnForEffort(undefined, undefined), false);
  });
});
