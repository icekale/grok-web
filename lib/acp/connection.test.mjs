import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { JsonRpcConn } from "./jsonrpc.ts";
import { AcpConnection } from "./connection.ts";

function spawnFake() {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./fake-agent.mjs", import.meta.url))], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const rpc = new JsonRpcConn({ stdin: child.stdin, stdout: child.stdout });
  return { child, acp: new AcpConnection(rpc) };
}

describe("AcpConnection", () => {
  it("creates a session, streams prompt updates, and rejects a missing load", async () => {
    const { child, acp } = spawnFake();
    try {
      await acp.initialize();
      const { sessionId } = await acp.sessionNew("/tmp/p");
      assert.equal(typeof sessionId, "string");
      const updates = [];
      const stop = acp.onSessionUpdate((_id, update) => updates.push(update));
      const result = await acp.sessionPrompt(sessionId, "Hi");
      stop();
      assert.equal(result.stopReason, "end_turn");
      assert.ok(updates.some((u) => u.sessionUpdate === "agent_thought_chunk"));
      assert.ok(updates.some((u) => u.sessionUpdate === "agent_message_chunk"));
      await assert.rejects(acp.sessionLoad("missing"), /session not found/);
    } finally {
      child.kill();
    }
  });

  it("auto-rejects a permission request after the timeout", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const acp = new AcpConnection(new JsonRpcConn({ stdin, stdout }), {
      permissionTimeoutMs: 10,
    });
    const chunks = [];
    stdin.on("data", (c) => chunks.push(String(c)));
    stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 5,
      method: "session/request_permission",
      params: { toolCall: { title: "bash" } },
    })}\n`);
    await new Promise((r) => setTimeout(r, 20));
    const sent = JSON.parse(chunks.join("").trim());
    assert.equal(sent.jsonrpc, "2.0");
    assert.equal(sent.id, 5);
    assert.deepEqual(sent.result, { outcome: { outcome: "rejected" } });
  });

  it("cancels a waiting prompt via session/cancel notification", async () => {
    const { child, acp } = spawnFake();
    try {
      await acp.initialize();
      const { sessionId } = await acp.sessionNew("/tmp/p");
      const pending = acp.sessionPrompt(sessionId, "WAIT");
      await new Promise((r) => setTimeout(r, 20));
      acp.sessionCancel(sessionId);
      const result = await pending;
      assert.equal(result.stopReason, "cancelled");
    } finally {
      child.kill();
    }
  });

  it("forks a session and returns newSessionId", async () => {
    const { child, acp } = spawnFake();
    try {
      await acp.initialize();
      const { sessionId } = await acp.sessionNew("/tmp/p");
      const forked = await acp.sessionFork({
        sourceSessionId: sessionId,
        sourceCwd: "/tmp/p",
        newCwd: "/tmp/p",
      });
      assert.ok(forked.newSessionId);
      assert.notEqual(forked.newSessionId, sessionId);
    } finally {
      child.kill();
    }
  });

  it("lists models and sets model and mode", async () => {
    const { child, acp } = spawnFake();
    try {
      await acp.initialize();
      const listed = await acp.modelsList();
      assert.equal(listed.currentModelId, "grok-4.6");
      assert.ok(listed.availableModels.some((m) => m.modelId === "grok-4.6"));
      const { sessionId } = await acp.sessionNew("/tmp/p");
      const set = await acp.sessionSetModel(sessionId, "grok-4.5");
      assert.equal(set.modelId, "grok-4.5");
      await acp.sessionSetMode(sessionId, "high");
    } finally {
      child.kill();
    }
  });

  it("lists reads and writes files over _x.ai/fs", async () => {
    const { child, acp } = spawnFake();
    try {
      await acp.initialize();
      const listed = await acp.fsList("/tmp/p");
      assert.ok(Array.isArray(listed.nodes));
      await acp.fsWrite("/tmp/p/a.txt", "hi");
      const read = await acp.fsRead("/tmp/p/a.txt");
      assert.equal(read.content, "hi");
    } finally {
      child.kill();
    }
  });

  it("reads git status and creates a worktree over ACP", async () => {
    const { child, acp } = spawnFake();
    try {
      await acp.initialize();
      const status = await acp.gitStatus();
      assert.equal(status.branch, "main");
      const created = await acp.worktreeCreate("sess-new-1", "/tmp/p");
      assert.equal(created.worktreePath, "/tmp/p-wt");
      assert.deepEqual(await acp.worktreeList(), []);
      await acp.worktreeRemove(created.worktreePath);
    } finally {
      child.kill();
    }
  });

  it("checks auth, starts device login, submits a code, cancels, and logs out", async () => {
    const { child, acp } = spawnFake();
    try {
      await acp.initialize();
      const status = await acp.authCheck();
      assert.equal(status.authenticated, false);
      const started = await acp.authGetUrl();
      assert.equal(started.mode, "device");
      assert.match(started.auth_url, /^https:\/\//);
      const submitted = await acp.authSubmitCode("123456");
      assert.equal(submitted.submitted, true);
      assert.equal((await acp.authCheck()).authenticated, true);
      const cancelled = await acp.authCancel();
      assert.equal(cancelled.cancelled, true);
      const loggedOut = await acp.authLogout();
      assert.equal(loggedOut.ok, true);
      assert.equal((await acp.authCheck()).authenticated, false);
    } finally {
      child.kill();
    }
  });

  it("lists toggles upserts and deletes MCP servers", async () => {
    const { child, acp } = spawnFake();
    try {
      await acp.initialize();
      const listed = await acp.mcpList();
      assert.ok(listed.servers.some((s) => s.name === "docs"));
      const { sessionId } = await acp.sessionNew("/tmp/p");
      await acp.mcpToggle(sessionId, "docs", false);
      const after = await acp.mcpList();
      const docs = after.servers.find((s) => s.name === "docs");
      assert.equal(docs.session?.enabled, false);
      await acp.mcpUpsert(sessionId, "tmpprobe", { command: "true" });
      assert.ok((await acp.mcpList()).servers.some((s) => s.name === "tmpprobe"));
      await acp.mcpDelete(sessionId, "tmpprobe");
      assert.ok(!(await acp.mcpList()).servers.some((s) => s.name === "tmpprobe"));
    } finally {
      child.kill();
    }
  });

  it("lists and toggles skills over ACP", async () => {
    const { child, acp } = spawnFake();
    try {
      await acp.initialize();
      const listed = await acp.skillsList("/tmp/p");
      assert.ok(listed.skills.some((s) => s.name === "demo" && s.enabled === true));
      const toggled = await acp.skillsToggle("demo", false);
      const demo = toggled.skills.find((s) => s.name === "demo");
      assert.equal(demo.enabled, false);
    } finally {
      child.kill();
    }
  });

  it("lists running subagents and cancels by subagentId", async () => {
    const { child, acp } = spawnFake();
    try {
      await acp.initialize();
      const { sessionId } = await acp.sessionNew("/tmp/p");
      const empty = await acp.subagentListRunning(sessionId);
      assert.deepEqual(empty.subagents, []);
      const started = await acp.sessionPrompt(sessionId, "SPAWN_SUB");
      assert.equal(started.stopReason, "end_turn");
      const listed = await acp.subagentListRunning(sessionId);
      assert.equal(listed.subagents.length, 1);
      assert.equal(listed.subagents[0].subagentId, "sub-1");
      assert.equal(listed.subagents[0].status, "running");
      const cancelled = await acp.subagentCancel("sub-1");
      assert.equal(cancelled.cancelled, true);
      assert.equal((await acp.subagentListRunning(sessionId)).subagents.length, 0);
      const missing = await acp.subagentCancel("nope");
      assert.equal(missing.cancelled, false);
      assert.equal(missing.outcome?.kind, "not_found");
    } finally {
      child.kill();
    }
  });
});
