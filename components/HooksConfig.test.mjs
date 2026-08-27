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
