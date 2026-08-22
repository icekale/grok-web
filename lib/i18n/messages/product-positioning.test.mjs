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
  "models.customProvidersHint",
  "models.liveChatHint",
];

test("Models copy describes Grok Build accounts, ACP models, and provider configuration", () => {
  assert.equal(
    enLocale.messages["models.pageSubtitle"],
    "Grok Build account, ACP models, and provider configuration",
  );
  assert.equal(
    zhCNLocale.messages["models.pageSubtitle"],
    "Grok Build 账号、ACP 模型和 Provider 配置",
  );
});

test("removed session controls leave no dead locale keys", () => {
  for (const key of deadKeys) {
    assert.equal(key in enLocale.messages, false, `English still contains ${key}`);
    assert.equal(key in zhCNLocale.messages, false, `zh-CN still contains ${key}`);
  }
});
