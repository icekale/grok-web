import assert from "node:assert/strict";
import test from "node:test";
import { composerModelLabel, defaultGrokEffortLevel, grokLiveChatModels, mergeComposerModels, visibleGrokEffortLevels } from "./composer-models.ts";
import { grokSettingsPickerId } from "./grok-model-table.ts";

const acp = {
  models: { "grok:grok-4.5": "Grok 4.5", "grok:grok-4.6": "grok" },
  modelList: [
    { id: "grok-4.5", name: "Grok 4.5", provider: "grok" },
    { id: "grok-4.6", name: "grok", provider: "grok" },
  ],
  defaultModel: { provider: "grok", modelId: "grok-4.6" },
  thinkingLevels: {},
  thinkingLevelMaps: {},
  thinkingLevelPins: {},
};

const cpaSettings = {
  providers: {
    cpa: {
      models: [
        { id: "grok-4.5" },
        { id: "grok-4.6" },
        { id: "grok-composer-2.5-fast" },
      ],
    },
  },
};

test("composerModelLabel replaces a generic grok nickname with the model id", () => {
  assert.equal(composerModelLabel("grok-4.6", "grok"), "Grok 4.6");
  assert.equal(composerModelLabel("grok", "grok"), "Grok 4.6");
  assert.equal(composerModelLabel("cpa/grok-4.6", "grok"), "Grok 4.6");
  assert.equal(composerModelLabel("grok-4.5", "Grok 4.5"), "Grok 4.5");
  assert.equal(composerModelLabel("grok-composer-2.5-fast"), "Grok Composer 2.5 Fast");
});

test("ACP catalog stays first; cpa models use a distinct picker id", () => {
  const merged = mergeComposerModels(acp, cpaSettings);
  assert.deepEqual(merged.modelList.map((model) => `${model.provider}:${model.id}`), [
    "grok:grok-4.5",
    "grok:grok-4.6",
    "cpa:cpa/grok-4.5",
    "cpa:cpa/grok-4.6",
    "cpa:cpa/grok-composer-2.5-fast",
  ]);
  assert.equal(merged.defaultModel?.provider, "grok");
  assert.equal(merged.defaultModel?.modelId, "grok-4.6");
  assert.equal(merged.models["cpa:cpa/grok-4.5"], "Grok 4.5");
});

test("an existing Grok table stays official; cpa rows keep namespaced ids", () => {
  const configText = `[model."grok-4.6"]\nmodel = "grok-4.6"\nbase_url = "https://gateway.example/v1"\n`;
  const merged = mergeComposerModels(acp, cpaSettings, (row) => grokSettingsPickerId(row, configText));
  assert.deepEqual(merged.modelList.map((model) => `${model.provider}:${model.id}`), [
    "grok:grok-4.5",
    "grok:grok-4.6",
    "cpa:cpa/grok-4.5",
    "cpa:cpa/grok-4.6",
    "cpa:cpa/grok-composer-2.5-fast",
  ]);
  assert.equal(merged.defaultModel?.provider, "grok");
  assert.equal(merged.defaultModel?.modelId, "grok-4.6");
});

test("overlay remaps official Grok efforts onto the Settings provider key", () => {
  const withEfforts = {
    ...acp,
    thinkingLevels: { "grok:grok-4.6": ["xhigh", "high", "medium", "low"], "grok:grok-4.5": ["high", "medium", "low"] },
    thinkingLevelMaps: { "grok:grok-4.6": { high: "High Effort", xhigh: "Extra High Effort" } },
    thinkingLevelPins: { "grok/grok-4.6": "xhigh", "grok/grok-4.5": "high" },
  };
  const configText = `[model."grok-4.6"]\nmodel = "grok-4.6"\n`;
  const merged = mergeComposerModels(withEfforts, cpaSettings, (row) => grokSettingsPickerId(row, configText));
  assert.deepEqual(merged.thinkingLevels["grok:grok-4.6"], ["xhigh", "high", "medium", "low"]);
  assert.deepEqual(merged.thinkingLevels["cpa:cpa/grok-4.6"], ["xhigh", "high", "medium", "low"]);
  assert.equal(merged.thinkingLevelPins["cpa/cpa/grok-4.6"], "xhigh");
  assert.deepEqual(merged.thinkingLevels["cpa:cpa/grok-4.5"], ["high", "medium", "low"]);
  assert.equal(merged.thinkingLevelPins["cpa/cpa/grok-4.5"], "high");
});

test("visible Grok effort levels drop Pi auto/off extras", () => {
  assert.deepEqual(visibleGrokEffortLevels(["xhigh", "high", "medium", "low"]), ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(visibleGrokEffortLevels([]), ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(visibleGrokEffortLevels(["high", "medium", "low"]), ["low", "medium", "high"]);
  assert.ok(!visibleGrokEffortLevels(["high", "medium", "low"]).includes("auto"));
  assert.deepEqual(visibleGrokEffortLevels(["auto", "off", "minimal", "max", "high"]), ["high"]);
  assert.deepEqual(visibleGrokEffortLevels(["auto", "off"]), ["low", "medium", "high", "xhigh"]);
  assert.equal(defaultGrokEffortLevel(["low", "medium", "high", "xhigh"]), "xhigh");
  assert.equal(defaultGrokEffortLevel(["low", "medium", "high"]), "high");
});

test("live chat models in Settings are the Grok ACP rows", () => {
  assert.deepEqual(grokLiveChatModels([
    { id: "grok-4.6", name: "Grok 4.6", provider: "grok" },
    { id: "cpa/grok-4.6", name: "Grok 4.6", provider: "cpa" },
  ]).map((model) => model.id), ["grok-4.6"]);
});

test("ACP models stay when Settings has no custom providers", () => {
  const merged = mergeComposerModels(acp, { providers: {} });
  assert.deepEqual(merged.modelList.map((model) => `${model.provider}:${model.id}`), [
    "grok:grok-4.5",
    "grok:grok-4.6",
  ]);
  assert.equal(merged.modelList[1].name, "Grok 4.6");
});
