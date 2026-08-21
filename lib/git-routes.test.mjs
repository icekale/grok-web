import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createJiti } from "jiti";

const execFileAsync = promisify(execFile);

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
  for (const file of ["diff.txt", "stage.txt", "discard.txt", "commit.txt"]) {
    await writeFile(path.join(repository, file), `${name} original\n`);
  }
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "initial"]);
  return repository;
}

function post(url, body) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("git routes use the authorized cwd instead of process-global ACP state", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-git-routes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repositoryA = await createRepository(root, "repository-a");
  const repositoryB = await createRepository(root, "repository-b");
  const canonicalRepositoryB = await realpath(repositoryB);
  const repositoryBAlias = path.join(root, "repository-b-alias");
  await symlink(repositoryB, repositoryBAlias, "dir");
  const outsideFirst = path.join(root, "outside-first.txt");
  const outsideSecond = path.join(root, "outside-second.txt");
  const trackedLink = path.join(repositoryB, "outside-link");
  await writeFile(outsideFirst, "outside first\n");
  await writeFile(outsideSecond, "outside second\n");
  await symlink(outsideFirst, trackedLink);
  await mkdir(path.join(repositoryB, "subdirectory"));
  await writeFile(path.join(repositoryB, "subdirectory", "nested.txt"), "nested original\n");
  await git(repositoryB, ["add", "outside-link", "subdirectory/nested.txt"]);
  await git(repositoryB, ["commit", "-m", "path fixtures"]);
  await unlink(trackedLink);
  await symlink(outsideSecond, trackedLink);
  await writeFile(path.join(repositoryB, "subdirectory", "nested.txt"), "nested changed\n");
  for (const repository of [repositoryA, repositoryB]) {
    await writeFile(path.join(repository, "diff.txt"), `${path.basename(repository)} diff\n`);
    await writeFile(path.join(repository, "stage.txt"), `${path.basename(repository)} stage\n`);
    await writeFile(path.join(repository, "discard.txt"), `${path.basename(repository)} discard\n`);
    await writeFile(path.join(repository, "commit.txt"), `${path.basename(repository)} commit\n`);
  }
  await git(repositoryA, ["add", "commit.txt"]);
  await git(repositoryB, ["add", "commit.txt"]);

  globalThis.__piAdditionalAllowedRoots ??= new Set();
  globalThis.__piAdditionalAllowedRoots.add(repositoryA);
  globalThis.__piAdditionalAllowedRoots.add(repositoryBAlias);
  globalThis.__piAllowedRootsCache = undefined;

  const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
  const { resetAgentRuntime, setAgentRuntime } = await jiti.import("@/lib/acp/runtime.ts");
  const acpCalls = [];
  setAgentRuntime({
    ensureProcess: async () => {},
    gitStatus: async () => {
      acpCalls.push("status");
      return {
        repositoryRoot: repositoryA,
        files: [{ filePath: path.join(repositoryA, "diff.txt"), status: "modified", code: "M", indexStatus: " ", worktreeStatus: "M" }],
        additions: 1,
        deletions: 1,
        isGitRepository: true,
      };
    },
    gitDiffs: async ([relativePath]) => {
      acpCalls.push("diff");
      const patch = await git(repositoryA, ["diff", "HEAD", "--", relativePath]);
      return { files: [{ path: relativePath, type: "edit", patch }] };
    },
    gitStage: async (paths) => {
      acpCalls.push("stage");
      await git(repositoryA, ["add", "--", ...paths]);
      return { paths };
    },
    gitDiscard: async (paths) => {
      acpCalls.push("discard");
      await git(repositoryA, ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...paths]);
      return { ok: true };
    },
    gitCommit: async (message) => {
      acpCalls.push("commit");
      await git(repositoryA, ["commit", "-m", message]);
      return { ok: true };
    },
  });

  try {
    const [{ GET: getStatus }, { GET: getDiff }, { handleGitWrite }] = await Promise.all([
      jiti.import("./git-status-http.ts"),
      jiti.import("./git-diff-http.ts"),
      jiti.import("./git-http.ts"),
    ]);
    const stage = (req) => handleGitWrite(req, "stage");
    const discard = (req) => handleGitWrite(req, "discard");
    const commit = (req) => handleGitWrite(req, "commit");

    const statusResponse = await getStatus(new Request(
      `http://127.0.0.1/api/git/status?cwd=${encodeURIComponent(repositoryBAlias)}`,
    ));
    assert.equal(statusResponse.status, 200);
    const status = await statusResponse.json();
    assert.equal(status.repositoryRoot, canonicalRepositoryB);
    assert.ok(status.files.every((file) => file.filePath.startsWith(canonicalRepositoryB)));

    const crossRepositoryDiff = await getDiff(new Request(
      `http://127.0.0.1/api/git/diff?cwd=${encodeURIComponent(repositoryBAlias)}&path=${encodeURIComponent(path.join(repositoryA, "diff.txt"))}`,
    ));
    assert.equal(crossRepositoryDiff.status, 400);

    const diffResponse = await getDiff(new Request(
      `http://127.0.0.1/api/git/diff?cwd=${encodeURIComponent(repositoryBAlias)}&path=${encodeURIComponent(path.join(repositoryBAlias, "diff.txt"))}`,
    ));
    assert.equal(diffResponse.status, 200);
    const diff = await diffResponse.json();
    assert.match(diff.patch, /repository-b diff/);
    assert.doesNotMatch(diff.patch, /repository-a diff/);

    const symlinkDiffResponse = await getDiff(new Request(
      `http://127.0.0.1/api/git/diff?cwd=${encodeURIComponent(repositoryBAlias)}&path=${encodeURIComponent(path.join(repositoryBAlias, "outside-link"))}`,
    ));
    assert.equal(symlinkDiffResponse.status, 200);
    assert.match((await symlinkDiffResponse.json()).patch, /outside-second/);

    const symlinkStageResponse = await stage(post("http://127.0.0.1/api/git/stage", {
      cwd: repositoryBAlias,
      path: path.join(repositoryBAlias, "outside-link"),
    }));
    assert.deepEqual(await symlinkStageResponse.json(), { success: true, data: { paths: ["outside-link"] } });
    assert.equal(await git(repositoryB, ["show", ":outside-link"]), outsideSecond);
    await unlink(trackedLink);
    await symlink(outsideFirst, trackedLink);
    const symlinkDiscardResponse = await discard(post("http://127.0.0.1/api/git/discard", {
      cwd: repositoryBAlias,
      path: path.join(repositoryBAlias, "outside-link"),
    }));
    assert.deepEqual(await symlinkDiscardResponse.json(), { success: true, data: { ok: true } });
    assert.equal(await readlink(trackedLink), outsideSecond);

    const subdirectoryCwd = path.join(repositoryBAlias, "subdirectory");
    const nestedPath = path.join(subdirectoryCwd, "nested.txt");
    const nestedDiffResponse = await getDiff(new Request(
      `http://127.0.0.1/api/git/diff?cwd=${encodeURIComponent(subdirectoryCwd)}&path=${encodeURIComponent(nestedPath)}`,
    ));
    assert.equal(nestedDiffResponse.status, 200);
    assert.match((await nestedDiffResponse.json()).patch, /nested changed/);
    const nestedStageResponse = await stage(post("http://127.0.0.1/api/git/stage", {
      cwd: subdirectoryCwd,
      path: nestedPath,
    }));
    assert.deepEqual(await nestedStageResponse.json(), { success: true, data: { paths: ["nested.txt"] } });
    assert.equal(await git(repositoryB, ["diff", "--cached", "--name-only", "--", "subdirectory/nested.txt"]), "subdirectory/nested.txt");

    const crossRepositoryStage = await stage(post("http://127.0.0.1/api/git/stage", {
      cwd: repositoryBAlias,
      path: path.join(repositoryA, "stage.txt"),
    }));
    assert.equal(crossRepositoryStage.status, 400);
    assert.equal(await git(repositoryA, ["diff", "--cached", "--name-only", "--", "stage.txt"]), "");

    const stageResponse = await stage(post("http://127.0.0.1/api/git/stage", {
      cwd: repositoryBAlias,
      path: path.join(repositoryBAlias, "stage.txt"),
    }));
    assert.deepEqual(await stageResponse.json(), { success: true, data: { paths: ["stage.txt"] } });
    assert.equal(await git(repositoryA, ["diff", "--cached", "--name-only", "--", "stage.txt"]), "");
    assert.equal(await git(repositoryB, ["diff", "--cached", "--name-only", "--", "stage.txt"]), "stage.txt");

    const crossRepositoryDiscard = await discard(post("http://127.0.0.1/api/git/discard", {
      cwd: repositoryBAlias,
      path: path.join(repositoryA, "discard.txt"),
    }));
    assert.equal(crossRepositoryDiscard.status, 400);
    assert.equal(await readFile(path.join(repositoryA, "discard.txt"), "utf8"), "repository-a discard\n");

    const discardResponse = await discard(post("http://127.0.0.1/api/git/discard", {
      cwd: repositoryBAlias,
      path: path.join(repositoryBAlias, "discard.txt"),
    }));
    assert.deepEqual(await discardResponse.json(), { success: true, data: { ok: true } });
    assert.equal(await readFile(path.join(repositoryA, "discard.txt"), "utf8"), "repository-a discard\n");
    assert.equal(await readFile(path.join(repositoryB, "discard.txt"), "utf8"), "repository-b original\n");

    const beforeA = await git(repositoryA, ["rev-parse", "HEAD"]);
    const beforeB = await git(repositoryB, ["rev-parse", "HEAD"]);
    const commitResponse = await commit(post("http://127.0.0.1/api/git/commit", {
      cwd: repositoryBAlias,
      message: "commit repository B",
    }));
    assert.deepEqual(await commitResponse.json(), { success: true, data: { ok: true } });
    assert.equal(await git(repositoryA, ["rev-parse", "HEAD"]), beforeA);
    assert.notEqual(await git(repositoryB, ["rev-parse", "HEAD"]), beforeB);
    assert.equal(await git(repositoryB, ["log", "-1", "--pretty=%s"]), "commit repository B");
    assert.deepEqual(acpCalls, []);
  } finally {
    resetAgentRuntime();
    globalThis.__piAdditionalAllowedRoots.delete(repositoryA);
    globalThis.__piAdditionalAllowedRoots.delete(repositoryBAlias);
    globalThis.__piAllowedRootsCache = undefined;
  }
});

test("git routes keep magic pathspecs inside an authorized subdirectory cwd", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-git-route-pathspec-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await createRepository(root, "repository");
  const cwd = path.join(repository, ":(top)scope");
  const escapedScope = path.join(repository, "scope");
  await mkdir(cwd);
  await mkdir(escapedScope);
  for (const [file, content] of [
    ["package.json", "root package original\n"],
    ["discard.txt", "root discard original\n"],
    ["scope/leak.txt", "leak original\n"],
    [":(top)scope/:(top)package.json", "literal package original\n"],
    [":(top)scope/:(top)discard.txt", "literal discard original\n"],
    [":(top)scope/:(glob)*.txt", "literal glob original\n"],
    [":(top)scope/ordinary.txt", "ordinary original\n"],
    [":(top)scope/status.txt", "status original\n"],
  ]) {
    await writeFile(path.join(repository, file), content);
  }
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "magic route fixtures"]);

  globalThis.__piAdditionalAllowedRoots ??= new Set();
  globalThis.__piAdditionalAllowedRoots.add(repository);
  globalThis.__piAllowedRootsCache = undefined;
  try {
    const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
    const [{ GET: getStatus }, { GET: getDiff }, { handleGitWrite }] = await Promise.all([
      jiti.import("./git-status-http.ts"),
      jiti.import("./git-diff-http.ts"),
      jiti.import("./git-http.ts"),
    ]);
    const stage = (req) => handleGitWrite(req, "stage");
    const discard = (req) => handleGitWrite(req, "discard");

    await writeFile(path.join(cwd, "status.txt"), "status changed\n");
    await writeFile(path.join(escapedScope, "leak.txt"), "leak\nhas\nmany\nlines\n");
    const statusResponse = await getStatus(new Request(
      `http://127.0.0.1/api/git/status?cwd=${encodeURIComponent(cwd)}`,
    ));
    assert.equal(statusResponse.status, 200);
    const status = await statusResponse.json();
    assert.equal(status.additions, 1);
    assert.equal(status.deletions, 1);

    const literalPackage = path.join(cwd, ":(top)package.json");
    await writeFile(path.join(repository, "package.json"), "root package changed\n");
    await writeFile(literalPackage, "literal package changed\n");
    const diffResponse = await getDiff(new Request(
      `http://127.0.0.1/api/git/diff?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(literalPackage)}`,
    ));
    assert.equal(diffResponse.status, 200);
    const diff = await diffResponse.json();
    assert.match(diff.patch, /literal package changed/);
    assert.doesNotMatch(diff.patch, /root package changed/);

    const stageResponse = await stage(post("http://127.0.0.1/api/git/stage", {
      cwd,
      path: literalPackage,
    }));
    assert.equal(stageResponse.status, 200, await stageResponse.clone().text());
    assert.equal(
      await git(repository, ["diff", "--cached", "--name-only"]),
      ":(top)scope/:(top)package.json",
    );

    const literalGlob = path.join(cwd, ":(glob)*.txt");
    await writeFile(literalGlob, "literal glob changed\n");
    await writeFile(path.join(cwd, "ordinary.txt"), "ordinary changed\n");
    const globStageResponse = await stage(post("http://127.0.0.1/api/git/stage", {
      cwd,
      path: literalGlob,
    }));
    assert.equal(globStageResponse.status, 200, await globStageResponse.clone().text());
    const staged = (await git(repository, ["diff", "--cached", "--name-only"])).split("\n");
    assert.ok(staged.includes(":(top)scope/:(glob)*.txt"));
    assert.ok(!staged.includes(":(top)scope/ordinary.txt"));

    const literalDiscard = path.join(cwd, ":(top)discard.txt");
    await writeFile(path.join(repository, "discard.txt"), "root discard changed\n");
    await writeFile(literalDiscard, "literal discard changed\n");
    const discardResponse = await discard(post("http://127.0.0.1/api/git/discard", {
      cwd,
      path: literalDiscard,
    }));
    assert.equal(discardResponse.status, 200, await discardResponse.clone().text());
    assert.equal(await readFile(literalDiscard, "utf8"), "literal discard original\n");
    assert.equal(await readFile(path.join(repository, "discard.txt"), "utf8"), "root discard changed\n");
  } finally {
    globalThis.__piAdditionalAllowedRoots.delete(repository);
    globalThis.__piAllowedRootsCache = undefined;
  }
});
