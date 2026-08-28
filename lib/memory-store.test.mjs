import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  appendRememberNote,
  assertSessionLogPath,
  pinMemoryEnabled,
  readMemoryEnabled,
  workspaceMemoryDir,
} from "./memory-store.ts";

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

test("workspaceMemoryDir uses origin org/repo slug and sha256[:8]", () => {
  const home = mkdtempSync(join(tmpdir(), "grok-memory-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "grok-memory-origin-"));
  execFileSync("git", ["init"], { cwd });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/widgets.git"], { cwd });
  const hash = createHash("sha256").update("acme/widgets", "utf8").digest("hex").slice(0, 8);
  assert.equal(workspaceMemoryDir(cwd, home), join(home, "memory", `acme-widgets-${hash}`));
});

test("workspaceMemoryDir falls back to the directory path when origin is missing", () => {
  const home = mkdtempSync(join(tmpdir(), "grok-memory-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "grok-memory-path-"));
  const hash = createHash("sha256").update(cwd, "utf8").digest("hex").slice(0, 8);
  const slug = cwd.replaceAll("/", "-").replace(/^-/, "");
  assert.equal(workspaceMemoryDir(cwd, home), join(home, "memory", `${slug}-${hash}`));
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
