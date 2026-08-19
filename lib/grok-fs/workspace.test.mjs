import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  createWorkspaceWorktree,
  listWorkspaceEntries,
  listWorkspaceWorktrees,
  readWorkspaceFile,
  readWorkspaceGitStatus,
  refuseWorkspaceWrite,
  refuseWorktreeWrite,
  writeWorkspaceFile,
  WORKSPACE_WRITE_ERROR,
  WORKTREE_WRITE_ERROR,
} from "./workspace.ts";

describe("workspace fallback", () => {
  it("lists and reads files under a project cwd", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-fs-"));
    writeFileSync(join(root, "README.md"), "hello workspace");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
    const entries = listWorkspaceEntries(root);
    assert.ok(entries.some((entry) => entry.name === "README.md" && !entry.isDirectory));
    assert.ok(entries.some((entry) => entry.name === "src" && entry.isDirectory));
    assert.equal(readWorkspaceFile(root, "README.md"), "hello workspace");
    assert.equal(readWorkspaceFile(root, join("src", "a.ts")), "export const a = 1;\n");
  });

  it("refuses writes with an explicit local-fallback error", () => {
    assert.throws(() => refuseWorkspaceWrite(), (error) => {
      assert.match(String(error.message), /read-only/i);
      assert.equal(error.message, WORKSPACE_WRITE_ERROR);
      return true;
    });
    assert.throws(() => refuseWorktreeWrite(), (error) => {
      assert.equal(error.message, WORKTREE_WRITE_ERROR);
      return true;
    });
  });

  it("writes through an injected ACP writer", async () => {
    const files = new Map();
    const written = await writeWorkspaceFile("/tmp/p", "a.txt", "hi", {
      write: async (abs, content) => { files.set(abs, content); },
    });
    assert.equal(written, true);
    assert.equal([...files.values()][0], "hi");
  });

  it("still refuses writes without a writer", () => {
    assert.throws(() => refuseWorkspaceWrite(), /read-only/i);
  });

  it("reports git status and worktrees from the local repo", async () => {
    const root = mkdtempSync(join(tmpdir(), "grok-git-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: root });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "t"], { cwd: root });
    writeFileSync(join(root, "tracked.txt"), "one\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: root });
    execFileSync("git", ["commit", "-m", "init"], { cwd: root });
    writeFileSync(join(root, "tracked.txt"), "two\n");
    const status = await readWorkspaceGitStatus(root);
    assert.equal(status.isGitRepository, true);
    assert.match(status.porcelain, /tracked\.txt/);
    const worktrees = listWorkspaceWorktrees(root);
    assert.ok(worktrees.some((tree) => tree.path === root || tree.isMain));
  });

  it("returns ACP git status when a client is provided", async () => {
    const status = await readWorkspaceGitStatus("/tmp/p", {
      gitStatus: async () => ({ branch: "main", isGitRepository: true, unstaged: [] }),
    });
    assert.equal(status.isGitRepository, true);
    assert.equal(status.branch, "main");
  });

  it("creates a worktree through ACP instead of refusing", async () => {
    const created = await createWorkspaceWorktree("/tmp/p", "feat/x", {
      worktreeCreate: async () => ({ worktreePath: "/tmp/p-wt", status: "creating" }),
    });
    assert.equal(created.worktreePath, "/tmp/p-wt");
  });
});
