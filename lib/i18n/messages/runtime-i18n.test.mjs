import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { enLocale } = await jiti.import("./en.ts");
const { zhCNLocale } = await jiti.import("./zh-CN.ts");

const REQUIRED = [
  "runtime.nav",
  "runtime.title",
  "runtime.description",
  "runtime.agent",
  "runtime.agentDefault",
  "runtime.agentProfilePath",
  "runtime.agentProfilePlaceholder",
  "runtime.sandbox",
  "runtime.maxTurns",
  "runtime.rules",
  "runtime.allow",
  "runtime.deny",
  "runtime.disableWebSearch",
  "runtime.disableSubagents",
  "runtime.apply",
  "runtime.confirmRestart",
];

test("en and zh-CN runtime.* keys stay synchronized", () => {
  const enKeys = Object.keys(enLocale.messages).filter((key) => key.startsWith("runtime.")).sort();
  const zhKeys = Object.keys(zhCNLocale.messages).filter((key) => key.startsWith("runtime.")).sort();
  assert.deepEqual(zhKeys, enKeys);
  for (const key of REQUIRED) {
    assert.equal(typeof enLocale.messages[key], "string", key);
    assert.equal(typeof zhCNLocale.messages[key], "string", key);
  }
});
