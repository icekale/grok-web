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
      const loaded = await acp.sessionLoad(sessionId, "/tmp/p");
      assert.equal(loaded.sessionId, sessionId);
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
    const events = [];
    acp.onPermission((event) => events.push(event));
    const chunks = [];
    stdin.on("data", (c) => chunks.push(String(c)));
    stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 5,
      method: "session/request_permission",
      params: { sessionId: "session-timeout", toolCall: { title: "bash" } },
    })}\n`);
    await new Promise((r) => setTimeout(r, 20));
    const sent = JSON.parse(chunks.join("").trim());
    assert.equal(events[0].sessionId, "session-timeout");
    assert.equal(sent.jsonrpc, "2.0");
    assert.equal(sent.id, 5);
    assert.deepEqual(sent.result, { outcome: { outcome: "rejected" } });
  });

  it("rejects a permission without a valid session id without exposing it to UI", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const acp = new AcpConnection(new JsonRpcConn({ stdin, stdout }));
    const events = [];
    const chunks = [];
    acp.onPermission((event) => events.push(event));
    stdin.on("data", (chunk) => chunks.push(String(chunk)));
    stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 6,
      method: "session/request_permission",
      params: { sessionId: "", toolCall: { title: "bash" } },
    })}\n`);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(events, []);
    assert.deepEqual(JSON.parse(chunks.join("").trim()), {
      jsonrpc: "2.0",
      id: 6,
      result: { outcome: { outcome: "rejected" } },
    });
    acp.completePermission("fabricated", "6", { confirmed: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(chunks.join("").trim().split("\n").length, 1);
  });

  it("does not complete another session's permission with a fabricated session id", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const acp = new AcpConnection(new JsonRpcConn({ stdin, stdout }));
    const chunks = [];
    stdin.on("data", (chunk) => chunks.push(String(chunk)));
    stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 5,
      method: "session/request_permission",
      params: { sessionId: "session-a", toolCall: { title: "bash" } },
    })}\n`);
    await new Promise((resolve) => setImmediate(resolve));

    acp.completePermission("fabricated", "5", { confirmed: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(chunks.join(""), "");

    acp.completePermission("session-a", "5", { confirmed: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(JSON.parse(chunks.join("").trim()).id, 5);
  });

  it("keeps duplicate permission request ids separate across sessions", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const acp = new AcpConnection(new JsonRpcConn({ stdin, stdout }));
    const chunks = [];
    stdin.on("data", (chunk) => chunks.push(String(chunk)));
    for (const sessionId of ["session-a", "session-b"]) {
      stdout.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 9,
        method: "session/request_permission",
        params: { sessionId, toolCall: { title: sessionId } },
      })}\n`);
    }
    await new Promise((resolve) => setImmediate(resolve));

    acp.completePermission("session-b", "9", { cancelled: true });
    acp.completePermission("session-a", "9", { confirmed: true });
    await new Promise((resolve) => setImmediate(resolve));
    const sent = chunks.join("").trim().split("\n").map(JSON.parse);
    assert.equal(sent.length, 2);
    assert.deepEqual(sent.map((message) => message.id), [9, 9]);
    assert.deepEqual(sent.map((message) => message.result.outcome.outcome), ["rejected", "selected"]);
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

  it("stages discards and commits over _x.ai/git", async () => {
    const { child, acp } = spawnFake();
    try {
      await acp.initialize();
      const staged = await acp.gitStage(["readme.md"]);
      assert.deepEqual(staged.paths, ["readme.md"]);
      await assert.rejects(acp.gitDiscard([]), /paths/);
      const discarded = await acp.gitDiscard(["readme.md"]);
      assert.ok(discarded);
      const committed = await acp.gitCommit("msg");
      assert.equal(committed.ok, true);
    } finally {
      child.kill();
    }
  });

  it("sends feedback recap and prompt history over ACP", async () => {
    const { child, acp } = spawnFake();
    try {
      await acp.initialize();
      const { sessionId } = await acp.sessionNew("/tmp/p");
      assert.equal((await acp.feedback(sessionId, "hello")).success, true);
      assert.equal((await acp.recap(sessionId)).ok, true);
      assert.deepEqual((await acp.promptHistory("/tmp/p")).prompts, ["prev"]);
    } finally {
      child.kill();
    }
  });

  it("reads a file patch over _x.ai/git/diffs", async () => {
    const { child, acp } = spawnFake();
    try {
      await acp.initialize();
      const diffs = await acp.gitDiffs(["readme.md"], true);
      assert.equal(diffs.files[0].path, "readme.md");
      assert.match(diffs.files[0].patch, /@@/);
    } finally {
      child.kill();
    }
  });

  it("fuzzy-searches files over _x.ai/search", async () => {
    const { child, acp } = spawnFake();
    try {
      await acp.initialize();
      const matches = await acp.searchFuzzy("/tmp/p", "runtime");
      assert.ok(matches.some((match) => match.path.endsWith("runtime.ts")));
    } finally {
      child.kill();
    }
  });

  it("closes a session over ACP", async () => {
    const { child, acp } = spawnFake();
    try {
      await acp.initialize();
      const { sessionId } = await acp.sessionNew("/tmp/p");
      const closed = await acp.sessionClose(sessionId);
      assert.equal(closed._meta?.["x.ai/closeOutcome"] ?? closed.outcome, "closed");
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

  it("sends permission _meta on session/new", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const acp = new AcpConnection(new JsonRpcConn({ stdin, stdout }));
    const chunks = [];
    stdin.on("data", (c) => chunks.push(String(c)));
    const pending = acp.sessionNew("/tmp/p", { yoloMode: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const sent = JSON.parse(chunks.join("").trim().split("\n").at(-1));
    assert.equal(sent.method, "session/new");
    assert.deepEqual(sent.params._meta, { yoloMode: true });
    stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: sent.id, result: { sessionId: "s-yolo" } })}\n`);
    assert.equal((await pending).sessionId, "s-yolo");
  });

  it("sets a tools config option through session/set_config_option", async () => {
    const { child, acp } = spawnFake();
    try {
      await acp.initialize();
      const { sessionId } = await acp.sessionNew("/tmp/p");
      const updated = await acp.sessionSetConfigOption(sessionId, "tools", "full");
      assert.equal(updated.sessionId, sessionId);
      assert.equal(updated.configOptions[0].currentValue, "full");
    } finally {
      child.kill();
    }
  });

  it("renames a session over ACP", async () => {
    const { child, acp } = spawnFake();
    try {
      await acp.initialize();
      const { sessionId } = await acp.sessionNew("/tmp/p");
      const renamed = await acp.sessionRename(sessionId, "Hello");
      assert.equal(renamed.success, true);
    } finally {
      child.kill();
    }
  });

  it("initialize requests terminal capability and stores available commands", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const acp = new AcpConnection(new JsonRpcConn({ stdin, stdout }));
    const chunks = [];
    stdin.on("data", (c) => chunks.push(String(c)));
    const pending = acp.initialize();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const sent = JSON.parse(chunks.join("").trim().split("\n").at(-1));
    assert.equal(sent.method, "initialize");
    assert.equal(sent.params.clientCapabilities.terminal, true);
    stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: sent.id,
      result: {
        protocolVersion: 1,
        _meta: {
          grokShell: true,
          availableCommands: [{ name: "always-approve", description: "Toggle" }],
        },
      },
    })}\n`);
    await pending;
    assert.equal(acp.availableCommands[0].name, "always-approve");
  });

  it("runs a shell command over _x.ai/terminal", async () => {
    const { child, acp } = spawnFake();
    try {
      await acp.initialize();
      const { sessionId } = await acp.sessionNew("/tmp/p");
      const created = await acp.terminalCreate(sessionId, "pwd", { cwd: "/tmp/p", excludeFromContext: true });
      assert.equal(typeof created.terminalId, "string");
      const waited = await acp.terminalWaitForExit(sessionId, created.terminalId);
      assert.equal(waited.exitCode, 0);
      const out = await acp.terminalOutput(sessionId, created.terminalId);
      assert.match(out.output, /pwd/);
    } finally {
      child.kill();
    }
  });

  it("compacts a session over ACP", async () => {
    const { child, acp } = spawnFake();
    try {
      await acp.initialize();
      const { sessionId } = await acp.sessionNew("/tmp/p");
      const compacted = await acp.compactConversation(sessionId);
      assert.equal(compacted.tokensBefore, 100);
      assert.equal(compacted.estimatedTokensAfter, 40);
    } finally {
      child.kill();
    }
  });
});
