import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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
  const linked = path.join(root, `${name}-linked`);
  await execFileAsync("git", ["init", repository]);
  await git(repository, ["config", "user.name", "Grok Web Test"]);
  await git(repository, ["config", "user.email", "grok-web@example.invalid"]);
  await git(repository, ["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(repository, "README.md"), `# ${name}\n`);
  await git(repository, ["add", "README.md"]);
  await git(repository, ["commit", "-m", "initial"]);
  await git(repository, ["worktree", "add", "-b", `${name}-feature`, linked]);
  return { repository, linked };
}

function deleteRequest(body) {
  return new Request("http://127.0.0.1/api/worktrees", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("DELETE only removes an authorized linked worktree from the cwd repository", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-worktree-route-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repositoryA = await createRepository(root, "repository-a");
  const repositoryB = await createRepository(root, "repository-b");
  const repositoryBAlias = path.join(root, "repository-b-alias");
  const linkedBAlias = path.join(root, "repository-b-linked-alias");
  const outside = path.join(root, "outside");
  await symlink(repositoryB.repository, repositoryBAlias, "dir");
  await symlink(repositoryB.linked, linkedBAlias, "dir");
  await mkdir(outside);

  globalThis.__piAdditionalAllowedRoots ??= new Set();
  for (const allowed of [repositoryBAlias, repositoryA.linked, linkedBAlias, repositoryB.repository]) {
    globalThis.__piAdditionalAllowedRoots.add(allowed);
  }
  globalThis.__piAllowedRootsCache = undefined;

  const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
  const { resetAgentRuntime, setAgentRuntime } = await jiti.import("@/lib/acp/runtime.ts");
  const acpCalls = [];
  setAgentRuntime({
    ensureProcess: async () => {},
    worktreeRemove: async (target) => {
      acpCalls.push(target);
      await git(repositoryA.repository, ["worktree", "remove", "--force", target]);
      return { ok: true };
    },
  });

  try {
    const { DELETE } = await jiti.import("./route.ts");

    const crossRepository = await DELETE(deleteRequest({
      cwd: repositoryBAlias,
      path: repositoryA.linked,
      force: true,
    }));
    assert.equal(crossRepository.status, 400);
    assert.match((await crossRepository.json()).error, /Not a worktree of this repository/);
    assert.equal(existsSync(repositoryA.linked), true);

    const outsideRoots = await DELETE(deleteRequest({
      cwd: repositoryBAlias,
      path: outside,
      force: true,
    }));
    assert.equal(outsideRoots.status, 403);
    assert.equal(existsSync(outside), true);

    const mainWorktree = await DELETE(deleteRequest({
      cwd: repositoryBAlias,
      path: repositoryB.repository,
      force: true,
    }));
    assert.equal(mainWorktree.status, 400);
    assert.match((await mainWorktree.json()).error, /main worktree/i);
    assert.equal(existsSync(repositoryB.repository), true);

    await writeFile(path.join(repositoryB.linked, "dirty.txt"), "dirty\n");
    const withoutForce = await DELETE(deleteRequest({
      cwd: repositoryBAlias,
      path: linkedBAlias,
      force: false,
    }));
    assert.equal(withoutForce.status, 409);
    assert.equal((await withoutForce.json()).dirty, true);
    assert.equal(existsSync(repositoryB.linked), true);

    const withForce = await DELETE(deleteRequest({
      cwd: repositoryBAlias,
      path: linkedBAlias,
      force: true,
    }));
    assert.equal(withForce.status, 200, await withForce.clone().text());
    assert.deepEqual(await withForce.json(), { success: true });
    assert.equal(existsSync(repositoryB.linked), false);
    assert.deepEqual(acpCalls, []);
  } finally {
    resetAgentRuntime();
    for (const allowed of [repositoryBAlias, repositoryA.linked, linkedBAlias, repositoryB.repository]) {
      globalThis.__piAdditionalAllowedRoots.delete(allowed);
    }
    globalThis.__piAllowedRootsCache = undefined;
  }
});
