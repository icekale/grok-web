import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { encodeTrustedFolders, readFolderTrust, trustFolder, untrustFolder } from "./folder-trust.ts";

test("encodeTrustedFolders refuses home and filesystem root", () => {
  assert.throws(() => encodeTrustedFolders(["/"]), /over-broad/i);
  assert.throws(() => encodeTrustedFolders([homedir()]), /over-broad/i);
  assert.throws(() => encodeTrustedFolders(["relative"]), /over-broad/i);
});

test("trustFolder and untrustFolder round-trip a project path", () => {
  const home = mkdtempSync(join(tmpdir(), "grok-trust-home-"));
  const project = "/Users/someone/project";
  trustFolder(project, home);
  const stored = readFolderTrust(home);
  assert.deepEqual(stored, [project]);
  const text = readFileSync(join(home, "trusted_folders.toml"), "utf8");
  assert.match(text, /\[\[folders\]\]/);
  assert.match(text, /path = "\/Users\/someone\/project"/);
  assert.match(text, /decided_at = "/);
  untrustFolder(project, home);
  assert.deepEqual(readFolderTrust(home), []);
});
