import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  it("sends attached images as ACP image content blocks", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const acp = new AcpConnection(new JsonRpcConn({ stdin, stdout }));
    const chunks = [];
    stdin.on("data", (c) => chunks.push(String(c)));
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
    const pending = acp.sessionPrompt("s1", "look", [{ type: "image", data: png, mimeType: "image/png" }]);
    await new Promise((r) => setImmediate(r));
    const sent = JSON.parse(chunks.join("").trim().split("\n").at(-1));
    assert.equal(sent.method, "session/prompt");
    assert.deepEqual(sent.params.prompt, [
      { type: "text", text: "look" },
      { type: "image", data: png, mimeType: "image/png" },
    ]);
    stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: sent.id, result: { stopReason: "end_turn" } })}\n`);
    assert.equal((await pending).stopReason, "end_turn");
  });

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

  it("snapshots pending permissions and resolves a race only once", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let now = 1_000;
    const acp = new AcpConnection(new JsonRpcConn({ stdin, stdout }), { now: () => now });
    const resolutions = [];
    acp.onPermissionResolved((event) => resolutions.push(event));
    const chunks = [];
    stdin.on("data", (chunk) => chunks.push(String(chunk)));
    stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "session/request_permission",
      params: {
        sessionId: "s1",
        toolCall: { title: "Allow bash", rawInput: { command: "git status", secret: "hidden" } },
        options: [
          { optionId: "allow-once", label: "Allow once", kind: "allow_once", raw: "hidden" },
          { optionId: "reject-once", label: "Reject", kind: "reject_once" },
        ],
      },
    })}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(acp.pendingPermissionsForSession("s1"), [{
      type: "extension_ui_request",
      id: "7",
      method: "confirm",
      title: "Allow bash",
      message: "git status",
      options: [
        { id: "allow-once", label: "Allow once", kind: "allow_once" },
        { id: "reject-once", label: "Reject", kind: "reject_once" },
      ],
      sessionId: "s1",
      expiresAt: 61_000,
    }]);
    now = 2_000;
    assert.equal(acp.pendingPermissionsForSession("s1")[0].expiresAt, 61_000);
    assert.deepEqual(acp.completePermission("s1", "7", { confirmed: true }), { status: "resolved" });
    assert.deepEqual(acp.completePermission("s1", "7", { cancelled: true }), { status: "already_resolved" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(chunks.join("").trim().split("\n").length, 1);
    assert.deepEqual(resolutions, [{ type: "permission_resolved", sessionId: "s1", id: "7", result: "confirmed" }]);
  });

  it("expires a pending permission and emits a terminal resolution", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const acp = new AcpConnection(new JsonRpcConn({ stdin, stdout }), { permissionTimeoutMs: 10 });
    const resolutions = [];
    acp.onPermissionResolved((event) => resolutions.push(event));
    stdout.write(`${JSON.stringify({
      jsonrpc: "2.0", id: 8, method: "session/request_permission",
      params: { sessionId: "s-timeout", toolCall: { title: "bash" } },
    })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(acp.pendingPermissionsForSession("s-timeout"), []);
    assert.deepEqual(resolutions, [{ type: "permission_resolved", sessionId: "s-timeout", id: "8", result: "timed_out" }]);
  });

  it("keeps identical request ids independent across sessions in snapshots", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const acp = new AcpConnection(new JsonRpcConn({ stdin, stdout }));
    for (const sessionId of ["s-a", "s-b"]) {
      stdout.write(`${JSON.stringify({
        jsonrpc: "2.0", id: 9, method: "session/request_permission",
        params: { sessionId, toolCall: { title: sessionId } },
      })}\n`);
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(acp.pendingPermissionsForSession("s-a")[0].sessionId, "s-a");
    assert.equal(acp.pendingPermissionsForSession("s-b")[0].sessionId, "s-b");
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

  it("sends reasoning effort in Grok set_model metadata", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const acp = new AcpConnection(new JsonRpcConn({ stdin, stdout }));
    const chunks = [];
    stdin.on("data", (chunk) => chunks.push(String(chunk)));
    const pending = acp.sessionSetModel("s-effort", "cpa/grok-4.6", "xhigh");
    await new Promise((resolve) => setImmediate(resolve));
    const sent = JSON.parse(chunks.join("").trim());
    assert.equal(sent.method, "session/set_model");
    assert.deepEqual(sent.params, {
      sessionId: "s-effort",
      modelId: "cpa/grok-4.6",
      _meta: { reasoningEffort: "xhigh" },
    });
    stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: sent.id, result: { _meta: { model: { Ok: "grok-4.6" } } } })}\n`);
    assert.equal((await pending).modelId, "cpa/grok-4.6");
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

  it("lists plugins, toggles one, and adds a marketplace source", async () => {
    const { child, acp } = spawnFake();
    try {
      await acp.initialize();
      const { sessionId } = await acp.sessionNew("/tmp/p");
      const listed = await acp.pluginsList(sessionId);
      assert.ok(listed.plugins.some((plugin) => plugin.name === "demo-plugin" && plugin.enabled === true));
      const disabled = await acp.pluginsAction(sessionId, { type: "disable", plugin_id: "demo-plugin" });
      assert.equal(disabled.status, "success");
      const after = await acp.pluginsList(sessionId);
      assert.equal(after.plugins.find((plugin) => plugin.name === "demo-plugin")?.enabled, false);
      await acp.pluginsAction(sessionId, { type: "enable", plugin_id: "demo-plugin" });
      const emptyMarket = await acp.marketplaceList(sessionId);
      assert.deepEqual(emptyMarket.sources, []);
      const added = await acp.marketplaceAction(sessionId, {
        type: "add_source",
        url: "https://example.com/probe.git",
      });
      assert.equal(added.status, "success");
      const market = await acp.marketplaceList(sessionId);
      assert.equal(market.sources.length, 1);
      assert.equal(market.sources[0].sourceUrlOrPath, "https://example.com/probe.git");
      await acp.marketplaceAction(sessionId, {
        type: "install",
        source_url_or_path: "https://example.com/probe.git",
        plugin_relative_path: "plugins/hello",
      });
      assert.ok((await acp.pluginsList(sessionId)).plugins.some((plugin) => plugin.name === "hello"));
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

  it("answers fs/read_text_file and fs/write_text_file client requests", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-client-fs-"));
    const path = join(dir, "note.txt");
    writeFileSync(path, "one\ntwo\nthree\n");
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const acp = new AcpConnection(new JsonRpcConn({ stdin, stdout }), {
      fsContext: (sessionId) => sessionId === "s1" ? { cwd: dir, roots: [dir] } : { roots: [] },
    });
    const chunks = [];
    stdin.on("data", (c) => chunks.push(String(c)));
    stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: "read-1",
      method: "fs/read_text_file",
      params: { sessionId: "s1", path, line: 2, limit: 1 },
    })}\n`);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(JSON.parse(chunks.splice(0).join("").trim()), {
      jsonrpc: "2.0",
      id: "read-1",
      result: { content: "two" },
    });

    const nested = join(dir, "nested", "out.txt");
    stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 44,
      method: "fs/write_text_file",
      params: { sessionId: "s1", path: nested, content: "saved" },
    })}\n`);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(JSON.parse(chunks.join("").trim()), {
      jsonrpc: "2.0",
      id: 44,
      result: null,
    });
    assert.equal(readFileSync(nested, "utf8"), "saved");
  });

  it("denies ACP fs requests outside the session jail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-client-fs-jail-"));
    const outside = join(mkdtempSync(join(tmpdir(), "acp-client-fs-out-")), "secret.txt");
    writeFileSync(outside, "secret");
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    new AcpConnection(new JsonRpcConn({ stdin, stdout }), {
      fsContext: () => ({ cwd: dir, roots: [dir] }),
    });
    const chunks = [];
    stdin.on("data", (c) => chunks.push(String(c)));
    stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: "read-out",
      method: "fs/read_text_file",
      params: { sessionId: "s1", path: outside },
    })}\n`);
    await new Promise((r) => setImmediate(r));
    const sent = JSON.parse(chunks.join("").trim());
    assert.equal(sent.id, "read-out");
    assert.equal(sent.error.code, -32603);
    assert.match(sent.error.message, /Access denied/);
    assert.equal(readFileSync(outside, "utf8"), "secret");
  });

  it("answers a permission request that uses a string JSON-RPC id", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const acp = new AcpConnection(new JsonRpcConn({ stdin, stdout }));
    const chunks = [];
    stdin.on("data", (c) => chunks.push(String(c)));
    stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: "perm-1",
      method: "session/request_permission",
      params: { sessionId: "session-a", toolCall: { title: "read_file" } },
    })}\n`);
    await new Promise((r) => setImmediate(r));
    acp.completePermission("session-a", "perm-1", { confirmed: true });
    await new Promise((r) => setImmediate(r));
    const sent = JSON.parse(chunks.join("").trim());
    assert.equal(sent.id, "perm-1");
    assert.equal(sent.result.outcome.outcome, "selected");
  });

  it("forwards permission-mode metadata on session/load", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const acp = new AcpConnection(new JsonRpcConn({ stdin, stdout }));
    const chunks = [];
    stdin.on("data", (c) => chunks.push(String(c)));
    const pending = acp.sessionLoad("sess-1", "/tmp/p", { yoloMode: true });
    await new Promise((r) => setImmediate(r));
    const sent = JSON.parse(chunks.join("").trim());
    assert.equal(sent.method, "session/load");
    assert.deepEqual(sent.params._meta, { yoloMode: true });
    stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: sent.id, result: { sessionId: "sess-1" } })}\n`);
    assert.equal((await pending).sessionId, "sess-1");
  });

  it("does not advertise an unimplemented terminal capability", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const acp = new AcpConnection(new JsonRpcConn({ stdin, stdout }));
    const chunks = [];
    stdin.on("data", (c) => chunks.push(String(c)));
    const pending = acp.initialize();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const sent = JSON.parse(chunks.join("").trim().split("\n").at(-1));
    assert.equal(sent.method, "initialize");
    assert.equal(sent.params.clientCapabilities.terminal, false);
    assert.equal(sent.params.clientCapabilities.fs.readTextFile, true);
    assert.equal(sent.params.clientCapabilities.fs.writeTextFile, true);
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

  it("forwards _x.ai/session/update notifications to onSessionUpdate", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const acp = new AcpConnection(new JsonRpcConn({ stdin, stdout }));
    const updates = [];
    acp.onSessionUpdate((sessionId, update) => updates.push({ sessionId, update }));
    stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      method: "_x.ai/session/update",
      params: {
        sessionId: "s1",
        update: { sessionUpdate: "auto_compact_failed", error: "it'll retry on the next turn" },
      },
    })}\n`);
    const deadline = Date.now() + 500;
    while (Date.now() < deadline && updates.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(updates[0]?.sessionId, "s1");
    assert.equal(updates[0]?.update.sessionUpdate, "auto_compact_failed");
  });
});
