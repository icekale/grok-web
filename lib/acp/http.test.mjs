import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import { AcpConnection } from "./connection.ts";
import { createAgentHandlers } from "./http.ts";
import { JsonRpcConn } from "./jsonrpc.ts";
import { AgentRuntime, resetAgentRuntime } from "./runtime.ts";

function spawnFake() {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./fake-agent.mjs", import.meta.url))], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const rpc = new JsonRpcConn({ stdin: child.stdin, stdout: child.stdout });
  return { child, acp: new AcpConnection(rpc) };
}

describe("createAgentHandlers", () => {
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

  function jsonRequest(url, body) {
    return new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("POST /api/agent/new with cwd + prompt returns 200 and a sessionId", async () => {
    const handlers = createAgentHandlers(createRuntime());
    const res = await handlers.postNew(jsonRequest("http://127.0.0.1/api/agent/new", {
      cwd: tmpdir(),
      type: "prompt",
      message: "Hi",
    }));
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.success, true);
    assert.ok(typeof body.sessionId === "string" && body.sessionId.length > 0);
    assert.equal(typeof body.data.promptGeneration, "number");
  });

  it("POST /api/agent/:id prompt returns 200 with numeric promptGeneration", async () => {
    const runtime = createRuntime();
    const handlers = createAgentHandlers(runtime);
    const created = await handlers.postNew(jsonRequest("http://127.0.0.1/api/agent/new", {
      cwd: tmpdir(),
      type: "ensure_session",
    }));
    const { sessionId } = await created.json();
    const res = await handlers.postSession(jsonRequest(`http://127.0.0.1/api/agent/${sessionId}`, {
      type: "prompt",
      message: "Hi",
    }), sessionId);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.success, true);
    assert.equal(typeof body.data.promptGeneration, "number");
  });

  it("GET /api/agent/:id returns running and state", async () => {
    const runtime = createRuntime();
    const handlers = createAgentHandlers(runtime);
    const created = await handlers.postNew(jsonRequest("http://127.0.0.1/api/agent/new", {
      cwd: tmpdir(),
      type: "ensure_session",
    }));
    const { sessionId } = await created.json();
    const res = await handlers.getSession(new Request(`http://127.0.0.1/api/agent/${sessionId}`), sessionId);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(typeof body.running, "boolean");
    assert.ok(body.state && typeof body.state === "object");
    assert.equal(typeof body.state.isPromptRunning, "boolean");
  });

  it("returns 503 when createSession throws grok-missing", async () => {
    const runtime = new AgentRuntime({
      connect: async () => {
        throw new Error("grok-missing: install grok or set GROK_BIN");
      },
    });
    const handlers = createAgentHandlers(runtime);
    const res = await handlers.postNew(jsonRequest("http://127.0.0.1/api/agent/new", {
      cwd: tmpdir(),
      type: "prompt",
      message: "Hi",
    }));
    const body = await res.json();
    assert.equal(res.status, 503);
    assert.match(String(body.error), /GROK_BIN/);
    assert.match(String(body.error), /install\.sh/);
  });

  it("returns 400 when cwd is missing", async () => {
    const handlers = createAgentHandlers(createRuntime());
    const res = await handlers.postNew(jsonRequest("http://127.0.0.1/api/agent/new", {
      type: "prompt",
      message: "Hi",
    }));
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.match(String(body.error), /cwd/i);
  });

  it("returns 400 when cwd directory does not exist", async () => {
    const handlers = createAgentHandlers(createRuntime());
    const res = await handlers.postNew(jsonRequest("http://127.0.0.1/api/agent/new", {
      cwd: join(tmpdir(), `acp-missing-${Date.now()}`),
      type: "prompt",
      message: "Hi",
    }));
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.match(String(body.error), /does not exist/i);
  });
});
