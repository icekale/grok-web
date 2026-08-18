import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import { AcpConnection } from "./connection.ts";
import { JsonRpcConn } from "./jsonrpc.ts";
import { AgentRuntime, resetAgentRuntime } from "./runtime.ts";

function spawnFake() {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./fake-agent.mjs", import.meta.url))], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const rpc = new JsonRpcConn({ stdin: child.stdin, stdout: child.stdout });
  return { child, acp: new AcpConnection(rpc) };
}

describe("AgentRuntime", () => {
  /** @type {import("node:child_process").ChildProcess[]} */
  const children = [];

  afterEach(() => {
    resetAgentRuntime();
    for (const child of children.splice(0)) child.kill();
  });

  function createRuntime() {
    return new AgentRuntime({
      connect: async () => {
        const { child, acp } = spawnFake();
        children.push(child);
        return acp;
      },
    });
  }

  it("createSession + subscribe + prompt emit agent_start and a text or thinking delta", async () => {
    const runtime = createRuntime();
    const sessionId = await runtime.createSession("/tmp/p");
    const events = [];
    const stop = runtime.subscribe(sessionId, (event) => events.push(event));
    await runtime.send(sessionId, { type: "prompt", message: "Hi" });
    stop();
    assert.ok(events.some((event) => event.type === "agent_start"));
    assert.ok(events.some((event) => {
      const inner = event.assistantMessageEvent;
      return inner && (inner.type === "text_delta" || inner.type === "thinking_delta");
    }));
  });

  it("get_state after prompt is not running and listBusyIds is empty", async () => {
    const runtime = createRuntime();
    const sessionId = await runtime.createSession("/tmp/p");
    await runtime.send(sessionId, { type: "prompt", message: "Hi" });
    const state = await runtime.send(sessionId, { type: "get_state" });
    assert.equal(state.isPromptRunning, false);
    assert.equal(state.isStreaming, false);
    assert.deepEqual(runtime.listBusyIds(), []);
  });

  it("unknown command queue_remove throws not implemented in this phase", async () => {
    const runtime = createRuntime();
    const sessionId = await runtime.createSession("/tmp/p");
    await assert.rejects(
      runtime.send(sessionId, { type: "queue_remove" }),
      /not implemented in this phase/,
    );
  });

  it("loadSession missing rejects", async () => {
    const runtime = createRuntime();
    await assert.rejects(runtime.loadSession("missing"), /session not found/);
  });

  it("forwards permission prompts to session subscribers", async () => {
    const permissionHandlers = new Set();
    const runtime = new AgentRuntime({
      connect: async () => ({
        initialize: async () => ({}),
        sessionNew: async () => ({ sessionId: "sess-1" }),
        onSessionUpdate: () => () => {},
        onPermission: (handler) => {
          permissionHandlers.add(handler);
          return () => permissionHandlers.delete(handler);
        },
        completePermission: () => {},
      }),
    });
    const sessionId = await runtime.createSession("/tmp/p");
    const events = [];
    const stop = runtime.subscribe(sessionId, (event) => events.push(event));
    assert.equal(permissionHandlers.size, 1);
    for (const handler of permissionHandlers) {
      handler({
        type: "extension_ui_request",
        id: "42",
        method: "confirm",
        title: "Allow tool",
        message: "bash {\"cmd\":\"ls\"}",
        sessionId,
      });
    }
    stop();
    const ui = events.find((event) => event.type === "extension_ui_request");
    assert.ok(ui);
    assert.equal(ui.id, "42");
    assert.equal(ui.method, "confirm");
  });

  it("forwards ACP request_permission with params.sessionId to that session", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const acp = new AcpConnection(new JsonRpcConn({ stdin, stdout }), {
      permissionTimeoutMs: 20,
    });
    stdin.on("data", (chunk) => {
      for (const line of String(chunk).split("\n").filter(Boolean)) {
        const msg = JSON.parse(line);
        if (msg.method === "initialize") {
          stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } })}\n`);
        } else if (msg.method === "session/new") {
          stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-1" } })}\n`);
        }
      }
    });
    const runtime = new AgentRuntime({ connect: async () => acp });
    try {
      const sessionId = await runtime.createSession("/tmp/p");
      const events = [];
      const stop = runtime.subscribe(sessionId, (event) => events.push(event));
      stdout.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "session/request_permission",
        params: { sessionId, toolCall: { title: "bash", rawInput: { cmd: "ls" } } },
      })}\n`);
      await new Promise((resolve) => setImmediate(resolve));
      stop();
      const ui = events.find((event) => event.type === "extension_ui_request");
      assert.ok(ui);
      assert.equal(ui.id, "7");
      assert.equal(ui.sessionId, sessionId);
      await runtime.send(sessionId, { type: "extension_ui_response", id: "7", cancelled: true });
    } finally {
      stdin.end();
      stdout.end();
    }
  });

  it("abort cancels a WAIT prompt and clears busy", async () => {
    const runtime = createRuntime();
    const sessionId = await runtime.createSession("/tmp/p");
    const pending = runtime.send(sessionId, { type: "prompt", message: "WAIT" });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(runtime.isBusy(sessionId), true);
    await runtime.send(sessionId, { type: "abort" });
    const result = await pending;
    assert.equal(result.stopReason, "cancelled");
    assert.equal(runtime.isBusy(sessionId), false);
    assert.deepEqual(runtime.listBusyIds(), []);
  });

  it("follow-up while WAIT stays queued until WAIT completes, not until abort", async () => {
    const runtime = createRuntime();
    const sessionId = await runtime.createSession("/tmp/p");
    const events = [];
    runtime.subscribe(sessionId, (e) => events.push(e));
    const waiting = runtime.send(sessionId, { type: "prompt", message: "WAIT" });
    await new Promise((r) => setTimeout(r, 20));
    await runtime.send(sessionId, {
      type: "prompt",
      message: "later",
      streamingBehavior: "followUp",
    });
    assert.deepEqual(
      (await runtime.send(sessionId, { type: "get_state" })).queuedMessages,
      { steering: [], followUp: ["later"] },
    );
    await runtime.send(sessionId, { type: "abort" });
    await waiting;
    assert.deepEqual(
      (await runtime.send(sessionId, { type: "get_state" })).queuedMessages,
      { steering: [], followUp: ["later"] },
    );
  });

  it("steer while busy calls interject and does not queue follow-up", async () => {
    const interjects = [];
    let releaseFirst;
    const firstPrompt = new Promise((r) => { releaseFirst = r; });
    const runtime = new AgentRuntime({
      connect: async () => ({
        initialize: async () => ({}),
        sessionNew: async () => ({ sessionId: "s1" }),
        sessionPrompt: async () => {
          await firstPrompt;
          return { stopReason: "end_turn" };
        },
        sessionCancel() {},
        sessionInterject: async (_sessionId, text) => {
          interjects.push(text);
          return { result: { status: "queued" } };
        },
        onSessionUpdate: () => () => {},
        onPermission: () => () => {},
        completePermission() {},
      }),
    });
    const sessionId = await runtime.createSession("/tmp/p");
    const waiting = runtime.send(sessionId, { type: "prompt", message: "WAIT" });
    await new Promise((r) => setTimeout(r, 10));
    await runtime.send(sessionId, {
      type: "prompt",
      message: "nudge",
      streamingBehavior: "steer",
    });
    const state = await runtime.send(sessionId, { type: "get_state" });
    assert.deepEqual(interjects, ["nudge"]);
    assert.deepEqual(state.queuedMessages.followUp, []);
    releaseFirst();
    await waiting;
  });

  it("clear_queue returns the previous items and empties state", async () => {
    const runtime = createRuntime();
    const sessionId = await runtime.createSession("/tmp/p");
    const waiting = runtime.send(sessionId, { type: "prompt", message: "WAIT" });
    await new Promise((r) => setTimeout(r, 20));
    await runtime.send(sessionId, {
      type: "prompt",
      message: "later",
      streamingBehavior: "followUp",
    });
    const cleared = await runtime.send(sessionId, { type: "clear_queue" });
    assert.deepEqual(cleared, { steering: [], followUp: ["later"] });
    assert.deepEqual(
      (await runtime.send(sessionId, { type: "get_state" })).queuedMessages,
      { steering: [], followUp: [] },
    );
    await runtime.send(sessionId, { type: "abort" });
    await waiting;
  });

  it("drains the next follow-up after a successful prompt", async () => {
    const prompts = [];
    let releaseFirst;
    const firstPrompt = new Promise((r) => { releaseFirst = r; });
    const runtime = new AgentRuntime({
      connect: async () => ({
        initialize: async () => ({}),
        sessionNew: async () => ({ sessionId: "s1" }),
        sessionPrompt: async (sessionId, text) => {
          prompts.push(text);
          if (prompts.length === 1) await firstPrompt;
          return { stopReason: "end_turn" };
        },
        sessionCancel() {},
        sessionInterject: async () => ({ result: { status: "queued" } }),
        onSessionUpdate: () => () => {},
        onPermission: () => () => {},
        completePermission() {},
      }),
    });
    const sessionId = await runtime.createSession("/tmp/p");
    const first = runtime.send(sessionId, { type: "prompt", message: "one" });
    await new Promise((r) => setTimeout(r, 10));
    await runtime.send(sessionId, {
      type: "prompt",
      message: "two",
      streamingBehavior: "followUp",
    });
    assert.deepEqual(prompts, ["one"]);
    releaseFirst();
    await first;
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(prompts, ["one", "two"]);
  });
});
