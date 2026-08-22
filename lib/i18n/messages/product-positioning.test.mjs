import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { enLocale } = await jiti.import("./en.ts");
const { zhCNLocale } = await jiti.import("./zh-CN.ts");

const deadKeys = [
  "sidebar.exportSession",
  "sidebar.renameCommand",
  "sidebar.deleteCommand",
  "chat.commandName",
];

test("Models copy describes Grok Build accounts, ACP models, and provider configuration", () => {
  assert.equal(
    enLocale.messages["models.pageSubtitle"],
    "Grok Build account, ACP models, and provider configuration",
  );
  assert.equal(
    enLocale.messages["models.customProvidersHint"],
    "Import and test providers stored in Grok Build's models.json. Live chat models still come from Grok ACP.",
  );
  assert.equal(
    zhCNLocale.messages["models.pageSubtitle"],
    "Grok Build 账号、ACP 模型和 Provider 配置",
  );
  assert.equal(
    zhCNLocale.messages["models.customProvidersHint"],
    "导入并测试 Grok Build models.json 中的 Provider；当前对话的模型仍来自 Grok ACP。",
  );
});

test("removed session controls leave no dead locale keys", () => {
  for (const key of deadKeys) {
    assert.equal(key in enLocale.messages, false, `English still contains ${key}`);
    assert.equal(key in zhCNLocale.messages, false, `zh-CN still contains ${key}`);
  }
});
