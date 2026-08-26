import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { after, afterEach, before, describe, it } from "node:test";
import { AcpConnection } from "./connection.ts";
import { JsonRpcConn } from "./jsonrpc.ts";
import { AgentRuntime, extraAcpReadRoots, getAgentRuntime, resetAgentRuntime, setAgentRuntime } from "./runtime.ts";
import { DEFAULT_RUNTIME_PROFILE } from "../runtime-profile.ts";

const previousGrokHome = process.env.GROK_HOME;
before(() => {
  process.env.GROK_HOME = mkdtempSync(join(tmpdir(), "grok-runtime-home-"));
});
after(() => {
  if (previousGrokHome === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = previousGrokHome;
});

function spawnFake() {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./fake-agent.mjs", import.meta.url))], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const rpc = new JsonRpcConn({ stdin: child.stdin, stdout: child.stdout });
  return { child, acp: new AcpConnection(rpc) };
}

function fakeChild(options = {}) {
  const listeners = { exit: [], error: [] };
  return {
    killed: false,
    exitCode: null,
    signalCode: null,
    kill(signal = "SIGTERM") {
      this.killed = true;
      const finish = () => {
        this.signalCode = signal;
        this.exitCode = 0;
        for (const fn of listeners.exit) fn(0, signal);
      };
      if (options.holdExit) options.held = finish;
      else queueMicrotask(finish);
      return true;
    },
    once(event, fn) {
      listeners[event]?.push(fn);
      return this;
    },
    removeListener(event, fn) {
      listeners[event] = (listeners[event] ?? []).filter((item) => item !== fn);
      return this;
    },
  };
}

function liveEffortRuntime({
  sessionId = "s-live-effort",
  modelId = "grok-4.6",
  selectedEffort,
  prompt = async () => ({ stopReason: "end_turn" }),
} = {}) {
  let starts = 0;
  const models = [];
  const acp = {
    initialize: async () => ({}),
    sessionNew: async () => ({
      sessionId,
      _meta: {
        "x.ai/sessionDetail": { currentModelId: modelId },
        ...(selectedEffort ? {
          "x.ai/sessionConfig": { options: [{ id: selectedEffort, category: "mode", selected: true }] },
        } : {}),
      },
    }),
    sessionLoad: async () => ({
      _meta: {
        "x.ai/sessionDetail": { currentModelId: modelId },
        ...(selectedEffort ? {
          "x.ai/sessionConfig": { options: [{ id: selectedEffort, category: "mode", selected: true }] },
        } : {}),
      },
    }),
    modelsList: async () => ({
      currentModelId: modelId,
      availableModels: [
        { modelId: "grok-4.6", name: "Grok 4.6" },
        { modelId: "cpa/grok-4.6", name: "Grok 4.6" },
        { modelId: "cpa/grok-imagine-image-2.0", name: "Imagine" },
      ],
    }),
    sessionSetModel: async (_id, nextModel, effort) => {
      models.push([nextModel, effort]);
      return { modelId: nextModel };
    },
    sessionPrompt: prompt,
    onSessionUpdate: () => () => {},
    onPermission: () => () => {},
  };
  const runtime = new AgentRuntime({
    connect: async () => {
      starts += 1;
      return Object.assign(acp, { child: fakeChild() });
    },
  });
  return { runtime, starts: () => starts, models };
}

function workspaceRuntime(calls) {
  let starts = 0;
  const acp = {
    initialize: async () => ({}),
    onSessionUpdate: () => () => {},
    onPermission: () => () => {},
    sessionLoad: async (sessionId, cwd) => ({ sessionId, cwd }),
    sessionNew: async (cwd) => {
      starts += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { sessionId: `workspace-${starts}`, cwd };
    },
    mcpList: async (sessionId) => { calls.push(["mcp", sessionId]); return { servers: [] }; },
    pluginsList: async (sessionId) => { calls.push(["plugins", sessionId]); return { plugins: [] }; },
    marketplaceList: async (sessionId) => { calls.push(["marketplace", sessionId]); return { sources: [] }; },
  };
  return {
    runtime: new AgentRuntime({ connect: async () => acp }),
    starts: () => starts,
  };
}

describe("AgentRuntime", () => {
  it("routes workspace tools by canonical cwd and deduplicates first initialization", async () => {
    const calls = [];
    const { runtime, starts } = workspaceRuntime(calls);
    const a = mkdtempSync(join(tmpdir(), "grok-workspace-a-"));
    const b = mkdtempSync(join(tmpdir(), "grok-workspace-b-"));
    const c = mkdtempSync(join(tmpdir(), "grok-workspace-c-"));
    await runtime.loadSession("session-a", a);
    await runtime.loadSession("session-b", b);
    await Promise.all([
      runtime.listMcp(join(b, ".")),
      runtime.listMcp(b),
    ]);
    await runtime.listPlugins(a);
    assert.deepEqual(calls, [
      ["mcp", "session-b"],
      ["mcp", "session-b"],
      ["plugins", "session-a"],
    ]);
    const startsBefore = starts();
    await Promise.all([runtime.listMcp(c), runtime.listMcp(join(c, "."))]);
    assert.equal(starts(), startsBefore + 1);
  });

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

  it("keeps queued prompt events tagged with their own generations", async () => {
    let update;
    let releaseFirst;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    const runtime = new AgentRuntime({
      connect: async () => ({
        initialize: async () => ({}),
        sessionNew: async () => ({ sessionId: "generation-session" }),
        onSessionUpdate: (handler) => { update = handler; return () => {}; },
        onPermission: () => () => {},
        sessionPrompt: async (_sessionId, text) => {
          update("generation-session", { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
          if (text === "one") await firstGate;
          return { stopReason: "end_turn" };
        },
      }),
    });
    const sessionId = await runtime.createSession("/tmp/generation");
    const entries = [];
    runtime.subscribeSequenced(sessionId, (entry) => entries.push(entry));
    const first = runtime.send(sessionId, { type: "prompt", message: "one", promptGeneration: 1 });
    const middle = runtime.send(sessionId, { type: "follow_up", message: "middle" });
    const second = runtime.send(sessionId, { type: "prompt", message: "two", promptGeneration: 2 });
    releaseFirst();
    await Promise.all([first, middle, second]);
    assert.deepEqual([...new Set(entries.filter((entry) => entry.event.type === "message_update").map((entry) => entry.promptGeneration))], [1, 2]);
  });

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
    const ended = events.find((event) => event.type === "message_end");
    assert.equal(ended?.message?.role, "assistant");
    assert.ok(Array.isArray(ended?.message?.content) && ended.message.content.length > 0);
  });

  it("maps fake-agent run_terminal_command updates to toolName bash", async () => {
    const runtime = createRuntime();
    const sessionId = await runtime.createSession("/tmp/p");
    const events = [];
    const stop = runtime.subscribe(sessionId, (event) => events.push(event));
    await runtime.send(sessionId, { type: "prompt", message: "BASH" });
    stop();
    const toolcallEnd = events.find((event) => event.assistantMessageEvent?.type === "toolcall_end");
    assert.equal(toolcallEnd?.assistantMessageEvent?.toolCall?.name, "bash");
    const execUpdates = events.filter((event) => event.type === "tool_execution_update");
    assert.ok(execUpdates.length > 0);
    for (const event of execUpdates) {
      assert.equal(event.toolName, "bash");
    }
  });

  it("keeps listener-only SSE subscriptions out of loaded session state", () => {
    const runtime = createRuntime();
    const stop = runtime.subscribe("arbitrary-sse-id", () => {});
    assert.equal(runtime.hasSession("arbitrary-sse-id"), false);
    stop();
    assert.equal(runtime.hasSession("arbitrary-sse-id"), false);
    assert.equal(runtime.listeners.has("arbitrary-sse-id"), false);
  });

  it("emits context_usage after turn_completed when signals.json exists", async () => {
    let pushUpdate;
    const runtime = new AgentRuntime({
      connect: async () => ({
        initialize: async () => ({}),
        onSessionUpdate: (handler) => {
          pushUpdate = handler;
          return () => {};
        },
        onPermission: () => () => {},
      }),
    });
    await runtime.ensureProcess();
    const sessionId = "01context-usage-bbbbbbbbbbbbbb";
    const dir = join(process.env.GROK_HOME, "sessions", encodeURIComponent("/tmp/ctx2"), sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "summary.json"), JSON.stringify({
      info: { id: sessionId, cwd: "/tmp/ctx2" },
      created_at: "2026-08-20T00:00:00.000Z",
      updated_at: "2026-08-20T00:00:00.000Z",
    }));
    writeFileSync(join(dir, "signals.json"), JSON.stringify({
      contextWindowUsage: 6,
      contextTokensUsed: 33669,
      contextWindowTokens: 500000,
    }));
    const events = [];
    const stop = runtime.subscribe(sessionId, (event) => events.push(event));
    pushUpdate(sessionId, { sessionUpdate: "turn_completed", usage: { totalTokens: 1 } });
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && !events.some((event) => event.type === "context_usage")) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    stop();
    const usageEvent = events.find((event) => event.type === "context_usage");
    assert.deepEqual(usageEvent?.contextUsage, {
      percent: 6,
      tokens: 33669,
      contextWindow: 500000,
    });
  });

  it("forwards session/update to SSE listeners before the session is loaded", async () => {
    let pushUpdate;
    const runtime = new AgentRuntime({
      connect: async () => ({
        initialize: async () => ({}),
        onSessionUpdate: (handler) => {
          pushUpdate = handler;
          return () => {};
        },
        onPermission: () => () => {},
      }),
    });
    await runtime.ensureProcess();
    const events = [];
    const stop = runtime.subscribe("sse-only", (event) => events.push(event));
    pushUpdate("sse-only", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } });
    stop();
    assert.equal(runtime.hasSession("sse-only"), false);
    assert.ok(events.some((event) => event.assistantMessageEvent?.type === "text_delta"));
  });

  it("an older startup failure cannot kill or clear a newer child", async () => {
    let resolveFirstConnection;
    const firstConnection = new Promise((resolve) => { resolveFirstConnection = resolve; });
    let rejectFirst;
    const firstInitialization = new Promise((_, reject) => { rejectFirst = reject; });
    const childA = {
      killed: false,
      kill() { this.killed = true; },
    };
    const childB = {
      killed: false,
      kill() { this.killed = true; },
    };
    const acpA = {
      initialize: () => firstInitialization,
      onSessionUpdate: () => () => {},
      onPermission: () => () => {},
    };
    const acpB = {
      initialize: async () => ({}),
      onSessionUpdate: () => () => {},
      onPermission: () => () => {},
    };
    let runtime;
    let attempts = 0;
    runtime = new AgentRuntime({
      connect: async () => {
        attempts += 1;
        if (attempts === 1) {
          runtime.child = childA;
          runtime.connectionChildren?.set(acpA, childA);
          return firstConnection;
        }
        runtime.child = childB;
        runtime.connectionChildren?.set(acpB, childB);
        return acpB;
      },
    });

    const first = runtime.startProcess();
    const firstRejected = assert.rejects(first, /first init failed/);
    await runtime.startProcess();
    resolveFirstConnection(acpA);
    await new Promise((resolve) => setImmediate(resolve));
    rejectFirst(new Error("first init failed"));
    await firstRejected;

    assert.equal(childA.killed, true);
    assert.equal(childB.killed, false);
    assert.strictEqual(runtime.child, childB);
    assert.strictEqual(runtime.acp, acpB);
  });

  it("an older successful startup disposes itself instead of replacing a newer ACP", async () => {
    let resolveFirstInitialization;
    const firstInitialization = new Promise((resolve) => { resolveFirstInitialization = resolve; });
    const childA = {
      killed: false,
      kill() { this.killed = true; },
    };
    const childB = {
      killed: false,
      kill() { this.killed = true; },
    };
    let closedA = 0;
    const acpA = {
      initialize: () => firstInitialization,
      close: () => { closedA += 1; },
      onSessionUpdate: () => () => {},
      onPermission: () => () => {},
    };
    const acpB = {
      initialize: async () => ({}),
      onSessionUpdate: () => () => {},
      onPermission: () => () => {},
    };
    let runtime;
    let attempts = 0;
    runtime = new AgentRuntime({
      connect: async () => {
        attempts += 1;
        const acp = attempts === 1 ? acpA : acpB;
        const child = attempts === 1 ? childA : childB;
        runtime.child = child;
        runtime.connectionChildren?.set(acp, child);
        return acp;
      },
    });

    const first = runtime.startProcess();
    const firstRejected = assert.rejects(first, /startup superseded/);
    await new Promise((resolve) => setImmediate(resolve));
    await runtime.startProcess();
    resolveFirstInitialization({});
    await firstRejected;

    assert.equal(closedA, 1);
    assert.equal(childA.killed, true);
    assert.equal(childB.killed, false);
    assert.strictEqual(runtime.child, childB);
    assert.strictEqual(runtime.acp, acpB);
  });

  it("a stale startup rejection cannot clear a newer in-flight startup for a third caller", async () => {
    let rejectFirst;
    const firstInitialization = new Promise((_, reject) => { rejectFirst = reject; });
    let resolveSecond;
    const secondInitialization = new Promise((resolve) => { resolveSecond = resolve; });
    const makeAcp = (initialize) => ({
      initialize,
      onSessionUpdate: () => () => {},
      onPermission: () => () => {},
    });
    const acps = [
      makeAcp(() => firstInitialization),
      makeAcp(() => secondInitialization),
      makeAcp(async () => ({})),
    ];
    let attempts = 0;
    const runtime = new AgentRuntime({
      connect: async () => acps[attempts++],
    });

    const first = runtime.ensureProcess();
    const firstRejected = assert.rejects(first, /first startup failed/);
    await new Promise((resolve) => setImmediate(resolve));
    runtime.dropConnection();
    const second = runtime.ensureProcess();
    const secondSettled = second.then(
      () => ({ status: "fulfilled" }),
      (error) => ({ status: "rejected", error }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    rejectFirst(new Error("first startup failed"));
    await firstRejected;
    const third = runtime.ensureProcess();
    await new Promise((resolve) => setImmediate(resolve));

    try {
      assert.equal(attempts, 2);
    } finally {
      resolveSecond({});
      await Promise.allSettled([secondSettled, third]);
    }
    assert.deepEqual(await secondSettled, { status: "fulfilled" });
    await third;
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

  it("get_state and get_session_stats report context usage from signals.json", async () => {
    const runtime = createRuntime();
    const sessionId = "01context-usage-aaaaaaaaaaaaaa";
    const dir = join(process.env.GROK_HOME, "sessions", encodeURIComponent("/tmp/ctx"), sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "summary.json"), JSON.stringify({
      info: { id: sessionId, cwd: "/tmp/ctx" },
      created_at: "2026-08-20T00:00:00.000Z",
      updated_at: "2026-08-20T00:00:00.000Z",
    }));
    writeFileSync(join(dir, "signals.json"), JSON.stringify({
      contextWindowUsage: 6,
      contextTokensUsed: 33669,
      contextWindowTokens: 500000,
      turnCount: 21,
      toolCallCount: 619,
    }));
    const usage = { percent: 6, tokens: 33669, contextWindow: 500000, userMessages: 21, toolCalls: 619 };
    const state = await runtime.send(sessionId, { type: "get_state" });
    assert.deepEqual(state.contextUsage, usage);
    const stats = await runtime.send(sessionId, { type: "get_session_stats" });
    assert.deepEqual(stats.contextUsage, usage);
    assert.equal(stats.userMessages, 21);
    assert.equal(stats.toolCalls, 619);
  });

  it("drops idle ACP sessions for a cwd so trust can reload them", async () => {
    const runtime = createRuntime();
    const sessionId = await runtime.createSession("/tmp/p");
    assert.equal(runtime.hasBusySessionForCwd("/tmp/p"), false);
    assert.equal(await runtime.dropSessionsForCwd("/tmp/p"), 1);
    assert.equal(runtime.hasSession(sessionId), false);
  });

  it("matches busy and dropped sessions through cwd aliases", async () => {
    const root = mkdtempSync(join(tmpdir(), "grok-runtime-alias-"));
    const cwd = join(root, "project");
    const alias = join(root, "alias");
    mkdirSync(cwd);
    symlinkSync(cwd, alias, "dir");
    const runtime = createRuntime();
    const sessionId = await runtime.createSession(alias);
    const waiting = runtime.send(sessionId, { type: "prompt", message: "WAIT" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    try {
      assert.equal(runtime.hasBusySessionForCwd(cwd), true);
      assert.equal(await runtime.dropSessionsForCwd(cwd), 1);
      await waiting;
      assert.equal(runtime.hasSession(sessionId), false);
    } finally {
      if (runtime.hasSession(sessionId)) {
        await runtime.send(sessionId, { type: "abort" });
        await waiting;
      }
    }
  });

  it("queue_remove and queue_edit change follow-ups", async () => {
    const runtime = createRuntime();
    const sessionId = await runtime.createSession("/tmp/p");
    const waiting = runtime.send(sessionId, { type: "prompt", message: "WAIT" });
    await new Promise((r) => setTimeout(r, 20));
    await runtime.send(sessionId, { type: "prompt", message: "a", streamingBehavior: "followUp" });
    await runtime.send(sessionId, { type: "prompt", message: "b", streamingBehavior: "followUp" });
    await runtime.send(sessionId, { type: "queue_edit", kind: "followUp", text: "a", replacement: "A" });
    const after = await runtime.send(sessionId, { type: "queue_remove", kind: "followUp", text: "b" });
    assert.deepEqual(after, { steering: [], followUp: ["A"] });
    await runtime.send(sessionId, { type: "abort" });
    await waiting;
  });

  it("queue_steer_item interjects that text while busy", async () => {
    const interjects = [];
    const runtime = new AgentRuntime({
      connect: async () => ({
        initialize: async () => ({}),
        sessionNew: async () => ({ sessionId: "s1" }),
        sessionPrompt: async () => {
          await new Promise((r) => setTimeout(r, 50));
          return { stopReason: "end_turn" };
        },
        sessionCancel() {},
        sessionInterject: async (_id, text) => {
          interjects.push(text);
          return { result: { status: "queued" } };
        },
        onSessionUpdate: () => () => {},
        onPermission: () => () => {},
        completePermission() {},
      }),
    });
    const sessionId = await runtime.createSession("/tmp/p");
    const first = runtime.send(sessionId, { type: "prompt", message: "one" });
    await new Promise((r) => setTimeout(r, 10));
    await runtime.send(sessionId, { type: "prompt", message: "nudge", streamingBehavior: "followUp" });
    await runtime.send(sessionId, { type: "queue_steer_item", kind: "followUp", text: "nudge" });
    assert.deepEqual(interjects, ["nudge"]);
    assert.deepEqual(
      (await runtime.send(sessionId, { type: "get_state" })).queuedMessages,
      { steering: [], followUp: [] },
    );
    await first;
  });

  it("queue_steer_all after abort sends queued follow-ups", async () => {
    const runtime = createRuntime();
    const sessionId = await runtime.createSession("/tmp/p");
    const events = [];
    runtime.subscribe(sessionId, (event) => events.push(event));
    const waiting = runtime.send(sessionId, { type: "prompt", message: "WAIT" });
    await new Promise((r) => setTimeout(r, 20));
    await runtime.send(sessionId, {
      type: "prompt",
      message: "later",
      streamingBehavior: "followUp",
    });
    await runtime.send(sessionId, { type: "abort" });
    await waiting;
    assert.deepEqual(
      (await runtime.send(sessionId, { type: "get_state" })).queuedMessages,
      { steering: [], followUp: ["later"] },
    );
    const before = events.length;
    await runtime.send(sessionId, { type: "queue_steer_all" });
    const after = events.slice(before);
    assert.ok(after.some((event) => event.type === "agent_start"));
    assert.deepEqual(
      (await runtime.send(sessionId, { type: "get_state" })).queuedMessages,
      { steering: [], followUp: [] },
    );
  });

  it("loadSession missing rejects", async () => {
    const runtime = createRuntime();
    await assert.rejects(runtime.loadSession("missing"), /session not found/);
  });

  it("reapplies permission-mode metadata on session/load", async () => {
    const configPath = join(process.env.GROK_HOME, "config.toml");
    writeFileSync(configPath, "[ui]\npermission_mode = \"always-approve\"\n");
    let loadMeta;
    try {
      const runtime = new AgentRuntime({
        connect: async () => ({
          initialize: async () => ({}),
          sessionLoad: async (_id, _cwd, meta) => {
            loadMeta = meta;
            return { sessionId: "s-load-meta" };
          },
          onSessionUpdate: () => () => {},
          onPermission: () => () => {},
          onClose: () => () => {},
        }),
      });
      await runtime.loadSession("s-load-meta", "/tmp/p");
      assert.deepEqual(loadMeta, { yoloMode: true });
    } finally {
      unlinkSync(configPath);
    }
  });

  it("does not create loaded state when session/new closes the connection before continuation", async () => {
    const closeHandlers = new Set();
    const acp = {
      initialize: async () => ({}),
      sessionNew: async () => {
        for (const handler of [...closeHandlers]) handler(new Error("closed"));
        return { sessionId: "same-turn-new" };
      },
      onSessionUpdate: () => () => {},
      onPermission: () => () => {},
      onClose: (handler) => {
        closeHandlers.add(handler);
        return () => closeHandlers.delete(handler);
      },
    };
    const runtime = new AgentRuntime({ connect: async () => acp });

    await assert.rejects(runtime.createSession("/tmp/p"), /connection changed/);
    assert.equal(runtime.hasSession("same-turn-new"), false);
  });

  it("uses connection generation when load responds, reconnects, then closes in the same turn", async () => {
    const closeHandlers = new Set();
    let runtime;
    let connectCount = 0;
    let loadCount = 0;
    const acp = {
      initialize: async () => ({}),
      sessionLoad: async (sessionId) => {
        loadCount += 1;
        if (loadCount === 1) {
          for (const handler of [...closeHandlers]) handler(new Error("closed"));
          await runtime.ensureProcess();
        }
        return { sessionId };
      },
      onSessionUpdate: () => () => {},
      onPermission: () => () => {},
      onClose: (handler) => {
        closeHandlers.add(handler);
        return () => closeHandlers.delete(handler);
      },
    };
    runtime = new AgentRuntime({
      connect: async () => {
        connectCount += 1;
        return acp;
      },
    });

    await assert.rejects(runtime.loadSession("same-turn-load", "/tmp/p"), /connection changed/);
    assert.equal(runtime.hasSession("same-turn-load"), false);
    await runtime.loadSession("same-turn-load", "/tmp/p");
    assert.equal(connectCount, 2);
    assert.equal(loadCount, 2);
    assert.equal(runtime.hasSession("same-turn-load"), true);
  });

  it("does not restore loaded state when session/resume closes before continuation", async () => {
    const closeHandlers = new Set();
    let resumeCount = 0;
    const acp = {
      initialize: async () => ({}),
      sessionNew: async () => ({ sessionId: "same-turn-resume" }),
      sessionResume: async () => {
        resumeCount += 1;
        for (const handler of [...closeHandlers]) handler(new Error("closed"));
        return {};
      },
      sessionLoad: async (sessionId) => ({ sessionId }),
      onSessionUpdate: () => () => {},
      onPermission: () => () => {},
      onClose: (handler) => {
        closeHandlers.add(handler);
        return () => closeHandlers.delete(handler);
      },
    };
    const runtime = new AgentRuntime({ connect: async () => acp });
    const sessionId = await runtime.createSession("/tmp/p");

    await assert.rejects(runtime.resumeSession(sessionId, "/tmp/p"), /connection changed/);
    assert.equal(resumeCount, 1);
    assert.equal(runtime.hasSession(sessionId), false);
    await runtime.loadSession(sessionId, "/tmp/p");
    assert.equal(runtime.hasSession(sessionId), true);
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

  it("does not expose permission prompts without a valid session id", async () => {
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
      }),
    });
    const sessionId = await runtime.createSession("/tmp/p");
    const events = [];
    runtime.subscribe(sessionId, (event) => events.push(event));
    for (const handler of permissionHandlers) {
      handler({
        type: "extension_ui_request",
        id: "42",
        method: "confirm",
        title: "Allow tool",
        message: "bash",
      });
    }
    assert.deepEqual(events, []);
  });

  it("completes permissions with the session receiving the UI response", async () => {
    const completed = [];
    const runtime = new AgentRuntime({
      connect: async () => ({
        initialize: async () => ({}),
        sessionNew: async () => ({ sessionId: "session-a" }),
        onSessionUpdate: () => () => {},
        onPermission: () => () => {},
        completePermission: (...args) => completed.push(args),
      }),
    });
    await runtime.createSession("/tmp/p");
    await runtime.send("fabricated", {
      type: "extension_ui_response",
      id: "42",
      confirmed: true,
    });
    assert.deepEqual(completed, [["fabricated", "42", { confirmed: true, cancelled: false }]]);
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
        } else if (msg.method === "session/set_model") {
          stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { _meta: { model: { Ok: msg.params?.modelId ?? "grok-4.6" } } } })}\n`);
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

  it("rejects an in-flight prompt on transport EOF, clears busy, and reconnects for load", async () => {
    const transports = [];
    let connectCount = 0;
    const runtime = new AgentRuntime({
      connect: async () => {
        connectCount += 1;
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        transports.push({ stdin, stdout });
        stdin.on("data", (chunk) => {
          for (const line of String(chunk).split("\n").filter(Boolean)) {
            const message = JSON.parse(line);
            if (message.method === "initialize") {
              stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} })}\n`);
            } else if (message.method === "session/new") {
              stdout.write(`${JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: { sessionId: "persisted-session" },
              })}\n`);
            } else if (message.method === "session/set_model") {
              stdout.write(`${JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: { _meta: { model: { Ok: message.params?.modelId ?? "grok-4.6" } } },
              })}\n`);
            } else if (message.method === "session/load") {
              stdout.write(`${JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: { sessionId: message.params.sessionId },
              })}\n`);
            }
          }
        });
        return new AcpConnection(new JsonRpcConn({ stdin, stdout }));
      },
    });

    const sessionId = await runtime.createSession("/tmp/p");
    const prompt = runtime.send(sessionId, { type: "prompt", message: "WAIT" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runtime.isBusy(sessionId), true);
    transports[0].stdout.end();

    await assert.rejects(prompt, /ACP JSON-RPC connection closed/);
    assert.equal(runtime.isBusy(sessionId), false);
    assert.equal(runtime.hasSession(sessionId), false);
    await runtime.loadSession(sessionId, "/tmp/p");
    assert.equal(connectCount, 2);
    assert.equal(runtime.hasSession(sessionId), true);
  });

  it("recovers after the actual ACP child exits during a prompt", async () => {
    let connectCount = 0;
    const runtime = new AgentRuntime({
      connect: async () => {
        connectCount += 1;
        const child = spawn(process.execPath, ["--input-type=module", "--eval", `
          import { createInterface } from "node:readline";
          const lines = createInterface({ input: process.stdin });
          const respond = (id, result) => {
            process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
          };
          lines.on("line", (line) => {
            const message = JSON.parse(line);
            if (message.method === "initialize") respond(message.id, {});
            else if (message.method === "session/new") respond(message.id, { sessionId: "child-exit-session" });
            else if (message.method === "session/set_model") respond(message.id, { _meta: { model: { Ok: message.params?.modelId ?? "grok-4.6" } } });
            else if (message.method === "session/load") respond(message.id, { sessionId: message.params.sessionId });
            else if (message.method === "session/prompt") setTimeout(() => process.exit(17), 20);
          });
        `], { stdio: ["pipe", "pipe", "inherit"] });
        children.push(child);
        return new AcpConnection(new JsonRpcConn({ stdin: child.stdin, stdout: child.stdout }));
      },
    });

    const sessionId = await runtime.createSession("/tmp/p");
    const prompt = runtime.send(sessionId, { type: "prompt", message: "exit now" });
    const rejected = assert.rejects(prompt, /ACP JSON-RPC connection closed/);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(runtime.isBusy(sessionId), true);
    await rejected;
    assert.equal(runtime.isBusy(sessionId), false);
    assert.equal(runtime.hasSession(sessionId), false);

    await runtime.loadSession(sessionId, "/tmp/p");
    assert.equal(connectCount, 2);
    assert.equal(runtime.hasSession(sessionId), true);
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

  it("fork returns a newSessionId from _x.ai/session/fork", async () => {
    const runtime = createRuntime();
    const sessionId = await runtime.createSession("/tmp/p");
    const result = await runtime.send(sessionId, { type: "fork" });
    assert.equal(result.cancelled, false);
    assert.ok(typeof result.newSessionId === "string" && result.newSessionId.length > 0);
    assert.notEqual(result.newSessionId, sessionId);
  });

  it("does not create loaded fork state when the ACP closes during session/fork", async () => {
    const closeHandlers = new Set();
    const acp = {
      initialize: async () => ({}),
      sessionNew: async () => ({ sessionId: "fork-source" }),
      sessionFork: async () => {
        for (const handler of [...closeHandlers]) handler(new Error("closed"));
        return { newSessionId: "stale-fork" };
      },
      onSessionUpdate: () => () => {},
      onPermission: () => () => {},
      onClose: (handler) => {
        closeHandlers.add(handler);
        return () => closeHandlers.delete(handler);
      },
    };
    const runtime = new AgentRuntime({ connect: async () => acp });
    const sessionId = await runtime.createSession("/tmp/p");

    await assert.rejects(runtime.send(sessionId, { type: "fork" }), /connection changed/);
    assert.equal(runtime.hasSession("stale-fork"), false);
    assert.equal(runtime.hasSession(sessionId), false);
  });

  it("navigate_tree rewinds the current session", async () => {
    const rewinds = [];
    const runtime = new AgentRuntime({
      connect: async () => ({
        initialize: async () => ({}),
        sessionNew: async () => ({ sessionId: "s1" }),
        sessionLoad: async () => ({ sessionId: "s1" }),
        sessionPrompt: async () => ({ stopReason: "end_turn" }),
        sessionCancel() {},
        sessionInterject: async () => ({}),
        sessionFork: async () => ({ newSessionId: "s2" }),
        rewindExecute: async (sessionId, targetPromptIndex) => {
          rewinds.push({ sessionId, targetPromptIndex });
          return { success: true };
        },
        onSessionUpdate: () => () => {},
        onPermission: () => () => {},
        completePermission() {},
      }),
      resolveEntries: async () => ({
        messages: [
          { role: "user", content: "u0" },
          { role: "assistant", content: [], model: "g", provider: "grok" },
        ],
        entryIds: ["e0", "e1"],
      }),
    });
    const sessionId = await runtime.createSession("/tmp/p");
    const result = await runtime.send(sessionId, { type: "navigate_tree", targetId: "e1" });
    assert.equal(result.cancelled, false);
    assert.deepEqual(rewinds, [{ sessionId: "s1", targetPromptIndex: 0 }]);
  });

  it("fork with entryId rewinds the new session only", async () => {
    const rewinds = [];
    const runtime = new AgentRuntime({
      connect: async () => ({
        initialize: async () => ({}),
        sessionNew: async () => ({ sessionId: "s1" }),
        sessionPrompt: async () => ({ stopReason: "end_turn" }),
        sessionCancel() {},
        sessionInterject: async () => ({}),
        sessionFork: async () => ({ newSessionId: "s2" }),
        rewindExecute: async (sessionId, targetPromptIndex) => {
          rewinds.push({ sessionId, targetPromptIndex });
          return { success: true };
        },
        onSessionUpdate: () => () => {},
        onPermission: () => () => {},
        completePermission() {},
      }),
      resolveEntries: async () => ({
        messages: [
          { role: "user", content: "u0" },
          { role: "assistant", content: [], model: "g", provider: "grok" },
          { role: "user", content: "u1" },
        ],
        entryIds: ["e0", "e1", "e2"],
      }),
    });
    await runtime.createSession("/tmp/p");
    const result = await runtime.send("s1", { type: "fork", entryId: "e2" });
    assert.equal(result.newSessionId, "s2");
    assert.deepEqual(rewinds, [{ sessionId: "s2", targetPromptIndex: 1 }]);
  });

  it("seeds session/new metadata with the requested effort before ACP side calls", async () => {
    let meta;
    const runtime = new AgentRuntime({
      connect: async () => ({
        initialize: async () => ({}),
        sessionNew: async (_cwd, nextMeta) => {
          meta = nextMeta;
          return {
            sessionId: "s-new-meta-effort",
            _meta: { "x.ai/sessionDetail": { currentModelId: "cpa/grok-4.6" } },
          };
        },
        sessionSetModel: async () => ({ modelId: "cpa/grok-4.6" }),
        onSessionUpdate: () => () => {},
        onPermission: () => () => {},
      }),
    });
    await runtime.createSession("/tmp/p", {
      modelId: "cpa/grok-4.6",
      reasoningEffort: "xhigh",
    });
    assert.deepEqual(meta, {
      modelId: "cpa/grok-4.6",
      reasoningEffort: "xhigh",
    });
  });

  it("reapplies the session effort before each prompt", async () => {
    const calls = [];
    const runtime = new AgentRuntime({
      connect: async () => ({
        initialize: async () => ({}),
        sessionNew: async () => ({ sessionId: "s-prompt-effort" }),
        sessionSetModel: async (_sessionId, modelId, effort) => {
          calls.push(["model", modelId, effort]);
          return { modelId };
        },
        sessionPrompt: async () => {
          calls.push(["prompt"]);
          return { stopReason: "end_turn" };
        },
        onSessionUpdate: () => () => {},
        onPermission: () => () => {},
      }),
    });
    const sessionId = await runtime.createSession("/tmp/p");
    await runtime.send(sessionId, { type: "prompt", message: "Hi" });
    assert.deepEqual(calls.at(-2), ["model", "grok-4.6", "xhigh"]);
    assert.deepEqual(calls.at(-1), ["prompt"]);
  });

  it("createSession applies xhigh even when ACP selected effort is low", async () => {
    const models = [];
    const runtime = new AgentRuntime({
      connect: async () => ({
        initialize: async () => ({}),
        sessionNew: async () => ({
          sessionId: "s-create-effort",
          _meta: {
            "x.ai/sessionDetail": { currentModelId: "cpa/grok-4.6" },
            "x.ai/sessionConfig": { options: [{ id: "low", category: "mode", selected: true }] },
          },
        }),
        sessionSetModel: async (_sessionId, modelId, effort) => {
          models.push([modelId, effort]);
          return { modelId };
        },
        onSessionUpdate: () => () => {},
        onPermission: () => () => {},
      }),
    });
    const sessionId = await runtime.createSession("/tmp/p");
    assert.equal((await runtime.send(sessionId, { type: "get_state" })).thinkingLevel, "xhigh");
    assert.deepEqual(models, [["cpa/grok-4.6", "xhigh"]]);
  });

  it("createSession uses official xhigh for grok-4.6 and clamps xhigh off grok-4.5", async () => {
    const models = [];
    const runtime = new AgentRuntime({
      connect: async () => ({
        initialize: async () => ({}),
        sessionNew: async () => ({
          sessionId: "s-official-effort",
          _meta: { "x.ai/sessionDetail": { currentModelId: "grok-4.6" } },
        }),
        modelsList: async () => ({
          currentModelId: "grok-4.6",
          availableModels: [
            { modelId: "grok-4.6", name: "Grok 4.6" },
            { modelId: "grok-4.5", name: "Grok 4.5" },
          ],
        }),
        sessionSetModel: async (_sessionId, modelId, effort) => {
          models.push([modelId, effort]);
          return { modelId };
        },
        onSessionUpdate: () => () => {},
        onPermission: () => () => {},
      }),
    });
    const sessionId = await runtime.createSession("/tmp/p");
    assert.equal((await runtime.send(sessionId, { type: "get_state" })).thinkingLevel, "xhigh");
    await runtime.send(sessionId, { type: "set_thinking_level", level: "xhigh" });
    await runtime.send(sessionId, { type: "set_model", provider: "grok", modelId: "grok-4.5" });
    assert.equal((await runtime.send(sessionId, { type: "get_state" })).thinkingLevel, "high");
    assert.deepEqual(models, [
      ["grok-4.6", "xhigh"],
      ["grok-4.6", "xhigh"],
      ["grok-4.5", "high"],
    ]);
  });

  it("does not send effort when the model family has none", async () => {
    const models = [];
    const runtime = new AgentRuntime({
      connect: async () => ({
        initialize: async () => ({}),
        sessionNew: async () => ({
          sessionId: "s-imagine",
          _meta: { "x.ai/sessionDetail": { currentModelId: "cpa/grok-imagine-image-2.0" } },
        }),
        sessionSetModel: async (_sessionId, modelId, effort) => {
          models.push([modelId, effort]);
          return { modelId };
        },
        onSessionUpdate: () => () => {},
        onPermission: () => () => {},
      }),
    });
    const sessionId = await runtime.createSession("/tmp/p");
    assert.equal((await runtime.send(sessionId, { type: "get_state" })).thinkingLevel, undefined);
    assert.deepEqual(models, [["cpa/grok-imagine-image-2.0", undefined]]);
  });

  it("loadSession reapplies persisted xhigh instead of ACP selected low", async () => {
    const models = [];
    const runtime = new AgentRuntime({
      connect: async () => ({
        initialize: async () => ({}),
        sessionLoad: async () => ({
          _meta: {
            "x.ai/sessionDetail": { currentModelId: "cpa/grok-4.6" },
            "x.ai/sessionConfig": { options: [{ id: "low", category: "mode", selected: true }] },
          },
        }),
        sessionSetModel: async (_sessionId, modelId, effort) => {
          models.push([modelId, effort]);
          return { modelId };
        },
        onSessionUpdate: () => () => {},
        onPermission: () => () => {},
      }),
    });
    const sessionId = "01a033c5-load-effort";
    const dir = join(process.env.GROK_HOME, "sessions", encodeURIComponent("/tmp/effort-load"), sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "summary.json"), JSON.stringify({
      info: { id: sessionId, cwd: "/tmp/effort-load" },
      reasoning_effort: "xhigh",
      session_summary: "persisted",
      created_at: "2026-08-24T00:00:00.000Z",
      last_active_at: "2026-08-24T00:00:00.000Z",
    }));
    await runtime.loadSession(sessionId, "/tmp/effort-load");
    assert.equal((await runtime.send(sessionId, { type: "get_state" })).thinkingLevel, "xhigh");
    assert.deepEqual(models, [["cpa/grok-4.6", "xhigh"]]);
  });

  it("resumeSession reapplies persisted xhigh instead of ACP selected low", async () => {
    const models = [];
    const runtime = new AgentRuntime({
      connect: async () => ({
        initialize: async () => ({}),
        sessionResume: async () => ({
          _meta: {
            "x.ai/sessionDetail": { currentModelId: "cpa/grok-4.6" },
            "x.ai/sessionConfig": { options: [{ id: "low", category: "mode", selected: true }] },
          },
        }),
        sessionSetModel: async (_sessionId, modelId, effort) => {
          models.push([modelId, effort]);
          return { modelId };
        },
        onSessionUpdate: () => () => {},
        onPermission: () => () => {},
      }),
    });
    const sessionId = "01a033c5-resume-effort";
    const dir = join(process.env.GROK_HOME, "sessions", encodeURIComponent("/tmp/effort-resume"), sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "summary.json"), JSON.stringify({
      info: { id: sessionId, cwd: "/tmp/effort-resume" },
      reasoning_effort: "xhigh",
      session_summary: "persisted",
      created_at: "2026-08-24T00:00:00.000Z",
      last_active_at: "2026-08-24T00:00:00.000Z",
    }));
    await runtime.resumeSession(sessionId, "/tmp/effort-resume");
    assert.equal((await runtime.send(sessionId, { type: "get_state" })).thinkingLevel, "xhigh");
    assert.deepEqual(models, [["cpa/grok-4.6", "xhigh"]]);
  });

  it("does not rewrite the process-wide effort default at ACP startup", async () => {
    const source = await readFile(new URL("./runtime.ts", import.meta.url), "utf8");
    assert.doesNotMatch(source, /pinGrokDefaultReasoningEffort\(this\.spawnEffortArg\(\)\)/);
  });

  it("serializes concurrent thinking-level changes so the newest effort wins", async () => {
    const calls = [];
    const completed = [];
    let gateNextHigh = false;
    let releaseHigh;
    const highGate = new Promise((resolve) => { releaseHigh = resolve; });
    const runtime = new AgentRuntime({
      connect: async () => ({
        initialize: async () => ({}),
        sessionNew: async () => ({
          sessionId: "s-concurrent-effort",
          _meta: { "x.ai/sessionDetail": { currentModelId: "grok-4.6" } },
        }),
        sessionSetModel: async (_sessionId, modelId, effort) => {
          calls.push(effort);
          if (gateNextHigh && effort === "high") {
            gateNextHigh = false;
            await highGate;
          }
          completed.push(effort);
          return { modelId };
        },
        onSessionUpdate: () => () => {},
        onPermission: () => () => {},
      }),
    });
    const sessionId = await runtime.createSession("/tmp/p");
    gateNextHigh = true;
    const first = runtime.send(sessionId, { type: "set_thinking_level", level: "high" });
    await new Promise((resolve) => setImmediate(resolve));
    const second = runtime.send(sessionId, { type: "set_thinking_level", level: "xhigh" });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    releaseHigh();
    await Promise.all([first, second]);
    assert.equal((await runtime.send(sessionId, { type: "get_state" })).thinkingLevel, "xhigh");
  });

  it("set_model and set_thinking_level update get_state", async () => {
    const runtime = createRuntime();
    const sessionId = await runtime.createSession("/tmp/p");
    await runtime.send(sessionId, { type: "set_model", provider: "grok", modelId: "grok-4.5" });
    await runtime.send(sessionId, { type: "set_thinking_level", level: "high" });
    const state = await runtime.send(sessionId, { type: "get_state" });
    assert.deepEqual(state.model, { provider: "grok", id: "grok-4.5" });
    assert.equal(state.thinkingLevel, "high");
  });

  it("set_model does not reuse the permission mode RPC for reasoning effort", async () => {
    const modes = [];
    const models = [];
    const runtime = new AgentRuntime({
      connect: async () => ({
        initialize: async () => ({}),
        sessionNew: async () => ({ sessionId: "s-model-effort" }),
        sessionLoad: async () => ({}),
        modelsList: async () => ({
          currentModelId: "grok-4.6",
          availableModels: [
            { modelId: "grok-4.6", name: "Grok 4.6" },
            { modelId: "cpa/grok-4.6", name: "Grok 4.6" },
          ],
        }),
        sessionSetModel: async (_sessionId, modelId, effort) => {
          models.push([modelId, effort]);
          return { modelId };
        },
        sessionSetMode: async (_sessionId, modeId) => { modes.push(modeId); },
        onSessionUpdate: () => () => {},
        onPermission: () => () => {},
      }),
    });
    const sessionId = await runtime.createSession("/tmp/p");
    await runtime.send(sessionId, { type: "set_thinking_level", level: "xhigh" });
    await runtime.send(sessionId, { type: "set_model", provider: "cpa", modelId: "cpa/grok-4.6" });
    assert.deepEqual(modes, []);
    assert.deepEqual(models, [["grok-4.6", "xhigh"], ["grok-4.6", "xhigh"], ["cpa/grok-4.6", "xhigh"]]);
    assert.equal((await runtime.send(sessionId, { type: "get_state" })).thinkingLevel, "xhigh");
  });

  it("listModels returns grok-4.6 in modelList", async () => {
    const runtime = createRuntime();
    const data = await runtime.listModels();
    assert.ok(data.modelList.some((m) => m.id === "grok-4.6"));
  });

  it("exposes auth check login logout and api-key authenticate", async () => {
    const runtime = createRuntime();
    const status = await runtime.authCheck();
    assert.equal(status.authenticated, false);
    const url = await runtime.authGetUrl();
    assert.ok(url.auth_url);
    await runtime.authSubmitCode("999999");
    assert.equal((await runtime.authCheck()).authenticated, true);
    await runtime.authLogout();
    assert.equal((await runtime.authCheck()).authenticated, false);
    await runtime.authenticate("xai.api_key");
    assert.equal((await runtime.authCheck()).authenticated, true);
  });

  it("sends every thinking level in set_model metadata and preserves state on failure", async () => {
    const efforts = [];
    let rejectOff = false;
    const runtime = new AgentRuntime({
      connect: async () => ({
        initialize: async () => ({}),
        sessionNew: async () => ({ sessionId: "s1" }),
        sessionSetModel: async (_sessionId, modelId, effort) => {
          efforts.push(effort);
          if (rejectOff && effort === "off") throw new Error("effort unsupported");
          return { modelId };
        },
        onSessionUpdate: () => () => {},
        onPermission: () => () => {},
        completePermission() {},
      }),
    });
    const sessionId = await runtime.createSession("/tmp/p");
    await runtime.send(sessionId, { type: "set_thinking_level", level: "high" });
    await runtime.send(sessionId, { type: "set_thinking_level", level: "off" });
    assert.equal(efforts[0], "xhigh");
    assert.ok(efforts.includes("high"));
    assert.equal(efforts.at(-1), "off");
    assert.equal((await runtime.send(sessionId, { type: "get_state" })).thinkingLevel, "off");
    rejectOff = true;
    await assert.rejects(runtime.send(sessionId, { type: "set_thinking_level", level: "off" }), /effort unsupported/);
    assert.equal((await runtime.send(sessionId, { type: "get_state" })).thinkingLevel, "off");
  });

  it("passes the selected effort when re-applying the current model", async () => {
    let starts = 0;
    const models = [];
    const connection = {
      initialize: async () => ({}),
      sessionNew: async () => ({ sessionId: "s1" }),
      sessionSetModel: async (_sessionId, modelId, effort) => {
        models.push([modelId, effort]);
        return { modelId };
      },
      onSessionUpdate: () => () => {},
      onPermission: () => () => {},
      completePermission() {},
    };
    const runtime = new AgentRuntime({
      connect: async () => {
        starts += 1;
        return connection;
      },
    });
    const sessionId = await runtime.createSession("/tmp/p");
    await runtime.send(sessionId, { type: "set_thinking_level", level: "xhigh" });
    assert.equal(starts, 1);
    assert.deepEqual(models, [["grok-4.6", "xhigh"], ["grok-4.6", "xhigh"]]);
    assert.equal((await runtime.send(sessionId, { type: "get_state" })).thinkingLevel, "xhigh");
  });

  it("changes effort through ACP metadata without recycling the shared child", async () => {
    const { runtime, starts } = liveEffortRuntime({
      sessionId: "s-no-effort-recycle",
      selectedEffort: "high",
    });
    const sessionId = await runtime.createSession("/tmp/p");
    const before = starts();
    await runtime.send(sessionId, { type: "set_thinking_level", level: "xhigh" });
    assert.equal(starts(), before);
    assert.equal((await runtime.send(sessionId, { type: "get_state" })).thinkingLevel, "xhigh");
  });

  it("keeps explicit effort over persisted ACP effort", async () => {
    const sessionId = "s-recycle-effort";
    const { runtime, starts } = liveEffortRuntime({
      sessionId,
      selectedEffort: "low",
    });
    await runtime.createSession("/tmp/p");
    const dir = join(process.env.GROK_HOME, "sessions", encodeURIComponent("/tmp/p"), sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "summary.json"), JSON.stringify({
      info: { id: sessionId, cwd: "/tmp/p" },
      reasoning_effort: "high",
      session_summary: "persisted",
      created_at: "2026-08-24T00:00:00.000Z",
      last_active_at: "2026-08-24T00:00:00.000Z",
    }));
    await runtime.send(sessionId, { type: "set_thinking_level", level: "xhigh" });
    assert.equal(starts(), 1, "effort change must not recycle the shared child");
    assert.equal((await runtime.send(sessionId, { type: "get_state" })).thinkingLevel, "xhigh");
  });

  it("does not bounce the first official session through session/load ACP low", async () => {
    const { runtime, starts } = liveEffortRuntime({
      sessionId: "s-first-spawn",
      selectedEffort: "low",
    });
    const sessionId = await runtime.createSession("/tmp/p");
    assert.equal(starts(), 1);
    assert.equal((await runtime.send(sessionId, { type: "get_state" })).thinkingLevel, "xhigh");
  });

  it("loadSession ignores ACP selected effort when nothing is persisted", async () => {
    const models = [];
    const runtime = new AgentRuntime({
      connect: async () => ({
        initialize: async () => ({}),
        sessionLoad: async () => ({
          _meta: {
            "x.ai/sessionDetail": { currentModelId: "grok-4.6" },
            "x.ai/sessionConfig": { options: [{ id: "low", category: "mode", selected: true }] },
          },
        }),
        sessionSetModel: async (_sessionId, modelId, effort) => {
          models.push([modelId, effort]);
          return { modelId };
        },
        onSessionUpdate: () => () => {},
        onPermission: () => () => {},
      }),
    });
    await runtime.loadSession("s-load-default", "/tmp/effort-default");
    assert.equal((await runtime.send("s-load-default", { type: "get_state" })).thinkingLevel, "xhigh");
    assert.deepEqual(models, [["grok-4.6", "xhigh"]]);
  });

  it("respawns the shared child when idle effort no longer matches spawn", async () => {
    const { runtime, starts } = liveEffortRuntime({
      sessionId: "s-effort-respawn",
    });
    const sessionId = await runtime.createSession("/tmp/p");
    const before = starts();
    await runtime.send(sessionId, { type: "set_thinking_level", level: "high" });
    assert.ok(starts() > before);
    assert.equal((await runtime.send(sessionId, { type: "get_state" })).thinkingLevel, "high");
  });

  it("persists the selected effort so the next load cannot slide back", async () => {
    const sessionId = "s-persist-effort";
    const { runtime } = liveEffortRuntime({ sessionId });
    await runtime.createSession("/tmp/p");
    const dir = join(process.env.GROK_HOME, "sessions", encodeURIComponent("/tmp/p"), sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "summary.json"), JSON.stringify({
      info: { id: sessionId, cwd: "/tmp/p" },
      session_summary: "new",
      created_at: "2026-08-24T00:00:00.000Z",
      last_active_at: "2026-08-24T00:00:00.000Z",
    }));
    await runtime.send(sessionId, { type: "set_thinking_level", level: "high" });
    const saved = JSON.parse(await readFile(join(dir, "summary.json"), "utf8"));
    assert.equal(saved.reasoning_effort, "high");
  });

  it("does not restart the shared child when another session is busy", async () => {
    let n = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const models = [];
    const acp = {
      initialize: async () => ({}),
      sessionNew: async () => ({
        sessionId: `s-busy-${++n}`,
        _meta: { "x.ai/sessionDetail": { currentModelId: "grok-4.6" } },
      }),
      sessionLoad: async (id) => ({
        sessionId: id,
        _meta: { "x.ai/sessionDetail": { currentModelId: "grok-4.6" } },
      }),
      modelsList: async () => ({
        currentModelId: "grok-4.6",
        availableModels: [{ modelId: "grok-4.6", name: "Grok 4.6" }],
      }),
      sessionSetModel: async (_id, modelId, effort) => {
        models.push([modelId, effort]);
        return { modelId };
      },
      sessionPrompt: async (_id, text) => {
        if (text === "hold") await gate;
        return { stopReason: "end_turn" };
      },
      onSessionUpdate: () => () => {},
      onPermission: () => () => {},
    };
    let starts = 0;
    const runtime = new AgentRuntime({
      connect: async () => {
        starts += 1;
        return Object.assign(acp, { child: fakeChild() });
      },
    });
    const busyId = await runtime.createSession("/tmp/busy");
    const idleId = await runtime.createSession("/tmp/idle");
    const started = starts;
    const held = runtime.send(busyId, { type: "prompt", message: "hold" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runtime.send(idleId, { type: "set_thinking_level", level: "high" });
    assert.equal(starts, started);
    release();
    await held;
    assert.equal(starts, started);
    assert.equal((await runtime.send(idleId, { type: "get_state" })).thinkingLevel, "high");
  });

  it("switches from an effortless model to grok-4.6 through session metadata", async () => {
    const { runtime, starts } = liveEffortRuntime({
      sessionId: "s-model-recycle",
      modelId: "cpa/grok-imagine-image-2.0",
    });
    const sessionId = await runtime.createSession("/tmp/p");
    const started = starts();
    await runtime.send(sessionId, { type: "set_model", provider: "cpa", modelId: "cpa/grok-4.6" });
    assert.equal(starts(), started, "model switch must not recycle the shared child");
    assert.equal((await runtime.send(sessionId, { type: "get_state" })).thinkingLevel, "xhigh");
  });

  it("recycleProcess waits for the old child to exit before spawning", async () => {
    const hold = { holdExit: true, held: undefined };
    let starts = 0;
    const runtime = new AgentRuntime({
      connect: async () => {
        starts += 1;
        return {
          child: starts === 1 ? fakeChild(hold) : fakeChild(),
          initialize: async () => ({}),
          sessionNew: async () => ({ sessionId: "s-wait-exit" }),
          sessionLoad: async () => ({ sessionId: "s-wait-exit" }),
          onSessionUpdate: () => () => {},
          onPermission: () => () => {},
        };
      },
    });
    await runtime.createSession("/tmp/p");
    assert.equal(starts, 1);
    const recycled = runtime.recycleProcess();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(starts, 1);
    hold.held();
    await recycled;
    assert.equal(starts, 2);
  });

  it("reveals fallback modes only after a verified current-mode RPC round trip", async () => {
    const modeUpdates = new Set();
    let current = "default";
    const runtime = new AgentRuntime({
      capabilities: { version: "grok 1.0.5", globalFlags: new Set(["--permission-mode"]), agentFlags: new Set(), stdioFlags: new Set(), agents: [], warnings: [] },
      connect: async () => ({
        initialize: async () => ({}),
        sessionNew: async () => ({ sessionId: "fallback-mode-session" }),
        sessionSetMode: async (_sessionId, modeId) => {
          current = modeId;
          for (const handler of modeUpdates) handler("fallback-mode-session", modeId);
          return {};
        },
        onCurrentModeUpdate: (handler) => {
          const wrapped = (sessionId, modeId) => handler(sessionId, modeId);
          modeUpdates.add(wrapped);
          return () => modeUpdates.delete(wrapped);
        },
        onSessionUpdate: () => () => {},
        onPermission: () => () => {},
        completePermission() {},
      }),
    });
    const sessionId = await runtime.createSession("/tmp/fallback-modes");
    const state = await runtime.send(sessionId, { type: "get_state" });
    assert.equal(state.modes.current, current);
    assert.deepEqual(state.modes.available.map((mode) => mode.id), ["default", "plan", "auto", "bypassPermissions"]);
  });
  it("uses an advertised permission config option with readback", async () => {
    let current = "auto";
    const calls = [];
    const config = () => ({
      configOptions: [{
        id: "permission_mode",
        currentValue: current,
        options: [
          { value: "default", name: "Normal" },
          { value: "plan", name: "Plan" },
          { value: "auto", name: "Auto" },
          { value: "bypassPermissions", name: "Always-approve" },
        ],
      }],
    });
    const runtime = new AgentRuntime({
      connect: async () => ({
        initialize: async () => ({}),
        sessionNew: async () => ({ sessionId: "config-mode-session", ...config() }),
        sessionSetConfigOption: async (_sessionId, id, value) => {
          calls.push([id, value]);
          current = String(value);
          return { sessionId: "config-mode-session", ...config() };
        },
        onSessionUpdate: () => () => {},
        onPermission: () => () => {},
        completePermission() {},
      }),
    });
    const sessionId = await runtime.createSession("/tmp/config-modes");
    assert.deepEqual((await runtime.send(sessionId, { type: "get_state" })).modes.current, "auto");
    await runtime.send(sessionId, { type: "set_standard_mode", modeId: "plan" });
    assert.deepEqual(calls, [["permission_mode", "plan"]]);
    assert.equal((await runtime.send(sessionId, { type: "get_state" })).modes.current, "plan");
  });

  it("updates the current advertised mode from ACP mode notifications", async () => {
    let update;
    const runtime = new AgentRuntime({
      connect: async () => ({
        initialize: async () => ({}),
        sessionNew: async () => ({ sessionId: "rpc-mode-session", mode: { currentModeId: "default", availableModes: [{ id: "default", name: "Normal" }, { id: "plan", name: "Plan" }] } }),
        onSessionUpdate: (handler) => { update = handler; return () => {}; },
        onPermission: () => () => {},
        completePermission() {},
      }),
    });
    const sessionId = await runtime.createSession("/tmp/rpc-modes");
    update(sessionId, { sessionUpdate: "current_mode_update", currentModeId: "plan" });
    assert.equal((await runtime.send(sessionId, { type: "get_state" })).modes.current, "plan");
  });
  it("lists and toggles MCP through a session", async () => {
    const runtime = createRuntime();
    const listed = await runtime.listMcp("/tmp/p");
    assert.ok(listed.servers.some((s) => s.name === "docs"));
    await runtime.toggleMcp("/tmp/p", "docs", false);
    const after = await runtime.listMcp("/tmp/p");
    assert.equal(after.servers.find((s) => s.name === "docs")?.session?.enabled, false);
    await runtime.upsertMcp("/tmp/p", "tmpprobe", { command: "true" });
    assert.ok((await runtime.listMcp("/tmp/p")).servers.some((s) => s.name === "tmpprobe"));
    await runtime.deleteMcp("/tmp/p", "tmpprobe");
    assert.ok(!(await runtime.listMcp("/tmp/p")).servers.some((s) => s.name === "tmpprobe"));
  });

  it("lists plugins and marketplace through a session", async () => {
    const runtime = createRuntime();
    const listed = await runtime.listPlugins("/tmp/p");
    assert.ok(listed.plugins.some((plugin) => plugin.name === "demo-plugin"));
    await runtime.pluginsAction("/tmp/p", { type: "disable", plugin_id: "demo-plugin" });
    const after = await runtime.listPlugins("/tmp/p");
    assert.equal(after.plugins.find((plugin) => plugin.name === "demo-plugin")?.enabled, false);
    await runtime.marketplaceAction("/tmp/p", { type: "add_source", url: "https://example.com/probe.git" });
    const market = await runtime.listMarketplace("/tmp/p");
    assert.equal(market.sources[0]?.sourceUrlOrPath, "https://example.com/probe.git");
  });

  it("lists and toggles skills", async () => {
    const runtime = createRuntime();
    const listed = await runtime.listSkills("/tmp/p");
    assert.ok(listed.skills.some((s) => s.name === "demo" && s.enabled === true));
    const toggled = await runtime.toggleSkill("demo", false);
    assert.equal(toggled.skills.find((s) => s.name === "demo")?.enabled, false);
  });

  it("lists running subagents and cancels them", async () => {
    const runtime = createRuntime();
    const sessionId = await runtime.createSession("/tmp/p");
    await runtime.send(sessionId, { type: "prompt", message: "SPAWN_SUB" });
    const listed = await runtime.listRunningSubagents(sessionId);
    assert.equal(listed.subagents[0].subagentId, "sub-1");
    const cancelled = await runtime.cancelSubagent("sub-1");
    assert.equal(cancelled.cancelled, true);
  });

  it("compacts the current session", async () => {
    const runtime = createRuntime();
    const sessionId = await runtime.createSession("/tmp/p");
    await runtime.send(sessionId, { type: "prompt", message: "Hi" });
    const compacted = await runtime.send(sessionId, { type: "compact" });
    assert.equal(compacted.tokensBefore, 100);
    assert.equal(compacted.estimatedTokensAfter, 40);
  });

  it("emits prompt_error when the ACP turn stops with an error", async () => {
    let update;
    const runtime = new AgentRuntime({
      connect: async () => ({
        initialize: async () => ({}),
        sessionNew: async () => ({ sessionId: "err-session" }),
        onSessionUpdate: (handler) => { update = handler; return () => {}; },
        onPermission: () => () => {},
        sessionPrompt: async () => {
          update("err-session", {
            sessionUpdate: "retry_state",
            type: "failed",
            message: "API error (status 400 Bad Request): Request failed (HTTP 400).",
          });
          update("err-session", {
            sessionUpdate: "turn_completed",
            stop_reason: "error",
            agent_result: "API error (status 400 Bad Request): Request failed (HTTP 400).",
          });
          return { stopReason: "error" };
        },
      }),
    });
    const sessionId = await runtime.createSession("/tmp/err");
    const events = [];
    const stop = runtime.subscribe(sessionId, (event) => events.push(event));
    await runtime.send(sessionId, { type: "prompt", message: "hi" });
    stop();
    const errors = events.filter((event) => event.type === "prompt_error");
    assert.equal(errors.length, 1);
    assert.match(errors[0].errorMessage, /400/);
  });

  it("refuses to compact a session with no user messages", async () => {
    const runtime = createRuntime();
    const sessionId = await runtime.createSession("/tmp/p");
    await assert.rejects(
      runtime.send(sessionId, { type: "compact" }),
      /Nothing to compact/,
    );
  });

  it("treats ACP image user history as present user messages", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("./runtime.ts", import.meta.url), "utf8");
    const start = source.indexOf("async function diskHasUserMessages");
    assert.notEqual(start, -1);
    const fn = source.slice(start, source.indexOf("\n}", start) + 2);
    assert.match(fn, /historyUserText/);
    assert.doesNotMatch(fn, /typeof message\.content === "string"/);
    const { historyUserText, mapUpdatesJsonl } = await import("../history-map.ts");
    const fixture = await readFile(new URL("./fixtures/user-image.jsonl", import.meta.url), "utf8");
    const { messages } = mapUpdatesJsonl(fixture);
    assert.ok(messages.some((message) => (
      message.role === "user" && historyUserText(message.content).trim().length > 0
    )));
  });

  it("lists the default Grok tool preset as active", async () => {
    const runtime = createRuntime();
    const sessionId = await runtime.createSession("/tmp/p");
    const tools = await runtime.send(sessionId, { type: "get_tools" });
    assert.ok(Array.isArray(tools));
    assert.deepEqual(tools, [{ name: "default", description: "default", active: true }]);
    const state = await runtime.send(sessionId, { type: "get_state" });
    assert.deepEqual(state.toolPresets, ["none", "read-only", "default", "full"]);
  });

  it("maps set_tools through session/set_config_option and returns the updated state", async () => {
    const runtime = createRuntime();
    const sessionId = await runtime.createSession("/tmp/p");
    const tools = await runtime.send(sessionId, {
      type: "set_tools",
      toolNames: ["read-only"],
    });
    assert.deepEqual(tools, [{ name: "read-only", description: "read-only", active: true }]);
    const listed = await runtime.send(sessionId, { type: "get_tools" });
    assert.deepEqual(listed, [{ name: "read-only", description: "read-only", active: true }]);
  });

  it("rejects get_tools and set_tools when the agent does not advertise tools", async () => {
    const runtime = new AgentRuntime({
      connect: async () => ({
        initialize: async () => ({}),
        sessionNew: async () => ({ sessionId: "s-no-tools" }),
        onSessionUpdate: () => () => {},
        onPermission: () => () => {},
      }),
    });
    const sessionId = await runtime.createSession("/tmp/p");
    await assert.rejects(runtime.send(sessionId, { type: "get_tools" }), /not advertised/);
    await assert.rejects(runtime.send(sessionId, { type: "set_tools", toolNames: ["read"] }), /not advertised/);
  });

  it("aborts compaction by cancelling the ACP session", async () => {
    const cancelled = [];
    const runtime = new AgentRuntime({
      connect: async () => ({
        initialize: async () => ({}),
        sessionNew: async () => ({ sessionId: "s-compact" }),
        sessionCancel(sessionId) { cancelled.push(sessionId); },
        sessionPrompt: async () => ({ stopReason: "end_turn" }),
        onSessionUpdate: () => () => {},
        onPermission: () => () => {},
      }),
    });
    const sessionId = await runtime.createSession("/tmp/p");
    await runtime.send(sessionId, { type: "abort_compaction" });
    assert.deepEqual(cancelled, [sessionId]);
  });

  it("lists ACP available commands with enabled skills", async () => {
    const runtime = createRuntime();
    const sessionId = await runtime.createSession("/tmp/p");
    const listed = await runtime.send(sessionId, { type: "get_commands" });
    assert.ok(Array.isArray(listed.commands));
    const demos = listed.commands.filter((command) => command.name === "demo");
    assert.equal(demos.length, 1);
    assert.equal(demos[0].source, "skill");
    assert.equal(demos[0].description, "demo skill");
    assert.equal(demos[0].sourceInfo?.path, "/tmp/demo/SKILL.md");
    assert.ok(listed.commands.some((command) => command.name === "local"));
    const always = listed.commands.find((command) => command.name === "always-approve");
    assert.equal(always?.source, "extension");
    assert.equal(listed.commands.some((command) => command.name === "compact"), false);
  });

  it("omits disabled skills from slash commands", async () => {
    const runtime = createRuntime();
    const sessionId = await runtime.createSession("/tmp/p");
    await runtime.toggleSkill("demo", false);
    const listed = await runtime.send(sessionId, { type: "get_commands" });
    assert.equal(listed.commands.some((command) => command.name === "demo"), false);
    assert.ok(listed.commands.some((command) => command.name === "local"));
  });

  it("reload rebuilds the grok plugin registry then succeeds", async () => {
    const runtime = createRuntime();
    const sessionId = await runtime.createSession("/tmp/p");
    const result = await runtime.send(sessionId, { type: "reload" });
    assert.deepEqual(result, { success: true });
    const listed = await runtime.listPlugins("/tmp/p");
    assert.ok(listed.plugins.some((plugin) => plugin.name === "demo-plugin"));
  });

  it("runs bash over _x.ai/terminal and returns output", async () => {
    const runtime = createRuntime();
    const sessionId = await runtime.createSession("/tmp/p");
    const result = await runtime.send(sessionId, {
      type: "bash",
      command: "pwd",
      excludeFromContext: true,
    });
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /pwd/);
  });

  it("abort_bash kills the running terminal", async () => {
    const killed = [];
    let release;
    const waiting = new Promise((resolve) => { release = resolve; });
    const runtime = new AgentRuntime({
      connect: async () => ({
        initialize: async () => ({}),
        sessionNew: async () => ({ sessionId: "s-bash" }),
        terminalCreate: async () => ({ terminalId: "t1" }),
        terminalWaitForExit: async () => {
          await waiting;
          return { exitCode: 137 };
        },
        terminalOutput: async () => ({ output: "", truncated: false }),
        terminalKill: async (sessionId, terminalId) => {
          killed.push({ sessionId, terminalId });
          release();
          return { outcome: "killed" };
        },
        sessionPrompt: async () => ({ stopReason: "end_turn" }),
        onSessionUpdate: () => () => {},
        onPermission: () => () => {},
      }),
    });
    const sessionId = await runtime.createSession("/tmp/p");
    const running = runtime.send(sessionId, { type: "bash", command: "WAIT_BASH" });
    await new Promise((r) => setTimeout(r, 20));
    await runtime.send(sessionId, { type: "abort_bash" });
    await running;
    assert.deepEqual(killed, [{ sessionId, terminalId: "t1" }]);
  });

  it("counts bash as busy and rejects overlapping bash and prompt commands", async () => {
    let release;
    const waiting = new Promise((resolve) => { release = resolve; });
    let creates = 0;
    const runtime = new AgentRuntime({
      connect: async () => ({
        initialize: async () => ({}),
        sessionNew: async () => ({ sessionId: "s-busy-bash" }),
        terminalCreate: async () => ({ terminalId: `t${++creates}` }),
        terminalWaitForExit: async () => {
          await waiting;
          return { exitCode: 137 };
        },
        terminalOutput: async () => ({ output: "", truncated: false }),
        terminalKill: async () => {
          release();
          return { outcome: "killed" };
        },
        sessionPrompt: async () => ({ stopReason: "end_turn" }),
        onSessionUpdate: () => () => {},
        onPermission: () => () => {},
      }),
    });
    const sessionId = await runtime.createSession("/tmp/bash-busy");
    const running = runtime.send(sessionId, { type: "bash", command: "WAIT_BASH" });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(runtime.isBusy(sessionId), true);
    assert.deepEqual(runtime.listBusyIds(), [sessionId]);
    assert.equal(runtime.hasBusySessionForCwd("/tmp/bash-busy"), true);
    assert.deepEqual(await runtime.send(sessionId, { type: "get_state" }), {
      isStreaming: false,
      isPromptRunning: false,
      isBashRunning: true,
      model: { provider: "grok", id: "grok-4.6" },
      thinkingLevel: "xhigh",
      queuedMessages: { steering: [], followUp: [] },
      toolPresets: [],
    });
    await assert.rejects(
      runtime.send(sessionId, { type: "bash", command: "second" }),
      /session is busy/i,
    );
    await assert.rejects(
      runtime.send(sessionId, { type: "prompt", message: "overlap" }),
      /shell command is running/i,
    );
    assert.equal(creates, 1);

    await runtime.send(sessionId, { type: "abort_bash" });
    await running;
    assert.equal(runtime.isBusy(sessionId), false);
    assert.deepEqual(runtime.listBusyIds(), []);
    assert.equal(runtime.hasBusySessionForCwd("/tmp/bash-busy"), false);
  });

  it("dropping a cwd aborts its bash terminal before trust reload", async () => {
    const killed = [];
    let release;
    const waiting = new Promise((resolve) => { release = resolve; });
    const runtime = new AgentRuntime({
      connect: async () => ({
        initialize: async () => ({}),
        sessionNew: async () => ({ sessionId: "s-trust-bash" }),
        terminalCreate: async () => ({ terminalId: "trust-terminal" }),
        terminalWaitForExit: async () => {
          await waiting;
          return { exitCode: 137 };
        },
        terminalOutput: async () => ({ output: "", truncated: false }),
        terminalKill: async (sessionId, terminalId) => {
          killed.push({ sessionId, terminalId });
          release();
          return { outcome: "killed" };
        },
        sessionCancel() {},
        onSessionUpdate: () => () => {},
        onPermission: () => () => {},
      }),
    });
    const sessionId = await runtime.createSession("/tmp/trust-bash");
    const running = runtime.send(sessionId, { type: "bash", command: "WAIT_BASH" });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(await runtime.dropSessionsForCwd("/tmp/trust-bash"), 1);
    await running;
    assert.deepEqual(killed, [{ sessionId, terminalId: "trust-terminal" }]);
    assert.equal(runtime.hasSession(sessionId), false);
    assert.equal(runtime.isBusy(sessionId), false);
  });

  it("abort kills every tracked bash terminal", async () => {
    const killed = [];
    let release;
    const waiting = new Promise((resolve) => { release = resolve; });
    const runtime = new AgentRuntime({
      connect: async () => ({
        initialize: async () => ({}),
        sessionNew: async () => ({ sessionId: "s-abort-all" }),
        terminalCreate: async () => ({ terminalId: "t1" }),
        terminalWaitForExit: async () => {
          await waiting;
          return { exitCode: 137 };
        },
        terminalOutput: async () => ({ output: "", truncated: false }),
        terminalKill: async (_sessionId, terminalId) => {
          killed.push(terminalId);
          if (terminalId === "t1") release();
          return { outcome: "killed" };
        },
        sessionCancel() {},
        onSessionUpdate: () => () => {},
        onPermission: () => () => {},
      }),
    });
    const sessionId = await runtime.createSession("/tmp/abort-all");
    const running = runtime.send(sessionId, { type: "bash", command: "WAIT_BASH" });
    await new Promise((resolve) => setImmediate(resolve));
    runtime.sessions.get(sessionId).bashTerminalIds.add("t2");

    await runtime.send(sessionId, { type: "abort" });
    await running;
    assert.deepEqual(killed.sort(), ["t1", "t2"]);
    assert.equal(runtime.isBusy(sessionId), false);
  });

  it("clears bash state and cleans up terminals when terminal RPCs fail", async () => {
    for (const failure of ["create", "wait", "output"]) {
      const killed = [];
      const runtime = new AgentRuntime({
        connect: async () => ({
          initialize: async () => ({}),
          sessionNew: async () => ({ sessionId: `s-fail-${failure}` }),
          terminalCreate: async () => {
            if (failure === "create") throw new Error("create failed");
            return { terminalId: `t-${failure}` };
          },
          terminalWaitForExit: async () => {
            if (failure === "wait") throw new Error("wait failed");
            return { exitCode: 0 };
          },
          terminalOutput: async () => {
            if (failure === "output") throw new Error("output failed");
            return { output: "", truncated: false };
          },
          terminalKill: async (_sessionId, terminalId) => {
            killed.push(terminalId);
            return { outcome: "killed" };
          },
          onSessionUpdate: () => () => {},
          onPermission: () => () => {},
        }),
      });
      const sessionId = await runtime.createSession(`/tmp/fail-${failure}`);

      await assert.rejects(
        runtime.send(sessionId, { type: "bash", command: failure }),
        new RegExp(`${failure} failed`),
      );
      assert.equal(runtime.isBusy(sessionId), false);
      assert.deepEqual(runtime.listBusyIds(), []);
      assert.equal((await runtime.send(sessionId, { type: "get_state" })).isBashRunning, false);
      assert.deepEqual(killed, failure === "create" ? [] : [`t-${failure}`]);
    }
  });

  it("run_command sends the slash text as a prompt", async () => {
    const prompts = [];
    const runtime = new AgentRuntime({
      connect: async () => ({
        initialize: async () => ({}),
        sessionNew: async () => ({ sessionId: "s1" }),
        sessionPrompt: async (_sessionId, text) => {
          prompts.push(text);
          return { stopReason: "end_turn" };
        },
        onSessionUpdate: () => () => {},
        onPermission: () => () => {},
      }),
    });
    const sessionId = await runtime.createSession("/tmp/p");
    await runtime.send(sessionId, { type: "run_command", name: "session-info", args: "full" });
    assert.deepEqual(prompts, ["/session-info full"]);
  });

  it("sends feedback recap and prompt history commands", async () => {
    const runtime = createRuntime();
    const sessionId = await runtime.createSession("/tmp/p");
    assert.equal((await runtime.send(sessionId, { type: "feedback", text: "hello" })).success, true);
    assert.equal((await runtime.send(sessionId, { type: "recap" })).ok, true);
    assert.deepEqual((await runtime.send(sessionId, { type: "get_prompt_history" })).prompts, ["prev"]);
  });

  it("extension_ui_input stays unsupported", async () => {
    const runtime = createRuntime();
    const sessionId = await runtime.createSession("/tmp/p");
    await assert.rejects(
      runtime.send(sessionId, { type: "extension_ui_input", id: "x", data: "{}" }),
      /Extension custom UI is not supported/,
    );
  });

  it("accepts prompt images as ACP image content blocks", async () => {
    const runtime = createRuntime();
    const sessionId = await runtime.createSession("/tmp/p");
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
    const result = await runtime.send(sessionId, {
      type: "prompt",
      message: "see this",
      images: [{ type: "image", data: png, mimeType: "image/png" }],
    });
    assert.equal(result.stopReason, "end_turn");
  });

  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
  const pngImage = { type: "image", data: png, mimeType: "image/png" };

  function stubRuntime(sessionPrompt) {
    return new AgentRuntime({
      connect: async () => ({
        initialize: async () => ({}),
        sessionNew: async () => ({ sessionId: "s1" }),
        sessionPrompt,
        sessionCancel() {},
        sessionInterject: async () => ({ result: { status: "queued" } }),
        onSessionUpdate: () => () => {},
        onPermission: () => () => {},
        completePermission() {},
      }),
    });
  }

  it("passes the session effort into every sessionPrompt", async () => {
    const prompts = [];
    const runtime = new AgentRuntime({
      connect: async () => ({
        initialize: async () => ({}),
        sessionNew: async () => ({ sessionId: "s-prompt-effort" }),
        sessionSetModel: async (_id, modelId) => ({ modelId }),
        sessionPrompt: async (_id, text, _images, effort) => {
          prompts.push({ text, effort });
          return { stopReason: "end_turn" };
        },
        onSessionUpdate: () => () => {},
        onPermission: () => () => {},
      }),
    });
    const sessionId = await runtime.createSession("/tmp/p");
    await runtime.send(sessionId, { type: "set_thinking_level", level: "xhigh" });
    await runtime.send(sessionId, { type: "prompt", message: "Hi" });
    assert.deepEqual(prompts.at(-1), { text: "Hi", effort: "xhigh" });
  });

  it("forwards idle prompt images into sessionPrompt", async () => {
    const prompts = [];
    const runtime = stubRuntime(async (_id, text, images) => {
      prompts.push({ text, images });
      return { stopReason: "end_turn" };
    });
    const sessionId = await runtime.createSession("/tmp/p");
    await runtime.send(sessionId, { type: "prompt", message: "see this", images: [pngImage] });
    assert.deepEqual(prompts, [{ text: "see this", images: [pngImage] }]);
  });

  it("does not attach prior images to drained follow-ups", async () => {
    const prompts = [];
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const runtime = stubRuntime(async (_id, text, images) => {
      prompts.push({ text, images: images ?? [] });
      if (text === "one") await gate;
      return { stopReason: "end_turn" };
    });
    const sessionId = await runtime.createSession("/tmp/p");
    const first = runtime.send(sessionId, { type: "prompt", message: "one", images: [pngImage] });
    await new Promise((r) => setTimeout(r, 10));
    await runtime.send(sessionId, { type: "prompt", message: "later", streamingBehavior: "followUp" });
    release();
    await first;
    assert.deepEqual(prompts, [
      { text: "one", images: [pngImage] },
      { text: "later", images: [] },
    ]);
  });

  it("rejects images while a prompt is running", async () => {
    const runtime = stubRuntime(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return { stopReason: "end_turn" };
    });
    const sessionId = await runtime.createSession("/tmp/p");
    const first = runtime.send(sessionId, { type: "prompt", message: "one" });
    await new Promise((r) => setTimeout(r, 10));
    await assert.rejects(
      runtime.send(sessionId, {
        type: "prompt",
        message: "pic",
        streamingBehavior: "followUp",
        images: [pngImage],
      }),
      /Images cannot be sent while a prompt is running/,
    );
    await first;
  });

  it("passes a sanitized environment at the default spawn boundary", async () => {
    const source = await readFile(new URL("./runtime.ts", import.meta.url), "utf8");
    assert.match(source, /spawn\(bin, grokAgentArgs\(profile, capabilities, this\.spawnEffortArg\(\)\), grokAgentSpawnOptions\(\)\)/);
  });

  it("disposes the ACP connection exactly once", async () => {
    let closes = 0;
    const acp = {
      initialize: async () => ({}),
      onSessionUpdate: () => () => {},
      onPermission: () => () => {},
      onClose: () => () => {},
      close: () => { closes += 1; },
    };
    const runtime = new AgentRuntime({ connect: async () => acp });
    await runtime.ensureProcess();
    await runtime.dispose();
    await runtime.dispose();
    assert.equal(closes, 1);
    await assert.rejects(runtime.ensureProcess(), /disposed/);
  });

  it("force-terminates a child that ignores SIGTERM during dispose", async () => {
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"]);
    await new Promise((resolve) => child.once("spawn", resolve));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const exited = new Promise((resolve) => child.once("exit", (_code, signal) => resolve(signal)));
    const runtime = new AgentRuntime();
    runtime.child = child;
    await runtime.dispose();
    assert.equal(await exited, "SIGKILL");
  });

  it("keeps one AgentRuntime across getAgentRuntime calls", () => {
    resetAgentRuntime();
    const first = getAgentRuntime();
    assert.equal(getAgentRuntime(), first);
    setAgentRuntime(undefined);
    const second = getAgentRuntime();
    assert.notEqual(second, first);
    resetAgentRuntime();
  });

  it("rejects unadvertised standard modes before ACP RPC", async () => {
    let setCalls = 0;
    const runtime = new AgentRuntime({
      connect: async () => ({
        initialize: async () => ({}),
        onSessionUpdate: () => () => {},
        onPermission: () => () => {},
        sessionNew: async () => ({ sessionId: "mode-session", modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }] } }),
        sessionSetMode: async () => { setCalls += 1; },
      }),
    });
    const sessionId = await runtime.createSession("/tmp/modes");
    await assert.rejects(runtime.send(sessionId, { type: "set_standard_mode", modeId: "unknown" }), /not advertised/);
    await runtime.send(sessionId, { type: "set_standard_mode", modeId: "plan" });
    assert.equal(setCalls, 1);
    assert.equal((await runtime.send(sessionId, { type: "get_state" })).modes.current, "plan");
  });

  it("rejects invalid prompt images before sessionPrompt", async () => {
    const prompts = [];
    const runtime = stubRuntime(async (_id, text, images) => {
      prompts.push({ text, images });
      return { stopReason: "end_turn" };
    });
    const sessionId = await runtime.createSession("/tmp/p");
    await assert.rejects(
      runtime.send(sessionId, {
        type: "prompt",
        message: "see this",
        images: [{ type: "image", data: "not-base64", mimeType: "image/png" }],
      }),
      /valid base64 image/,
    );
    assert.deepEqual(prompts, []);
  });

  it("applies a runtime profile and reloads previously loaded sessions", async () => {
    const loads = [];
    const runtime = new AgentRuntime({
      connect: async () => ({
        initialize: async () => ({}),
        onSessionUpdate: () => () => {},
        onPermission: () => () => {},
        sessionNew: async (cwd) => ({ sessionId: "profile-session", cwd }),
        sessionLoad: async (sessionId, cwd) => { loads.push([sessionId, cwd]); return { sessionId, cwd }; },
      }),
    });
    const sessionId = await runtime.createSession("/tmp/profile");
    let stored = DEFAULT_RUNTIME_PROFILE;
    const next = { ...DEFAULT_RUNTIME_PROFILE, permissionMode: "plan" };
    const result = await runtime.applyRuntimeProfile(next, { read: () => stored, write: (value) => { stored = value; } });
    assert.equal(result.status, "applied");
    assert.equal(stored.permissionMode, "plan");
    assert.deepEqual(loads, [[sessionId, "/tmp/profile"]]);
  });

  it("rejects profile apply before writing when a session is busy", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const runtime = new AgentRuntime({
      connect: async () => ({
        initialize: async () => ({}),
        onSessionUpdate: () => () => {},
        onPermission: () => () => {},
        sessionNew: async () => ({ sessionId: "busy-profile" }),
        sessionPrompt: async () => { await gate; return { stopReason: "end_turn" }; },
      }),
    });
    const sessionId = await runtime.createSession("/tmp/profile-busy");
    const prompt = runtime.send(sessionId, { type: "prompt", message: "busy" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    let writes = 0;
    await assert.rejects(runtime.applyRuntimeProfile(DEFAULT_RUNTIME_PROFILE, { read: () => DEFAULT_RUNTIME_PROFILE, write: () => { writes += 1; } }), (error) => error.status === 409 && error.code === "runtime_busy");
    assert.equal(writes, 0);
    release();
    await prompt;
  });

  it("lets ACP read installed plugin skills and configured extra roots", () => {
    const configPath = join(process.env.GROK_HOME, "config.toml");
    writeFileSync(configPath, "[skills]\npaths = [\"~/custom-skills\"]\n");
    try {
      const roots = extraAcpReadRoots();
      assert.ok(roots.includes(join(process.env.GROK_HOME, "installed-plugins")));
      assert.ok(roots.includes(join(process.env.GROK_HOME, "docs")));
      assert.ok(roots.includes(join(process.env.GROK_HOME, "skills")));
      assert.ok(roots.includes(join(process.env.GROK_HOME, "commands")));
      assert.ok(roots.includes(join(process.env.GROK_HOME, "bundled", "skills")));
      assert.ok(roots.includes(join(process.env.GROK_HOME, "plugins")));
      assert.ok(roots.includes(join(homedir(), "custom-skills")));
    } finally {
      unlinkSync(configPath);
    }
  });
});
