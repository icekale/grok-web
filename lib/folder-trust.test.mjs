import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  encodeTrustedFolders,
  readFolderTrust,
  readFolderTrustEnabled,
  trustFolder,
  untrustFolder,
} from "./folder-trust.ts";

test("encodeTrustedFolders refuses home and filesystem root", () => {
  assert.throws(() => encodeTrustedFolders(["/"]), /over-broad/i);
  assert.throws(() => encodeTrustedFolders([homedir()]), /over-broad/i);
  assert.throws(() => encodeTrustedFolders(["relative"]), /over-broad/i);
});

test("readFolderTrustEnabled follows GROK_FOLDER_TRUST then [folder_trust] enabled", () => {
  const home = mkdtempSync(join(tmpdir(), "grok-trust-home-"));
  assert.equal(readFolderTrustEnabled(home, undefined), true);
  writeFileSync(join(home, "config.toml"), "[folder_trust]\nenabled = false\n");
  assert.equal(readFolderTrustEnabled(home, undefined), false);
  writeFileSync(join(home, "config.toml"), "[folder_trust]\nenabled = true\n");
  assert.equal(readFolderTrustEnabled(home, "0"), false);
  assert.equal(readFolderTrustEnabled(home, "1"), true);
});

test("trustFolder and untrustFolder round-trip a project path", () => {
  const home = mkdtempSync(join(tmpdir(), "grok-trust-home-"));
  const project = "/Users/someone/project";
  trustFolder(project, home);
  const stored = readFolderTrust(home);
  assert.deepEqual(stored, [project]);
  const text = readFileSync(join(home, "trusted_folders.toml"), "utf8");
  assert.match(text, /\[folders\."\/Users\/someone\/project"\]/);
  assert.match(text, /trusted = true/);
  assert.match(text, /decided_at = \d+/);
  assert.doesNotMatch(text, /\[\[folders\]\]/);
  untrustFolder(project, home);
  assert.deepEqual(readFolderTrust(home), []);
});

test("trustFolder flips grok inspect projectTrusted for an isolated git repo", async (t) => {
  let bin;
  try {
    ({ resolveGrokBin: bin } = { resolveGrokBin: (await import("./acp/process.ts")).resolveGrokBin() });
  } catch {
    t.skip("grok binary is not installed");
    return;
  }
  const probe = mkdtempSync(join(tmpdir(), "grok-trust-live-"));
  const home = join(probe, "home");
  const repo = join(probe, "repo");
  mkdirSync(join(repo, ".grok", "hooks"), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(repo, ".grok", "hooks", "hooks.json"), JSON.stringify({
    hooks: { SessionStart: { "*": [{ type: "command", command: "true" }] } },
  }));
  writeFileSync(join(repo, "README.md"), "probe\n");
  execFileSync("git", ["init"], { cwd: repo });
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], { cwd: repo });

  const inspect = () => {
    const env = { ...process.env, GROK_HOME: home };
    delete env.GROK_FOLDER_TRUST;
    return JSON.parse(execFileSync(bin, ["inspect", "--json"], {
      cwd: repo,
      env,
      encoding: "utf8",
      timeout: 20_000,
    }));
  };

  const before = inspect();
  assert.ok(typeof before.projectRoot === "string" && before.projectRoot.length > 0);
  assert.equal(realpathSync(before.projectRoot), realpathSync(repo));
  assert.doesNotMatch(before.projectRoot, /\/grok-web\/?$/);
  assert.equal(before.projectTrusted, false);

  trustFolder(before.projectRoot, home);
  assert.equal(inspect().projectTrusted, true);

  untrustFolder(before.projectRoot, home);
  assert.equal(inspect().projectTrusted, false);
});
