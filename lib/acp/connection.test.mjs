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
});
