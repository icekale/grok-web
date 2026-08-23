import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const { createRestoreCodeHandlers, preflightRestoreCode } = await import("./restore-code-http.ts");

function deps(root, flags = ["--restore-code", "--worktree"]) {
  let creates = 0;
  return {
    state: () => creates,
    findSession: async () => ({ cwd: root, git_root_dir: root, head_commit: "abc12345" }),
    readCapabilities: async () => ({ globalFlags: new Set(flags) }),
    listWorktrees: async () => ({ worktrees: [] }),
    createWorktree: async () => { creates += 1; return { worktreePath: join(root, "-worktree") }; },
    forkIntoCwd: async () => ({ newSessionId: "forked" }),
  };
}

test("preflight rejects unsupported restore without mutation", async () => {
  const root = mkdtempSync(join(tmpdir(), "restore-code-"));
  const injected = deps(root, []);
  await assert.rejects(preflightRestoreCode("session-1234", injected), (error) => error.status === 501 && error.code === "unsupported");
  assert.equal(injected.state(), 0);
});

test("POST requires confirmation, then creates and forks in the returned worktree", async () => {
  const root = mkdtempSync(join(tmpdir(), "restore-code-"));
  const injected = deps(root);
  const handlers = createRestoreCodeHandlers(injected);
  const pending = await handlers.POST(new Request("http://127.0.0.1", { method: "POST", body: JSON.stringify({ confirm: false }) }), { id: "session-1234" });
  assert.equal(pending.status, 200);
  assert.equal((await pending.json()).status, "confirmation_required");
  const created = await handlers.POST(new Request("http://127.0.0.1", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true }) }), { id: "session-1234" });
  assert.equal(created.status, 400);
  assert.equal(injected.state(), 1);
});

test("collision is rejected before create", async () => {
  const root = mkdtempSync(join(tmpdir(), "restore-code-"));
  const injected = deps(root);
  injected.listWorktrees = async () => ({ worktrees: [{ branch: "restore/session" }] });
  await assert.rejects(preflightRestoreCode("session", injected), (error) => error.status === 409 && error.code === "worktree_conflict");
  assert.equal(injected.state(), 0);
});
