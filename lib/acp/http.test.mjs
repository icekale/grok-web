import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it, test } from "node:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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

  it("accepts an Origin-less JSON CLI request to POST /api/agent/new", async () => {
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

  it("returns 501 when tool presets are not advertised", async () => {
    const runtime = new AgentRuntime({
      connect: async () => ({
        initialize: async () => ({}),
        sessionNew: async () => ({ sessionId: "s-no-tools" }),
        onSessionUpdate: () => () => {},
        onPermission: () => () => {},
      }),
    });
    const handlers = createAgentHandlers(runtime);
    const created = await handlers.postNew(jsonRequest("http://127.0.0.1/api/agent/new", {
      cwd: tmpdir(),
      type: "ensure_session",
    }));
    assert.equal(created.status, 200);
    const body = await created.json();
    const res = await handlers.postSession(jsonRequest("http://127.0.0.1/api/agent/s-no-tools", {
      type: "set_tools",
      toolNames: ["read"],
    }), body.sessionId);
    assert.equal(res.status, 501);
    const error = await res.json();
    assert.match(String(error.error), /not advertised/);
  });

  it("returns 404 when posting to a missing session", async () => {
    const handlers = createAgentHandlers(createRuntime());
    const res = await handlers.postSession(jsonRequest("http://127.0.0.1/api/agent/00000000-0000-0000-0000-000000000000", {}), "00000000-0000-0000-0000-000000000000");
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.match(String(body.error), /not found/i);
  });

  it("rejects text/plain POST /api/agent/new with 415", async () => {
    const handlers = createAgentHandlers(createRuntime());
    const res = await handlers.postNew(new Request("http://127.0.0.1/api/agent/new", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({
        cwd: tmpdir(),
        type: "ensure_session",
      }),
    }));
    assert.equal(res.status, 415);
  });

  it("POST /api/agent/new applies explicit model and effort before the first prompt", async () => {
    const calls = [];
    const runtime = new AgentRuntime({
      connect: async () => ({
        initialize: async () => ({}),
        sessionNew: async () => ({
          sessionId: "s-explicit-model-effort",
          _meta: {
            "x.ai/sessionDetail": { currentModelId: "grok-4.6" },
            "x.ai/sessionConfig": { options: [{ id: "high", category: "mode", selected: true }] },
          },
        }),
        modelsList: async () => ({
          currentModelId: "grok-4.6",
          availableModels: [
            { modelId: "grok-4.6", name: "Grok 4.6" },
            { modelId: "cpa/grok-4.6", name: "Grok 4.6" },
          ],
        }),
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
    const handlers = createAgentHandlers(runtime);
    const res = await handlers.postNew(jsonRequest("http://127.0.0.1/api/agent/new", {
      cwd: tmpdir(),
      type: "prompt",
      message: "Hi",
      provider: "cpa",
      modelId: "cpa/grok-4.6",
      thinkingLevel: "xhigh",
    }));
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.model.modelId, "cpa/grok-4.6");
    assert.equal(body.thinkingLevel, "xhigh");
    assert.deepEqual(calls, [
      ["model", "cpa/grok-4.6", "high"],
      ["model", "cpa/grok-4.6", "xhigh"],
      ["prompt"],
    ]);
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

  it("rejects text/plain POST /api/agent/:id with 415", async () => {
    const runtime = createRuntime();
    const handlers = createAgentHandlers(runtime);
    const created = await handlers.postNew(jsonRequest("http://127.0.0.1/api/agent/new", {
      cwd: tmpdir(),
      type: "ensure_session",
    }));
    const { sessionId } = await created.json();
    const res = await handlers.postSession(new Request(`http://127.0.0.1/api/agent/${sessionId}`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ type: "get_state" }),
    }), sessionId);
    assert.equal(res.status, 415);
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

  it("compact on a just-created session does not reload ACP and refuses empty history", async () => {
    const runtime = createRuntime();
    const handlers = createAgentHandlers(runtime);
    const created = await handlers.postNew(jsonRequest("http://127.0.0.1/api/agent/new", {
      cwd: tmpdir(),
      type: "ensure_session",
    }));
    const { sessionId } = await created.json();
    const res = await handlers.postSession(jsonRequest(`http://127.0.0.1/api/agent/${sessionId}`, {
      type: "compact",
    }), sessionId);
    const body = await res.json();
    assert.equal(res.status, 500);
    assert.match(String(body.error), /Nothing to compact/);
  });

  it("accepts prompt images over the agent HTTP API", async () => {
    const runtime = createRuntime();
    const handlers = createAgentHandlers(runtime);
    const created = await handlers.postNew(jsonRequest("http://127.0.0.1/api/agent/new", {
      cwd: tmpdir(),
      type: "ensure_session",
    }));
    const { sessionId } = await created.json();
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
    const res = await handlers.postSession(jsonRequest(`http://127.0.0.1/api/agent/${sessionId}`, {
      type: "prompt",
      message: "see this",
      images: [{ type: "image", data: png, mimeType: "image/png" }],
    }), sessionId);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
  });

  it("rejects invalid prompt images over the agent HTTP API", async () => {
    const runtime = createRuntime();
    const handlers = createAgentHandlers(runtime);
    const created = await handlers.postNew(jsonRequest("http://127.0.0.1/api/agent/new", {
      cwd: tmpdir(),
      type: "ensure_session",
    }));
    const { sessionId } = await created.json();
    const res = await handlers.postSession(jsonRequest(`http://127.0.0.1/api/agent/${sessionId}`, {
      type: "prompt",
      message: "see this",
      images: [{ type: "image", data: "not-base64", mimeType: "image/png" }],
    }), sessionId);
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.code, "prompt_rejected");
    assert.match(String(body.error), /valid base64 image/);
  });

  it("POST abort on a WAIT prompt returns 200", async () => {
    const runtime = createRuntime();
    const handlers = createAgentHandlers(runtime);
    const created = await handlers.postNew(jsonRequest("http://127.0.0.1/api/agent/new", {
      cwd: tmpdir(),
      type: "ensure_session",
    }));
    const { sessionId } = await created.json();
    const waiting = handlers.postSession(jsonRequest(`http://127.0.0.1/api/agent/${sessionId}`, {
      type: "prompt",
      message: "WAIT",
    }), sessionId);
    await new Promise((r) => setTimeout(r, 20));
    const res = await handlers.postSession(jsonRequest(`http://127.0.0.1/api/agent/${sessionId}`, {
      type: "abort",
    }), sessionId);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.notEqual(body.code, "prompt_rejected");
    await waiting;
  });

  it("POST fork returns newSessionId", async () => {
    const runtime = createRuntime();
    const handlers = createAgentHandlers(runtime);
    const created = await handlers.postNew(jsonRequest("http://127.0.0.1/api/agent/new", {
      cwd: tmpdir(),
      type: "ensure_session",
    }));
    const { sessionId } = await created.json();
    const res = await handlers.postSession(jsonRequest(`http://127.0.0.1/api/agent/${sessionId}`, {
      type: "fork",
    }), sessionId);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.success, true);
    assert.ok(body.data.newSessionId);
    assert.notEqual(body.code, "prompt_rejected");
  });
});

test("GET agent state loads disk sessions before get_state", async () => {
  const source = await readFile(new URL("./http.ts", import.meta.url), "utf8");
  const getSession = source.slice(source.indexOf("async getSession"), source.indexOf("async getRunning"));
  assert.match(getSession, /loadSessionIfNeeded/);
});

test("an SSE-first listener does not prevent loading a persisted session", async () => {
  const home = await mkdtemp(join(tmpdir(), "grok-http-sse-first-"));
  const previousHome = process.env.GROK_HOME;
  const id = "01eeeeeeeeeeeeeeeeeeeeeeee";
  const cwd = tmpdir();
  const dir = join(home, "sessions", encodeURIComponent(cwd), id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "summary.json"), JSON.stringify({
    info: { id, cwd },
    created_at: "2026-08-20T00:00:00.000Z",
    updated_at: "2026-08-20T00:00:00.000Z",
  }));
  process.env.GROK_HOME = home;
  const loaded = [];
  const runtime = new AgentRuntime({
    connect: async () => ({
      initialize: async () => ({}),
      sessionLoad: async (sessionId) => {
        loaded.push(sessionId);
        return { sessionId };
      },
      onSessionUpdate: () => () => {},
      onPermission: () => () => {},
    }),
  });
  const stop = runtime.subscribe(id, () => {});
  try {
    const response = await createAgentHandlers(runtime).getSession(
      new Request(`http://127.0.0.1/api/agent/${id}`),
      id,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(loaded, [id]);
  } finally {
    stop();
    if (previousHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = previousHome;
  }
});
