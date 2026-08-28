import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

async function createRepository(root) {
  const repository = path.join(root, "repo");
  await execFileAsync("git", ["init", repository]);
  await git(repository, ["config", "user.name", "Grok Web Test"]);
  await git(repository, ["config", "user.email", "grok-web@example.invalid"]);
  await git(repository, ["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(repository, "stage.txt"), "original\n");
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "initial"]);
  return repository;
}

function post(body) {
  return new Request("http://127.0.0.1/api/git/stage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("git writes require sessionId and go through ACP, not local git", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-git-write-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await createRepository(root);
  await writeFile(path.join(repository, "stage.txt"), "changed\n");

  globalThis.__piAdditionalAllowedRoots ??= new Set();
  globalThis.__piAdditionalAllowedRoots.add(repository);
  globalThis.__piAllowedRootsCache = undefined;
  t.after(() => {
    globalThis.__piAdditionalAllowedRoots.delete(repository);
    globalThis.__piAllowedRootsCache = undefined;
  });

  const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false });
  const { resetAgentRuntime, setAgentRuntime } = await jiti.import("@/lib/acp/runtime.ts");
  const acpCalls = [];
  setAgentRuntime({
    hasSession: (id) => id === "sess-1",
    ensureProcess: async () => {},
    gitStage: async (paths) => {
      acpCalls.push(["stage", ...paths]);
      await git(repository, ["add", "--", ...paths]);
      return { paths };
    },
    gitDiscard: async (paths) => {
      acpCalls.push(["discard", ...paths]);
      return { ok: true };
    },
    gitCommit: async (message) => {
      acpCalls.push(["commit", message]);
      await git(repository, ["commit", "-m", message]);
      return { ok: true };
    },
  });
  t.after(() => resetAgentRuntime());

  const { handleGitWrite } = await jiti.import("./git-http.ts");
  const missing = await handleGitWrite(post({
    cwd: repository,
    path: path.join(repository, "stage.txt"),
  }), "stage");
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /sessionId/);
  assert.equal(await git(repository, ["diff", "--cached", "--name-only"]), "");
  assert.deepEqual(acpCalls, []);

  const staged = await handleGitWrite(post({
    sessionId: "sess-1",
    cwd: repository,
    path: path.join(repository, "stage.txt"),
  }), "stage");
  assert.equal(staged.status, 200, await staged.clone().text());
  assert.deepEqual(await staged.json(), { success: true, data: { paths: ["stage.txt"] } });
  assert.deepEqual(acpCalls, [["stage", "stage.txt"]]);
  assert.equal(await git(repository, ["diff", "--cached", "--name-only"]), "stage.txt");

  setAgentRuntime({
    hasSession: () => true,
    ensureProcess: async () => {},
    gitCommit: async () => {
      throw new Error("Method not found: _x.ai/git/commit");
    },
  });
  const missingMethod = await handleGitWrite(post({
    sessionId: "sess-1",
    cwd: repository,
    message: "nope",
  }), "commit");
  assert.equal(missingMethod.status, 501);
  assert.equal((await missingMethod.json()).code, "unsupported");
});
