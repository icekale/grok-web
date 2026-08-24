import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configHasModelSection, grokSettingsPickerId, renderGrokModelTable, syncSettingsModelsToGrokConfig } from "./grok-model-table.ts";

test("picker id always namespaces Settings provider rows", () => {
  const configText = `[model."grok-4.6"]\nmodel = "grok-4.6"\n`;
  assert.equal(grokSettingsPickerId({ providerId: "cpa", id: "grok-4.6", name: "Grok 4.6" }, configText), "cpa/grok-4.6");
  assert.equal(grokSettingsPickerId({ providerId: "cpa", id: "grok-4.5", name: "Grok 4.5" }, configText), "cpa/grok-4.5");
});

test("custom Grok 4.6 tables preserve exactly its four reasoning efforts", () => {
  const table = renderGrokModelTable({ providerId: "cpa", id: "grok-4.6", name: "Grok 4.6" });
  assert.match(table, /supports_reasoning_effort = true/);
  assert.deepEqual(
    [...table.matchAll(/\{ id = "([^"]+)", value = "([^"]+)", label = "([^"]+)", default = (true|false) \}/g)]
      .map((match) => match.slice(1)),
    [
      ["xhigh", "xhigh", "Extra High Effort", "false"],
      ["high", "high", "High Effort", "true"],
      ["medium", "medium", "Medium Effort", "false"],
      ["low", "low", "Low Effort", "false"],
    ],
  );
});

test("sync preserves absent namespaced tables because current settings cannot prove ownership", () => {
  const home = mkdtempSync(join(tmpdir(), "grok-model-table-prune-"));
  writeFileSync(join(home, "config.toml"), [
    `[model."grok-4.6"]`,
    `model = "grok-4.6"`,
    `base_url = "https://existing.example/v1"`,
    ``,
    `[model."Cursor/grok-4.5"]`,
    `model = "grok-4.5"`,
    `name = "Cursor Grok 4.5"`,
    `base_url = "http://192.168.5.28:18086/v1"`,
    ``,
    `[model."cpa/grok-4.6"]`,
    `model = "grok-4.6"`,
    `base_url = "https://gateway.example/v1"`,
    ``,
    `[cli]`,
    `theme = "dark"`,
    ``,
  ].join("\n"));
  const changed = syncSettingsModelsToGrokConfig({
    providers: {
      cpa: {
        api: "openai-responses",
        baseUrl: "https://gateway.example/v1",
        models: [{ id: "grok-4.6" }],
      },
    },
  }, home);
  assert.deepEqual(changed, ["cpa/grok-4.6"]);
  const text = readFileSync(join(home, "config.toml"), "utf8");
  assert.match(text, /\[model\."grok-4\.6"\][\s\S]*base_url = "https:\/\/existing\.example\/v1"/);
  assert.match(text, /\[model\."cpa\/grok-4\.6"\]/);
  assert.match(text, /\[cli\][\s\S]*theme = "dark"/);
  assert.match(text, /\[model\."Cursor\/grok-4\.5"\][\s\S]*base_url = "http:\/\/192\.168\.5\.28:18086\/v1"/);
});

test("sync preserves namespaced tables when Settings has no custom providers", () => {
  const home = mkdtempSync(join(tmpdir(), "grok-model-table-prune-empty-"));
  writeFileSync(join(home, "config.toml"), `[model."Cursor/grok-4.6"]\nmodel = "grok-4.6"\n[cli]\ntheme = "dark"\n`);
  const changed = syncSettingsModelsToGrokConfig({ providers: {} }, home);
  assert.deepEqual(changed, []);
  const text = readFileSync(join(home, "config.toml"), "utf8");
  assert.match(text, /\[model\."Cursor\/grok-4\.6"\][\s\S]*model = "grok-4\.6"/);
  assert.match(text, /\[cli\]/);
});

test("sync repairs only the current managed section and preserves unknown bytes", () => {
  const home = mkdtempSync(join(tmpdir(), "grok-model-repair-"));
  const unknown = `  [model."manual/model"] # preserve header whitespace/comment
model = "manual"
custom = "keep-byte-for-byte"



[model."former-provider/former-model"]
model = "former-model"
custom = "not-provably-settings-managed"

`;
  writeFileSync(join(home, "config.toml"), `${unknown}[model."cpa/grok-4.6"]
model = "grok-4.6"
base_url = "https://old.example/v1"
`);
  syncSettingsModelsToGrokConfig({ providers: { cpa: {
    api: "openai-responses",
    baseUrl: "https://new.example/v1",
    apiKey: "restored-key",
    models: [{ id: "grok-4.6" }],
  } } }, home);
  const text = readFileSync(join(home, "config.toml"), "utf8");
  assert.equal(text.slice(0, unknown.length), unknown);
  assert.match(text, /\[model\."cpa\/grok-4\.6"\][\s\S]*base_url = "https:\/\/new\.example\/v1"/);
  assert.match(text, /api_key = "restored-key"/);
  assert.equal((text.match(/\[model\."cpa\/grok-4\.6"\]/g) ?? []).length, 1);
});

test("sync is idempotent for an unchanged managed section", () => {
  const home = mkdtempSync(join(tmpdir(), "grok-model-table-idempotent-"));
  const current = `${renderGrokModelTable({
    providerId: "cpa",
    id: "grok-4.6",
    name: "Grok 4.6",
    api: "openai-responses",
    baseUrl: "https://gateway.example/v1",
    apiKey: "test-key",
  })}\n[cli]\ntheme = "dark"\n`;
  writeFileSync(join(home, "config.toml"), current);
  const changed = syncSettingsModelsToGrokConfig({ providers: { cpa: {
    api: "openai-responses",
    baseUrl: "https://gateway.example/v1",
    apiKey: "test-key",
    models: [{ id: "grok-4.6", name: "Grok 4.6" }],
  } } }, home);
  assert.deepEqual(changed, []);
  assert.equal(readFileSync(join(home, "config.toml"), "utf8"), current);
});

test("sync is idempotent for unchanged CRLF managed sections", () => {
  const home = mkdtempSync(join(tmpdir(), "grok-model-table-crlf-"));
  const current = `${renderGrokModelTable({
    providerId: "cpa",
    id: "grok-4.6",
    name: "Grok 4.6",
    api: "openai-responses",
    baseUrl: "https://gateway.example/v1",
    apiKey: "test-key",
  })}\n[cli]\ntheme = "dark"\n`.replaceAll("\n", "\r\n");
  writeFileSync(join(home, "config.toml"), current);
  const changed = syncSettingsModelsToGrokConfig({ providers: { cpa: {
    api: "openai-responses",
    baseUrl: "https://gateway.example/v1",
    apiKey: "test-key",
    models: [{ id: "grok-4.6", name: "Grok 4.6" }],
  } } }, home);
  assert.deepEqual(changed, []);
  assert.equal(readFileSync(join(home, "config.toml"), "utf8"), current);
});

test("sync writes namespaced cpa tables and leaves an existing grok-4.6 override", () => {
  const home = mkdtempSync(join(tmpdir(), "grok-model-table-"));
  writeFileSync(join(home, "config.toml"), `[model."grok-4.6"]\nmodel = "grok-4.6"\nbase_url = "https://existing.example/v1"\n`);
  const wrote = syncSettingsModelsToGrokConfig({
    providers: {
      cpa: {
        api: "openai-responses",
        baseUrl: "https://gateway.example/v1",
        apiKey: "test-key",
        models: [{ id: "grok-4.6" }, { id: "grok-4.5", contextWindow: 500000 }],
      },
    },
  }, home);
  assert.deepEqual(wrote, ["cpa/grok-4.6", "cpa/grok-4.5"]);
  const text = readFileSync(join(home, "config.toml"), "utf8");
  assert.match(text, /\[model\."grok-4\.6"\][\s\S]*base_url = "https:\/\/existing\.example\/v1"/);
  assert.match(text, /\[model\."cpa\/grok-4\.6"\]/);
  assert.match(text, /\[model\."cpa\/grok-4\.5"\]/);
  assert.match(text, /model = "grok-4\.5"/);
  assert.doesNotMatch(text, /\[model\."grok-4\.5"\]/);
  assert.match(text, /base_url = "https:\/\/gateway\.example\/v1"/);
  assert.match(text, /api_backend = "responses"/);
  assert.equal(configHasModelSection(text, "cpa/grok-4.5"), true);
  assert.equal(configHasModelSection(text, "grok-4.5"), false);
});
