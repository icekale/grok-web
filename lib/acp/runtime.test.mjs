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

  it("fork returns a newSessionId from _x.ai/session/fork", async () => {
    const runtime = createRuntime();
    const sessionId = await runtime.createSession("/tmp/p");
    const result = await runtime.send(sessionId, { type: "fork" });
    assert.equal(result.cancelled, false);
    assert.ok(typeof result.newSessionId === "string" && result.newSessionId.length > 0);
    assert.notEqual(result.newSessionId, sessionId);
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

  it("set_model and set_thinking_level update get_state", async () => {
    const runtime = createRuntime();
    const sessionId = await runtime.createSession("/tmp/p");
    await runtime.send(sessionId, { type: "set_model", provider: "grok", modelId: "grok-4.5" });
    await runtime.send(sessionId, { type: "set_thinking_level", level: "high" });
    const state = await runtime.send(sessionId, { type: "get_state" });
    assert.deepEqual(state.model, { provider: "grok", id: "grok-4.5" });
    assert.equal(state.thinkingLevel, "high");
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

  it("set_thinking_level off does not call sessionSetMode", async () => {
    const modes = [];
    const runtime = new AgentRuntime({
      connect: async () => ({
        initialize: async () => ({}),
        sessionNew: async () => ({ sessionId: "s1" }),
        sessionSetMode: async (_sessionId, modeId) => {
          modes.push(modeId);
        },
        onSessionUpdate: () => () => {},
        onPermission: () => () => {},
        completePermission() {},
      }),
    });
    const sessionId = await runtime.createSession("/tmp/p");
    await runtime.send(sessionId, { type: "set_thinking_level", level: "high" });
    assert.deepEqual(modes, ["high"]);
    await runtime.send(sessionId, { type: "set_thinking_level", level: "off" });
    assert.deepEqual(modes, ["high"]);
    const state = await runtime.send(sessionId, { type: "get_state" });
    assert.equal(state.thinkingLevel, "off");
  });

  it("lists and toggles MCP through a session", async () => {
    const runtime = createRuntime();
    const listed = await runtime.listMcp();
    assert.ok(listed.servers.some((s) => s.name === "docs"));
    await runtime.toggleMcp("/tmp/p", "docs", false);
    const after = await runtime.listMcp();
    assert.equal(after.servers.find((s) => s.name === "docs")?.session?.enabled, false);
    await runtime.upsertMcp("/tmp/p", "tmpprobe", { command: "true" });
    assert.ok((await runtime.listMcp()).servers.some((s) => s.name === "tmpprobe"));
    await runtime.deleteMcp("/tmp/p", "tmpprobe");
    assert.ok(!(await runtime.listMcp()).servers.some((s) => s.name === "tmpprobe"));
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

  it("refuses to compact a session with no user messages", async () => {
    const runtime = createRuntime();
    const sessionId = await runtime.createSession("/tmp/p");
    await assert.rejects(
      runtime.send(sessionId, { type: "compact" }),
      /Nothing to compact/,
    );
  });

  it("lists the default Grok tool preset as active", async () => {
    const runtime = createRuntime();
    const sessionId = await runtime.createSession("/tmp/p");
    const tools = await runtime.send(sessionId, { type: "get_tools" });
    assert.ok(Array.isArray(tools));
    assert.ok(tools.some((tool) => tool.name === "bash" && tool.active === true));
    assert.ok(tools.some((tool) => tool.name === "read" && tool.active === true));
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

  it("reload succeeds without an ACP reload method", async () => {
    const runtime = createRuntime();
    const sessionId = await runtime.createSession("/tmp/p");
    const result = await runtime.send(sessionId, { type: "reload" });
    assert.deepEqual(result, { success: true });
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

  it("rejects prompt images because Grok ACP has no image prompt capability", async () => {
    const runtime = createRuntime();
    const sessionId = await runtime.createSession("/tmp/p");
    await assert.rejects(
      runtime.send(sessionId, {
        type: "prompt",
        message: "see this",
        images: [{ type: "image", data: "abc", mimeType: "image/png" }],
      }),
      /Images are not supported/,
    );
  });
});
