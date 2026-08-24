import assert from "node:assert/strict";
import test from "node:test";
import { composerModelLabel, defaultGrokEffortLevel, defaultSettingsPickerId, grokLiveChatModels, mergeComposerModels, thinkingLevelsForComposerModel, visibleGrokEffortLevels } from "./composer-models.ts";
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

test("overlay does not copy official Grok efforts onto a custom Settings provider", () => {
  const withEfforts = {
    ...acp,
    thinkingLevels: { "grok:grok-4.6": ["xhigh", "high", "medium", "low"], "grok:grok-4.5": ["high", "medium", "low"] },
    thinkingLevelMaps: { "grok:grok-4.6": { high: "High Effort", xhigh: "Extra High Effort" } },
    thinkingLevelPins: { "grok/grok-4.6": "xhigh", "grok/grok-4.5": "high" },
  };
  const configText = `[model."grok-4.6"]\nmodel = "grok-4.6"\n`;
  const merged = mergeComposerModels(withEfforts, cpaSettings, (row) => grokSettingsPickerId(row, configText));
  assert.deepEqual(merged.thinkingLevels["grok:grok-4.6"], ["xhigh", "high", "medium", "low"]);
  assert.equal(merged.thinkingLevels["cpa:cpa/grok-4.6"], undefined);
  assert.equal(merged.thinkingLevelPins["cpa/cpa/grok-4.6"], undefined);
  assert.equal(merged.thinkingLevels["cpa:cpa/grok-4.5"], undefined);
  assert.equal(merged.thinkingLevelPins["cpa/cpa/grok-4.5"], undefined);
  assert.equal(merged.thinkingLevelPins["grok/grok-4.6"], "xhigh");
});

test("custom provider keeps ACP-advertised efforts without inheriting official xhigh", () => {
  const withEfforts = {
    ...acp,
    thinkingLevels: {
      "grok:grok-4.6": ["xhigh", "high", "medium", "low"],
      "cpa:cpa/grok-4.6": ["high", "medium", "low"],
    },
    thinkingLevelMaps: { "grok:grok-4.6": { high: "High Effort", xhigh: "Extra High Effort" } },
    thinkingLevelPins: { "grok/grok-4.6": "xhigh", "cpa/cpa/grok-4.6": "high" },
  };
  const merged = mergeComposerModels(withEfforts, cpaSettings);
  assert.deepEqual(merged.thinkingLevels["cpa:cpa/grok-4.6"], ["high", "medium", "low"]);
  assert.equal(merged.thinkingLevelPins["cpa/cpa/grok-4.6"], "high");
  assert.ok(!merged.thinkingLevels["cpa:cpa/grok-4.6"].includes("xhigh"));
});

test("visible Grok effort levels follow the advertised list", () => {
  assert.deepEqual(visibleGrokEffortLevels(["xhigh", "high", "medium", "low"]), ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(visibleGrokEffortLevels([]), []);
  assert.deepEqual(visibleGrokEffortLevels(["high", "medium", "low"]), ["low", "medium", "high"]);
  assert.ok(!visibleGrokEffortLevels(["high", "medium", "low"]).includes("auto"));
  assert.deepEqual(visibleGrokEffortLevels(["auto", "off", "minimal", "max", "high"]), ["off", "minimal", "high", "max", "auto"]);
  assert.deepEqual(visibleGrokEffortLevels(["auto", "off"]), ["off", "auto"]);
  assert.equal(defaultGrokEffortLevel(["low", "medium", "high", "xhigh"]), "high");
  assert.equal(defaultGrokEffortLevel(["low", "medium", "high", "xhigh"], "cpa/grok-4.6"), "xhigh");
  assert.equal(defaultGrokEffortLevel(["low", "medium", "high"]), "high");
});

test("Grok 4.6 keeps the official four efforts even if ACP only advertised the 4.5 trio", () => {
  assert.deepEqual(
    visibleGrokEffortLevels(["high", "medium", "low"], "grok-4.6"),
    ["low", "medium", "high", "xhigh"],
  );
  assert.ok(visibleGrokEffortLevels(["high", "medium", "low"], "cpa/grok-4.6").includes("xhigh"));
  assert.deepEqual(
    visibleGrokEffortLevels(["high", "medium", "low"], "cpa/grok-4.6"),
    ["low", "medium", "high", "xhigh"],
  );
});

test("namespaced grok-4.6 display ids still get the official four-effort floor", () => {
  assert.deepEqual(visibleGrokEffortLevels([], "cpa/grok-4.6"), ["low", "medium", "high", "xhigh"]);
  assert.ok(visibleGrokEffortLevels(["high", "medium", "low"], "grok-4.6").includes("xhigh"));
  assert.deepEqual(visibleGrokEffortLevels([]), []);
});

test("composer effort lookup follows the namespaced model when get_state used the grok provider", () => {
  assert.deepEqual(
    thinkingLevelsForComposerModel(
      { "cpa:cpa/grok-4.6": ["xhigh", "high", "medium", "low"] },
      "grok",
      "cpa/grok-4.6",
    ),
    ["xhigh", "high", "medium", "low"],
  );
});

test("official Grok CLI extras stay visible when ACP advertises them", () => {
  assert.deepEqual(
    visibleGrokEffortLevels(["none", "minimal", "low", "medium", "high", "xhigh", "max"], "grok-4.6"),
    ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
  );
});

test("live chat models in Settings are the Grok ACP rows", () => {
  assert.deepEqual(grokLiveChatModels([
    { id: "grok-4.6", name: "Grok 4.6", provider: "grok" },
    { id: "cpa/grok-4.6", name: "Grok 4.6", provider: "cpa" },
  ]).map((model) => model.id), ["grok-4.6"]);
});

test("composer drops ACP leftovers from a deleted Settings provider", () => {
  const merged = mergeComposerModels({
    ...acp,
    modelList: [
      ...acp.modelList,
      { id: "Cursor/grok-4.5", name: "Cursor Grok 4.5", provider: "Cursor" },
      { id: "Cursor/grok-4.6", name: "Cursor Grok 4.6", provider: "Cursor" },
    ],
  }, cpaSettings);
  assert.deepEqual(merged.modelList.map((model) => `${model.provider}:${model.id}`), [
    "grok:grok-4.5",
    "grok:grok-4.6",
    "cpa:cpa/grok-4.5",
    "cpa:cpa/grok-4.6",
    "cpa:cpa/grok-composer-2.5-fast",
  ]);
});

test("ACP models stay when Settings has no custom providers", () => {
  const merged = mergeComposerModels(acp, { providers: {} });
  assert.deepEqual(merged.modelList.map((model) => `${model.provider}:${model.id}`), [
    "grok:grok-4.5",
    "grok:grok-4.6",
  ]);
  assert.equal(merged.modelList[1].name, "Grok 4.6");
});

test("disconnected Grok hides the official catalog and keeps Settings providers", () => {
  const merged = mergeComposerModels(acp, cpaSettings, defaultSettingsPickerId, false);
  assert.deepEqual(merged.modelList.map((model) => `${model.provider}:${model.id}`), [
    "cpa:cpa/grok-4.5",
    "cpa:cpa/grok-4.6",
    "cpa:cpa/grok-composer-2.5-fast",
  ]);
  assert.equal(merged.defaultModel?.provider, "cpa");
  assert.equal(merged.defaultModel?.modelId, "cpa/grok-4.5");
  assert.equal(merged.models["grok:grok-4.6"], undefined);
});

test("disconnected Grok with no Settings providers leaves the composer empty", () => {
  const merged = mergeComposerModels(acp, { providers: {} }, defaultSettingsPickerId, false);
  assert.deepEqual(merged.modelList, []);
  assert.equal(merged.defaultModel, null);
  assert.deepEqual(merged.models, {});
});
