import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function loadSubject() {
  return import("./git-status.ts");
}

async function loadChanges() {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url).import("./git-changes.ts");
}

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args]);
  return stdout.trim();
}

async function createRepository(root, name) {
  const repository = path.join(root, name);
  await execFileAsync("git", ["init", repository]);
  await git(repository, ["config", "user.name", "Grok Web Test"]);
  await git(repository, ["config", "user.email", "grok-web@example.invalid"]);
  await git(repository, ["config", "commit.gpgsign", "false"]);
  for (const file of ["stage.txt", "discard.txt", "commit.txt"]) {
    await writeFile(path.join(repository, file), `${name} original\n`);
  }
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "initial"]);
  return repository;
}

test("local git write helpers only mutate their requested repository", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-git-changes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repositoryA = await createRepository(root, "repository-a");
  const repositoryB = await createRepository(root, "repository-b");
  const {
    commitGitChanges,
    discardGitFiles,
    stageGitFiles,
  } = await loadChanges();

  await writeFile(path.join(repositoryA, "stage.txt"), "A staged\n");
  await writeFile(path.join(repositoryB, "stage.txt"), "B staged\n");
  assert.deepEqual(await stageGitFiles(repositoryB, ["stage.txt"]), { paths: ["stage.txt"] });
  assert.equal(await git(repositoryA, ["diff", "--cached", "--name-only"]), "");
  assert.equal(await git(repositoryB, ["diff", "--cached", "--name-only"]), "stage.txt");

  await writeFile(path.join(repositoryA, "discard.txt"), "A dirty\n");
  await writeFile(path.join(repositoryB, "discard.txt"), "B dirty\n");
  assert.deepEqual(await discardGitFiles(repositoryB, ["discard.txt"]), { ok: true });
  assert.equal(await readFile(path.join(repositoryA, "discard.txt"), "utf8"), "A dirty\n");
  assert.equal(await readFile(path.join(repositoryB, "discard.txt"), "utf8"), "repository-b original\n");

  await writeFile(path.join(repositoryA, "commit.txt"), "A commit\n");
  await writeFile(path.join(repositoryB, "commit.txt"), "B commit\n");
  await git(repositoryA, ["add", "commit.txt"]);
  await git(repositoryB, ["add", "commit.txt"]);
  const beforeA = await git(repositoryA, ["rev-parse", "HEAD"]);
  const beforeB = await git(repositoryB, ["rev-parse", "HEAD"]);
  assert.deepEqual(await commitGitChanges(repositoryB, "commit B only"), { ok: true });
  assert.equal(await git(repositoryA, ["rev-parse", "HEAD"]), beforeA);
  assert.notEqual(await git(repositoryB, ["rev-parse", "HEAD"]), beforeB);
  assert.equal(await git(repositoryB, ["log", "-1", "--pretty=%s"]), "commit B only");
});

test("discard preserves staged content and only deletes untracked regular files", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-git-discard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await createRepository(root, "repository");
  const { discardGitFiles } = await loadChanges();

  for (const file of ["staged-only.txt", "partially-staged.txt"]) {
    await writeFile(path.join(repository, file), "original\n");
  }
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "discard fixtures"]);

  await writeFile(path.join(repository, "staged-only.txt"), "staged\n");
  await git(repository, ["add", "staged-only.txt"]);
  await discardGitFiles(repository, ["staged-only.txt"]);
  assert.equal(await git(repository, ["show", ":staged-only.txt"]), "staged");
  assert.equal(await readFile(path.join(repository, "staged-only.txt"), "utf8"), "staged\n");

  await writeFile(path.join(repository, "partially-staged.txt"), "staged\n");
  await git(repository, ["add", "partially-staged.txt"]);
  await writeFile(path.join(repository, "partially-staged.txt"), "unstaged\n");
  await discardGitFiles(repository, ["partially-staged.txt"]);
  assert.equal(await git(repository, ["show", ":partially-staged.txt"]), "staged");
  assert.equal(await readFile(path.join(repository, "partially-staged.txt"), "utf8"), "staged\n");

  const untrackedFile = path.join(repository, "untracked.txt");
  await writeFile(untrackedFile, "delete me\n");
  await discardGitFiles(repository, ["untracked.txt"]);
  assert.equal(existsSync(untrackedFile), false);

  const untrackedDirectory = path.join(repository, "untracked-directory");
  await mkdir(untrackedDirectory);
  await assert.rejects(discardGitFiles(repository, ["untracked-directory"]), /regular file/i);
  assert.equal(existsSync(untrackedDirectory), true);

  const outside = path.join(root, "outside.txt");
  const untrackedSymlink = path.join(repository, "untracked-link");
  await writeFile(outside, "keep me\n");
  await symlink(outside, untrackedSymlink);
  await assert.rejects(discardGitFiles(repository, ["untracked-link"]), /regular file/i);
  assert.equal(await readlink(untrackedSymlink), outside);
  assert.equal(await readFile(outside, "utf8"), "keep me\n");
});

test("tracked symlinks to outside files are diffed, staged, and discarded as links", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-git-symlink-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await createRepository(root, "repository");
  const firstTarget = path.join(root, "outside-first.txt");
  const secondTarget = path.join(root, "outside-second.txt");
  const link = path.join(repository, "outside-link");
  await writeFile(firstTarget, "outside first\n");
  await writeFile(secondTarget, "outside second\n");
  await symlink(firstTarget, link);
  await git(repository, ["add", "outside-link"]);
  await git(repository, ["commit", "-m", "track symlink"]);
  await unlink(link);
  await symlink(secondTarget, link);

  const { discardGitFiles, getGitFileDiff, stageGitFiles } = await loadChanges();
  const diff = await getGitFileDiff(repository, link);
  assert.equal(diff.supported, true);
  assert.match(diff.patch, /outside-first/);
  assert.match(diff.patch, /outside-second/);

  await stageGitFiles(repository, ["outside-link"]);
  assert.equal(await git(repository, ["show", ":outside-link"]), secondTarget);
  await unlink(link);
  await symlink(firstTarget, link);
  await discardGitFiles(repository, ["outside-link"]);
  assert.equal(await readlink(link), secondTarget);
  assert.equal(await git(repository, ["show", ":outside-link"]), secondTarget);
});

test("file diff stays inside a subdirectory cwd", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-git-subdirectory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await createRepository(root, "repository");
  const first = path.join(repository, "first");
  const second = path.join(repository, "second");
  await mkdir(first);
  await mkdir(second);
  await writeFile(path.join(first, "file.txt"), "first original\n");
  await writeFile(path.join(second, "file.txt"), "second original\n");
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "subdirectories"]);
  await writeFile(path.join(first, "file.txt"), "first changed\n");
  await writeFile(path.join(second, "file.txt"), "second changed\n");

  const { getGitFileDiff } = await loadChanges();
  assert.equal((await getGitFileDiff(second, path.join(first, "file.txt"))).supported, false);
  assert.equal((await getGitFileDiff(second, path.join(second, "file.txt"))).supported, true);
});

test("git helpers treat magic-looking pathspecs literally inside subdirectory cwd", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-git-pathspec-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await createRepository(root, "repository");
  const cwd = path.join(repository, ":(top)scope");
  const escapedScope = path.join(repository, "scope");
  await mkdir(cwd);
  await mkdir(escapedScope);
  const files = {
    diff: ":(top)package.json",
    discard: ":(top)discard.txt",
    exclude: ":!exclude.txt",
    glob: ":(glob)*.txt",
    status: "status.txt",
  };
  await writeFile(path.join(repository, "package.json"), "root original\n");
  await writeFile(path.join(repository, "discard.txt"), "root discard original\n");
  await writeFile(path.join(escapedScope, "leak.txt"), "leak original\n");
  for (const file of Object.values(files)) {
    await writeFile(path.join(cwd, file), `${file} original\n`);
  }
  await writeFile(path.join(cwd, "ordinary.txt"), "ordinary original\n");
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "magic path fixtures"]);
  const canonicalCwd = await realpath(cwd);

  await writeFile(path.join(cwd, files.status), "status changed\n");
  await writeFile(path.join(escapedScope, "leak.txt"), "leak\nhas\nmany\nlines\n");
  const { discardGitFiles, getGitFileDiff, getGitStatus, stageGitFiles } = await loadChanges();
  const status = await getGitStatus(canonicalCwd);
  assert.deepEqual(status.files.map((file) => path.basename(file.filePath)), ["status.txt"]);
  assert.equal(status.additions, 1);
  assert.equal(status.deletions, 1);

  await writeFile(path.join(repository, "package.json"), "root changed\n");
  await writeFile(path.join(cwd, files.diff), "literal package changed\n");
  const diff = await getGitFileDiff(canonicalCwd, path.join(canonicalCwd, files.diff));
  assert.equal(diff.supported, true);
  assert.match(diff.patch, /literal package changed/);
  assert.doesNotMatch(diff.patch, /root changed/);

  await writeFile(path.join(cwd, files.glob), "literal glob changed\n");
  await writeFile(path.join(cwd, files.exclude), "literal exclude changed\n");
  await writeFile(path.join(cwd, "ordinary.txt"), "ordinary changed\n");
  await stageGitFiles(canonicalCwd, [files.glob, files.exclude]);
  const staged = (await git(repository, ["diff", "--cached", "--name-only"])).split("\n").filter(Boolean);
  assert.deepEqual(staged.sort(), [
    `:(top)scope/${files.exclude}`,
    `:(top)scope/${files.glob}`,
  ].sort());

  await writeFile(path.join(repository, "discard.txt"), "root discard changed\n");
  await writeFile(path.join(cwd, files.discard), "literal discard changed\n");
  await discardGitFiles(canonicalCwd, [files.discard]);
  assert.equal(await readFile(path.join(cwd, files.discard), "utf8"), `${files.discard} original\n`);
  assert.equal(await readFile(path.join(repository, "discard.txt"), "utf8"), "root discard changed\n");
});

test("parses null-delimited Git status entries including renames", async () => {
  const { parseGitPorcelainV1 } = await loadSubject();
  const entries = parseGitPorcelainV1([
    " M components/App.tsx",
    "?? notes.txt",
    "R  src/new-name.ts",
    "src/old-name.ts",
    "",
  ].join("\0"));

  assert.deepEqual(entries, [
    {
      path: "components/App.tsx",
      indexStatus: " ",
      worktreeStatus: "M",
    },
    {
      path: "notes.txt",
      indexStatus: "?",
      worktreeStatus: "?",
    },
    {
      path: "src/new-name.ts",
      originalPath: "src/old-name.ts",
      indexStatus: "R",
      worktreeStatus: " ",
    },
  ]);
});

test("maps ACP git diffs with a patch onto the FileViewer response", async () => {
  const { mapAcpGitFileDiff } = await loadSubject();
  const mapped = mapAcpGitFileDiff({
    files: [{
      path: "lib/acp/runtime.ts",
      type: "edit",
      patch: "diff --git a/lib/acp/runtime.ts b/lib/acp/runtime.ts\n@@ -1,1 +1,2 @@\n+ok\n",
    }],
  }, "lib/acp/runtime.ts");
  assert.equal(mapped?.supported, true);
  assert.equal(mapped?.status, "modified");
  assert.match(mapped?.patch ?? "", /@@/);
  assert.equal(mapAcpGitFileDiff({ files: [] }, "lib/acp/runtime.ts"), null);
});

test("classifies Git status for explorer badges", async () => {
  const { classifyGitStatus } = await loadSubject();
  const classify = (pair) => classifyGitStatus({
    path: "file.ts",
    indexStatus: pair[0],
    worktreeStatus: pair[1],
  });

  assert.deepEqual(classify(" M"), { status: "modified", code: "M" });
  assert.deepEqual(classify("??"), { status: "untracked", code: "U" });
  assert.deepEqual(classify("A "), { status: "added", code: "A" });
  assert.deepEqual(classify("R "), { status: "renamed", code: "R" });
  assert.deepEqual(classify("UU"), { status: "conflict", code: "C" });
  assert.deepEqual(classify(" D"), { status: "deleted", code: "D" });
});
