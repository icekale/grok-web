import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

test("fork method-not-found cleans the created path and reports unsupported", async () => {
  const root = mkdtempSync(join(tmpdir(), "restore-code-"));
  const createdPath = join(root, "worktree");
  const injected = deps(root);
  injected.createWorktree = async () => { mkdirSync(createdPath); return { worktreePath: createdPath }; };
  injected.forkIntoCwd = async () => { throw new Error("Method not found: _x.ai/session/fork"); };
  let removed = false;
  injected.removeWorktree = async () => { removed = true; rmSync(createdPath, { recursive: true, force: true }); };
  const response = await createRestoreCodeHandlers(injected).POST(new Request("http://127.0.0.1", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true }) }), { id: "session-1234" });
  assert.equal(response.status, 501);
  assert.equal((await response.json()).code, "unsupported");
  assert.equal(removed, true);
});

test("cleanup failure returns the exact residual worktree path", async () => {
  const root = mkdtempSync(join(tmpdir(), "restore-code-"));
  const createdPath = join(root, "worktree");
  const injected = deps(root);
  injected.createWorktree = async () => { mkdirSync(createdPath); return { worktreePath: createdPath }; };
  injected.forkIntoCwd = async () => { throw new Error("fork failed"); };
  injected.removeWorktree = async () => { throw new Error("remove failed"); };
  const response = await createRestoreCodeHandlers(injected).POST(new Request("http://127.0.0.1", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true }) }), { id: "session-1234" });
  assert.equal(response.status, 500);
  assert.equal((await response.json()).residualPath, createdPath);
});

test("rejects a returned original cwd before fork or removal", async () => {
  const root = mkdtempSync(join(tmpdir(), "restore-code-"));
  const injected = deps(root);
  let forks = 0;
  injected.createWorktree = async () => ({ worktreePath: root });
  injected.forkIntoCwd = async () => { forks += 1; return { newSessionId: "bad" }; };
  const response = await createRestoreCodeHandlers(injected).POST(new Request("http://127.0.0.1", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true }) }), { id: "session-1234" });
  assert.equal(response.status, 400);
  assert.equal(forks, 0);
});

test("collision is rejected before create", async () => {
  const root = mkdtempSync(join(tmpdir(), "restore-code-"));
  const injected = deps(root);
  injected.listWorktrees = async () => ({ worktrees: [{ branch: "restore/session" }] });
  await assert.rejects(preflightRestoreCode("session", injected), (error) => error.status === 409 && error.code === "worktree_conflict");
  assert.equal(injected.state(), 0);
});
