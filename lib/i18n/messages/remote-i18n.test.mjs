import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { enLocale } = await jiti.import("./en.ts");
const { zhCNLocale } = await jiti.import("./zh-CN.ts");

const REQUIRED = [
  "remote.nav",
  "remote.title",
  "remote.description",
  "remote.warning",
  "remote.listen",
  "remote.listenDescription",
  "remote.lanEnable",
  "remote.lanOn",
  "remote.lanOff",
  "remote.restartRequired",
  "remote.copy",
  "remote.copied",
  "remote.urls",
  "remote.urlsLanHint",
  "remote.advancedHosts",
  "remote.savedRestartHint",
  "remote.hosts",
  "remote.hostsDescription",
  "remote.hostPlaceholder",
  "remote.addHost",
  "remote.removeHost",
  "remote.envHost",
  "remote.password",
  "remote.passwordDescription",
  "remote.passwordSet",
  "remote.passwordUnset",
  "remote.newPassword",
  "remote.confirmPassword",
  "remote.keepPassword",
  "remote.removePassword",
  "remote.envWins",
  "remote.save",
  "remote.saving",
  "remote.reload",
  "remote.saved",
  "remote.savedAuthHint",
  "remote.help",
  "remote.loading",
  "remote.configError",
  "remote.passwordMismatch",
  "remote.error.invalid_hostname",
  "remote.error.password_required",
  "remote.error.password_invalid",
  "remote.error.cannot_disable_password_remotely",
  "remote.error.cannot_disable_lan_remotely",
];

test("en and zh-CN remote.* keys stay synchronized", () => {
  const enKeys = Object.keys(enLocale.messages).filter((key) => key.startsWith("remote.")).sort();
  const zhKeys = Object.keys(zhCNLocale.messages).filter((key) => key.startsWith("remote.")).sort();
  assert.deepEqual(zhKeys, enKeys);
  for (const key of REQUIRED) {
    assert.equal(typeof enLocale.messages[key], "string", key);
    assert.equal(typeof zhCNLocale.messages[key], "string", key);
  }
});

test("user-facing locale strings say Grok Web, not Pi Web", () => {
  for (const plugin of [enLocale, zhCNLocale]) {
    for (const [key, value] of Object.entries(plugin.messages)) {
      assert.doesNotMatch(value, /Pi Web/, `${plugin.id} ${key}`);
      assert.doesNotMatch(value, /\bPi\b/, `${plugin.id} ${key}`);
      assert.doesNotMatch(value, /\bpi default\b/i, `${plugin.id} ${key}`);
      assert.doesNotMatch(value, /pi\.example\.com/i, `${plugin.id} ${key}`);
    }
  }
});
