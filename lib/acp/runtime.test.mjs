import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
});
