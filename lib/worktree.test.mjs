import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

async function loadSubject() {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url).import("./worktree.ts");
}

async function git(cwd, args) {
  await execFileAsync("git", ["-C", cwd, ...args]);
}

test("main and linked worktrees share one canonical project root", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-web-worktree-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const repo = path.join(tempRoot, "repo");
  const linked = path.join(tempRoot, "linked");
  await execFileAsync("git", ["init", repo]);
  await git(repo, ["config", "user.name", "Pi Web Test"]);
  await git(repo, ["config", "user.email", "pi-web-test@example.invalid"]);
  await git(repo, ["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(repo, "README.md"), "# test\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);
  await git(repo, ["worktree", "add", "-b", "feature/test", linked]);

  const { findCurrentWorktreePath, listWorktrees, resolveProject } = await loadSubject();
  const mainProject = await resolveProject(`${repo}${path.sep}`);
  const linkedProject = await resolveProject(linked);

  assert.equal(mainProject.isTopLevel, true);
  assert.equal(mainProject.isWorktree, false);
  assert.equal(linkedProject.isTopLevel, true);
  assert.equal(linkedProject.isWorktree, true);
  assert.equal(linkedProject.branch, "feature/test");
  assert.equal(mainProject.projectRoot, linkedProject.projectRoot);

  const worktrees = await listWorktrees(linked);
  const listedLinked = worktrees.find((worktree) => worktree.branch === "feature/test");
  assert.ok(listedLinked);
  assert.equal(findCurrentWorktreePath(worktrees, `${linked}${path.sep}`), listedLinked.path);
});

test("worktree removal is repository-scoped, canonical, and honors force", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-web-worktree-remove-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const createRepository = async (name) => {
    const repository = path.join(tempRoot, name);
    const linked = path.join(tempRoot, `${name}-linked`);
    await execFileAsync("git", ["init", repository]);
    await git(repository, ["config", "user.name", "Pi Web Test"]);
    await git(repository, ["config", "user.email", "pi-web-test@example.invalid"]);
    await git(repository, ["config", "commit.gpgsign", "false"]);
    await writeFile(path.join(repository, "README.md"), `# ${name}\n`);
    await git(repository, ["add", "README.md"]);
    await git(repository, ["commit", "-m", "initial"]);
    await git(repository, ["worktree", "add", "-b", `${name}-feature`, linked]);
    return { repository, linked };
  };

  const repositoryA = await createRepository("repository-a");
  const repositoryB = await createRepository("repository-b");
  const repositoryBAlias = path.join(tempRoot, "repository-b-alias");
  const linkedAAlias = path.join(tempRoot, "repository-a-linked-alias");
  const linkedBAlias = path.join(tempRoot, "repository-b-linked-alias");
  await symlink(repositoryB.repository, repositoryBAlias, "dir");
  await symlink(repositoryA.linked, linkedAAlias, "dir");
  await symlink(repositoryB.linked, linkedBAlias, "dir");

  const { removeWorktree } = await loadSubject();
  await assert.rejects(
    removeWorktree(repositoryBAlias, linkedAAlias, true),
    /Not a worktree of this repository/,
  );
  assert.equal(existsSync(repositoryA.linked), true);

  await writeFile(path.join(repositoryB.linked, "dirty.txt"), "dirty\n");
  await assert.rejects(
    removeWorktree(repositoryBAlias, linkedBAlias, false),
    /modified or untracked files|is dirty/i,
  );
  assert.equal(existsSync(repositoryB.linked), true);

  await removeWorktree(repositoryBAlias, linkedBAlias, true);
  assert.equal(existsSync(repositoryB.linked), false);
});
