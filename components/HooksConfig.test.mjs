import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("tools settings include Hooks and /hooks opens it", async () => {
  const settings = await readFile(new URL("./SettingsPage.tsx", import.meta.url), "utf8");
  const input = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  const session = await readFile(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");
  assert.match(settings, /"hooks"/);
  assert.match(input, /name: "hooks"/);
  assert.match(session, /onOpenSettings\?\.\("hooks"\)/);
});

test("hooks hide Trust when folder-trust is ungated", async () => {
  const source = await readFile(new URL("./HooksConfig.tsx", import.meta.url), "utf8");
  assert.match(source, /folderTrustEnabled/);
  assert.match(source, /hooks\.ungated/);
});

test("hooks groups stack as a heading plus archived list, not a form row", async () => {
  const source = await readFile(new URL("./HooksConfig.tsx", import.meta.url), "utf8");
  assert.match(source, /className="settings-hook-group"/);
  assert.match(source, /className="settings-archived-list"/);
  assert.match(source, /className="settings-form-actions"/);
  assert.doesNotMatch(source, /<section key=\{entry\.group\} className="settings-form-section">/);
});
