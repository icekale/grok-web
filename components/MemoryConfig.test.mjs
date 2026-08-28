import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("tools settings include Memory and /memory opens it", async () => {
  const settings = await readFile(new URL("./SettingsPage.tsx", import.meta.url), "utf8");
  const input = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  const session = await readFile(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");
  const shell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  const memory = await readFile(new URL("./MemoryConfig.tsx", import.meta.url), "utf8");
  assert.match(settings, /"memory"/);
  assert.match(input, /name: "memory"/);
  assert.match(input, /name: "remember"/);
  assert.doesNotMatch(input, /name: "flush"/);
  assert.match(session, /onOpenSettings\?\.\("memory"\)/);
  assert.match(session, /queueRememberNote\(args\)/);
  assert.match(memory, /takeQueuedRememberNote/);
  assert.match(memory, /memory\.flushTui/);
  assert.match(shell, /section === "memory"/);
});
