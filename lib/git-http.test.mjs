import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { resolveAuthorizedGitFilePath } = await createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
}).import("./git-http.ts");

test("git path resolution preserves the lexical leaf after canonicalizing its parent", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-git-http-leaf-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = path.join(root, "repository");
  const alias = path.join(root, "repository-alias");
  const outside = path.join(root, "outside.txt");
  await mkdir(repository);
  await writeFile(outside, "outside\n");
  await symlink(repository, alias, "dir");
  await symlink(outside, path.join(repository, "outside-link"));

  const canonicalCwd = await realpath(repository);
  const resolved = resolveAuthorizedGitFilePath(
    canonicalCwd,
    path.join(alias, "outside-link"),
    new Set([alias]),
  );
  assert.deepEqual(resolved, {
    filePath: path.join(canonicalCwd, "outside-link"),
    relativePath: "outside-link",
  });
});

test("a retargeted parent alias cannot escape the already-canonical cwd", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-git-http-retarget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  const alias = path.join(root, "repository-alias");
  await mkdir(first);
  await mkdir(second);
  await writeFile(path.join(second, "file.txt"), "second\n");
  await symlink(first, alias, "dir");
  const canonicalCwd = await realpath(first);
  const allowedRoots = new Set([alias]);

  await unlink(alias);
  await symlink(second, alias, "dir");
  assert.deepEqual(
    resolveAuthorizedGitFilePath(canonicalCwd, path.join(alias, "file.txt"), allowedRoots),
    { error: "path must be inside cwd", status: 400 },
  );
});
