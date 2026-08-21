import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { enLocale } = await jiti.import("./en.ts");
const { zhCNLocale } = await jiti.import("./zh-CN.ts");

test("English and zh-CN locale catalogs use the same keys", () => {
  const en = Object.keys(enLocale.messages).sort();
  const zh = Object.keys(zhCNLocale.messages).sort();
  const onlyEn = en.filter((key) => !zh.includes(key));
  const onlyZh = zh.filter((key) => !en.includes(key));
  assert.deepEqual({ onlyEn, onlyZh }, { onlyEn: [], onlyZh: [] });
});
