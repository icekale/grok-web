import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendRememberNote, assertSessionLogPath, pinMemoryEnabled, readMemoryEnabled } from "./memory-store.ts";

test("pinMemoryEnabled writes [memory] enabled without dropping other tables", () => {
  const next = pinMemoryEnabled("[models]\ndefault = \"grok-4.6\"\n", true);
  assert.match(next, /\[memory\]\s*\nenabled = true/);
  assert.match(next, /\[models\]/);
  assert.equal(readMemoryEnabled(next), true);
  assert.equal(readMemoryEnabled(pinMemoryEnabled(next, false)), false);
});

test("appendRememberNote adds a dated markdown note", () => {
  const dir = mkdtempSync(join(tmpdir(), "grok-memory-"));
  const file = join(dir, "MEMORY.md");
  appendRememberNote(file, "always open PRs", new Date("2026-08-25T00:00:00Z"));
  const text = readFileSync(file, "utf8");
  assert.match(text, /2026-08-25/);
  assert.match(text, /always open PRs/);
});

test("assertSessionLogPath allows only session logs", () => {
  const root = mkdtempSync(join(tmpdir(), "grok-memory-home-"));
  const sessions = join(root, "memory", "proj-abcd1234", "sessions");
  mkdirSync(sessions, { recursive: true });
  const log = join(sessions, "2026-08-25.md");
  writeFileSync(log, "x");
  const memoryFile = join(root, "memory", "MEMORY.md");
  writeFileSync(memoryFile, "keep");
  assert.equal(assertSessionLogPath(log, root), realpathSync(log));
  assert.throws(() => assertSessionLogPath(memoryFile, root), /session/i);
});
