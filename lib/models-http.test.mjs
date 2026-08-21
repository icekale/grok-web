import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const source = await readFile(new URL("./models-http.ts", import.meta.url), "utf8");
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false });

test("models GET recycles ACP after writing settings models and if composer models are missing", () => {
  assert.match(source, /const wrote = syncSettingsModelsToGrokConfig\(settings\)/);
  assert.match(source, /if \(wrote\.length > 0\) await getAgentRuntime\(\)\.recycleProcess\(\)/);
  assert.match(source, /collectSettingsComposerModels\(settings\)/);
  assert.match(source, /if \(needed\.some\(\(id\) => !have\.has\(id\)\)\)/);
  assert.match(source, /listed = await getAgentRuntime\(\)\.listModels\(\)/);
});

test("GET /api/models recycles when settings composer models are missing from the first list", async () => {
  const root = mkdtempSync(join(tmpdir(), "grok-models-recycle-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  mkdirSync(home);
  mkdirSync(cwd);
  writeFileSync(join(home, "models.json"), JSON.stringify({
    providers: {
      custom: {
        baseUrl: "https://example.invalid/v1",
        api: "openai-completions",
        models: [{ id: "extra-model", name: "Extra" }],
      },
    },
  }));

  const previousHome = process.env.GROK_HOME;
  process.env.GROK_HOME = home;
  globalThis.__piAdditionalAllowedRoots ??= new Set();
  globalThis.__piAdditionalAllowedRoots.add(cwd);
  globalThis.__piAllowedRootsCache = undefined;

  const { setAgentRuntime, resetAgentRuntime } = await jiti.import("./acp/runtime.ts");
  const { invalidateModelsCache } = await jiti.import("./models-cache.ts");
  const calls = [];
  setAgentRuntime({
    recycleProcess: async () => {
      calls.push("recycle");
    },
    listModels: async () => {
      calls.push("list");
      if (calls.filter((call) => call === "list").length === 1) {
        return { models: {}, modelList: [], defaultModel: null, thinkingLevels: {}, thinkingLevelMaps: {}, thinkingLevelPins: {} };
      }
      return {
        models: {},
        modelList: [{ id: "custom/extra-model", name: "Extra", provider: "custom" }],
        defaultModel: null,
        thinkingLevels: {},
        thinkingLevelMaps: {},
        thinkingLevelPins: {},
      };
    },
  });
  invalidateModelsCache();

  try {
    const { GET } = await jiti.import("./models-http.ts");
    const res = await GET(new Request(`http://127.0.0.1/api/models?cwd=${encodeURIComponent(cwd)}`));
    assert.equal(res.status, 200, await res.clone().text());
    assert.ok(calls.includes("recycle"), `recycleProcess not called: ${calls.join(",")}`);
    assert.ok(calls.filter((call) => call === "list").length >= 2, `listModels not retried: ${calls.join(",")}`);
  } finally {
    resetAgentRuntime();
    globalThis.__piAdditionalAllowedRoots.delete(cwd);
    globalThis.__piAllowedRootsCache = undefined;
    if (previousHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = previousHome;
  }
});
