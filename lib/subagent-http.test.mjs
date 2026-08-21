import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false });
const { createSubagentHandlers } = await jiti.import("./subagent-http.ts");

function session(id, name, parentSessionId, overrides = {}) {
  return {
    path: `/tmp/${id}.jsonl`,
    id,
    cwd: "/tmp",
    name,
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 1,
    firstMessage: `first ${id}`,
    ...(parentSessionId ? { parentSessionId } : {}),
    ...overrides,
  };
}

function sessionsFixture() {
  return [
    session("root", "Main task"),
    session("child", "subagent-worker-317e1ca0-1", "root"),
    session("grand", "subagent-reviewer-76fa6d64-6031-4824-8a88-1282c22d9afa-2", "child"),
  ];
}

function makeRuntime(overrides = {}) {
  const sent = [];
  const cancelled = [];
  const resumed = [];
  const runtime = {
    hasSession: () => true,
    listRunningSubagents: async () => ({ subagents: [] }),
    send: async (sessionId, command) => {
      sent.push({ sessionId, command });
      return { ok: true };
    },
    cancelSubagent: async (subagentId) => {
      cancelled.push(subagentId);
      return { cancelled: true };
    },
    resumeSession: async (sessionId, cwd) => {
      resumed.push({ sessionId, cwd });
    },
    ...overrides,
  };
  return { runtime, sent, cancelled, resumed };
}

function makeDeps({ list = sessionsFixture(), runtimeOverrides = {} } = {}) {
  const fake = makeRuntime(runtimeOverrides);
  return {
    listSessions: async () => list,
    runtime: fake.runtime,
    resolveSessionPath: async () => "/tmp/root.jsonl",
    sent: fake.sent,
    cancelled: fake.cancelled,
    resumed: fake.resumed,
  };
}

function json(response) {
  return response.json();
}

test("GET unknown root returns 404", async () => {
  const { GET } = createSubagentHandlers(makeDeps());
  const response = await GET(new Request("http://x/"), { params: Promise.resolve({ id: "missing" }) });
  assert.equal(response.status, 404);
});

test("GET lists durable children and marks rpcAvailable from ACP session load", async () => {
  const deps = makeDeps();
  const { GET } = createSubagentHandlers(deps);
  const response = await GET(new Request("http://x/"), { params: Promise.resolve({ id: "root" }) });
  assert.equal(response.status, 200);
  const body = await json(response);
  assert.equal(body.rootSessionId, "root");
  assert.equal(body.rpcAvailable, true);
  assert.equal(body.unavailableReason, undefined);
  const child = body.nodes.find((node) => node.sessionId === "child");
  assert.ok(child);
  assert.equal(child.state, "inactive");
});

test("GET rpcAvailable is false when ACP session is not loaded and listing fails", async () => {
  const deps = makeDeps({
    runtimeOverrides: {
      hasSession: () => false,
      listRunningSubagents: async () => {
        throw new Error("ACP session is not loaded");
      },
    },
  });
  const { GET } = createSubagentHandlers(deps);
  const response = await GET(new Request("http://x/"), { params: Promise.resolve({ id: "root" }) });
  assert.equal(response.status, 200);
  const body = await json(response);
  assert.equal(body.rpcAvailable, false);
  assert.equal(body.unavailableReason, "offline");
  assert.ok(body.nodes.some((node) => node.sessionId === "child"));
});

test("GET keeps rpcAvailable when the ACP session is loaded even if listing throws", async () => {
  const deps = makeDeps({
    runtimeOverrides: {
      hasSession: () => true,
      listRunningSubagents: async () => {
        throw new Error("listRunningSubagents unavailable");
      },
    },
  });
  const { GET } = createSubagentHandlers(deps);
  const body = await json(await GET(new Request("http://x/"), { params: Promise.resolve({ id: "root" }) }));
  assert.equal(body.rpcAvailable, true);
});

test("GET merges live running rows from listRunningSubagents", async () => {
  const deps = makeDeps({
    runtimeOverrides: {
      listRunningSubagents: async () => ({
        subagents: [{
          subagentId: "317e1ca0",
          childSessionId: "child",
          status: "running",
          description: "live task",
          subagentType: "worker",
        }],
      }),
    },
  });
  const { GET } = createSubagentHandlers(deps);
  const body = await json(await GET(new Request("http://x/"), { params: Promise.resolve({ id: "root" }) }));
  assert.equal(body.rpcAvailable, true);
  const child = body.nodes.find((node) => node.sessionId === "child");
  assert.equal(child.state, "running");
  assert.equal(child.canInterrupt, true);
});

test("GET lists sessions through the dep so durable nodes are found", async () => {
  const calls = [];
  const deps = makeDeps();
  deps.listSessions = async () => { calls.push("list"); return sessionsFixture(); };
  const { GET } = createSubagentHandlers(deps);
  await GET(new Request("http://x/"), { params: Promise.resolve({ id: "root" }) });
  assert.deepEqual(calls, ["list"]);
});

test("POST rejects unsupported actions and blank messages", async () => {
  const { POST } = createSubagentHandlers(makeDeps());
  const params = Promise.resolve({ id: "root" });

  let response = await POST(new Request("http://x/", { method: "POST", body: JSON.stringify({ childSessionId: "child", action: "stop" }) }), { params });
  assert.equal(response.status, 400);

  response = await POST(new Request("http://x/", { method: "POST", body: JSON.stringify({ childSessionId: "child", action: "steer" }) }), { params });
  assert.equal(response.status, 400);

  response = await POST(new Request("http://x/", { method: "POST", body: JSON.stringify({ childSessionId: "child", action: "resume", message: "   " }) }), { params });
  assert.equal(response.status, 400);

  response = await POST(new Request("http://x/", { method: "POST", body: JSON.stringify({ childSessionId: "child", action: "interrupt", message: "nope" }) }), { params });
  assert.equal(response.status, 400);

  response = await POST(new Request("http://x/", { method: "POST", body: JSON.stringify({ action: "interrupt" }) }), { params });
  assert.equal(response.status, 400);
});

test("POST rejects foreign, orphan, and placeholder child ids", async () => {
  const list = [
    session("root", "Main task"),
    session("other-root", "Other task"),
    session("foreign", "subagent-worker-33333333-0", "other-root"),
    session("orphan", "subagent-worker-44444444-1"),
  ];
  const { POST } = createSubagentHandlers(makeDeps({ list }));
  const params = Promise.resolve({ id: "root" });

  let response = await POST(new Request("http://x/", { method: "POST", body: JSON.stringify({ childSessionId: "foreign", action: "interrupt" }) }), { params });
  assert.equal(response.status, 400);

  response = await POST(new Request("http://x/", { method: "POST", body: JSON.stringify({ childSessionId: "orphan", action: "interrupt" }) }), { params });
  assert.equal(response.status, 400);

  response = await POST(new Request("http://x/", { method: "POST", body: JSON.stringify({ childSessionId: "root", action: "interrupt" }) }), { params });
  assert.equal(response.status, 400);
});

test("POST steers through the root via runtime.send", async () => {
  const deps = makeDeps();
  const { POST } = createSubagentHandlers(deps);
  const response = await POST(new Request("http://x/", {
    method: "POST",
    body: JSON.stringify({ childSessionId: "child", action: "steer", message: "keep going", runId: "evil", index: 99 }),
  }), { params: Promise.resolve({ id: "root" }) });
  assert.equal(response.status, 200);
  assert.equal(deps.sent.length, 1);
  assert.equal(deps.sent[0].sessionId, "root");
  assert.equal(deps.sent[0].command.type, "prompt");
  assert.equal(deps.sent[0].command.streamingBehavior, "steer");
  assert.equal(deps.sent[0].command.message, "keep going");
});

test("POST interrupt cancels the child subagent id", async () => {
  const deps = makeDeps();
  const { POST } = createSubagentHandlers(deps);
  const response = await POST(new Request("http://x/", {
    method: "POST",
    body: JSON.stringify({ childSessionId: "child", action: "interrupt" }),
  }), { params: Promise.resolve({ id: "root" }) });
  assert.equal(response.status, 200);
  const body = await json(response);
  assert.equal(body.success, true);
  assert.equal(body.data.action, "interrupt");
  assert.equal(body.data.childSessionId, "child");
  assert.deepEqual(deps.cancelled, ["317e1ca0"]);
  assert.equal(deps.sent.length, 0);
  assert.ok(body.data.tree?.rootSessionId === "root");
});

test("POST resume loads the child session then prompts it", async () => {
  const deps = makeDeps();
  const { POST } = createSubagentHandlers(deps);
  const response = await POST(new Request("http://x/", {
    method: "POST",
    body: JSON.stringify({ childSessionId: "grand", action: "resume", message: "go on" }),
  }), { params: Promise.resolve({ id: "root" }) });
  assert.equal(response.status, 200);
  assert.deepEqual(deps.resumed, [{ sessionId: "grand", cwd: undefined }]);
  assert.equal(deps.sent[0].sessionId, "grand");
  assert.equal(deps.sent[0].command.type, "prompt");
  assert.equal(deps.sent[0].command.message, "go on");
});

test("POST resume without ACP resumeSession returns 400", async () => {
  const deps = makeDeps({
    runtimeOverrides: { resumeSession: undefined },
  });
  delete deps.runtime.resumeSession;
  const { POST } = createSubagentHandlers(deps);
  const response = await POST(new Request("http://x/", {
    method: "POST",
    body: JSON.stringify({ childSessionId: "child", action: "resume", message: "go on" }),
  }), { params: Promise.resolve({ id: "root" }) });
  assert.equal(response.status, 400);
  assert.match((await json(response)).error, /not supported/i);
});

test("POST never exposes spawn, stop, retry, or bulk actions", async () => {
  const source = await readFile(new URL("./subagent-http.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /"spawn"/);
  assert.doesNotMatch(source, /"stop"/);
  assert.doesNotMatch(source, /"retry"/);
  assert.match(source, /action !== "steer" && action !== "interrupt" && action !== "resume"/);
  assert.doesNotMatch(source, /rpc-manager/);
  assert.doesNotMatch(source, /startRpcSession/);
  assert.doesNotMatch(source, /getRpcSession/);
  assert.match(source, /getAgentRuntime\(\)/);
  assert.match(source, /grokSubagentTree/);
  assert.match(source, /controlGrokSubagent/);
});
