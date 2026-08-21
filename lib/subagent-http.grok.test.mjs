import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { createJiti } from "jiti";

const home = mkdtempSync(join(tmpdir(), "grok-subagent-route-"));
const previousHome = process.env.GROK_HOME;
process.env.GROK_HOME = home;
after(() => {
  if (previousHome === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = previousHome;
});

const rootId = "root-1";
const dir = join(home, "sessions", encodeURIComponent("/tmp/p"), rootId);
mkdirSync(join(dir, "subagents", "child-1"), { recursive: true });
writeFileSync(join(dir, "summary.json"), JSON.stringify({
  info: { id: rootId, cwd: "/tmp/p" },
  session_summary: "Root",
  created_at: "2026-08-19T00:00:00.000Z",
  updated_at: "2026-08-19T00:00:00.000Z",
  num_chat_messages: 1,
  generated_title: "Root",
}));
writeFileSync(join(dir, "subagents", "child-1", "meta.json"), JSON.stringify({
  subagent_id: "child-1",
  parent_session_id: rootId,
  child_session_id: "child-1",
  subagent_type: "explore",
  description: "look around",
  status: "completed",
}));

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { resetAgentRuntime, setAgentRuntime } = await jiti.import("@/lib/acp/runtime.ts");
const { GET, POST } = await jiti.import("./subagent-http.ts");

function params() {
  return { params: Promise.resolve({ id: rootId }) };
}

function getRequest() {
  return new Request("http://127.0.0.1/api/agent/root-1/subagents");
}

function postRequest(body) {
  return new Request("http://127.0.0.1/api/agent/root-1/subagents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function stubRuntime(overrides = {}) {
  const sent = [];
  const cancelled = [];
  const runtime = {
    hasSession: () => false,
    listRunningSubagents: async () => {
      throw new Error("listRunningSubagents unavailable");
    },
    cancelSubagent: async (subagentId) => {
      cancelled.push(subagentId);
      return { cancelled: true };
    },
    send: async (sessionId, command) => {
      sent.push({ sessionId, command });
      return { ok: true };
    },
    ...overrides,
  };
  setAgentRuntime(runtime);
  return { sent, cancelled, runtime };
}

afterEach(() => {
  resetAgentRuntime();
});

describe("GET /api/agent/[id]/subagents (Grok)", () => {
  it("lists child-1 from disk when listRunningSubagents throws", async () => {
    stubRuntime();
    const response = await GET(getRequest(), params());
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.rpcAvailable, false);
    assert.equal(body.nodes.length, 1);
    assert.equal(body.nodes[0].sessionId, "child-1");
    assert.equal(body.nodes[0].state, "complete");
  });

  it("marks child-1 running when listRunningSubagents returns it", async () => {
    stubRuntime({
      hasSession: () => true,
      listRunningSubagents: async () => ({
        subagents: [{
          subagentId: "child-1",
          status: "running",
          description: "look around",
          subagentType: "explore",
        }],
      }),
    });
    const response = await GET(getRequest(), params());
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.rpcAvailable, true);
    assert.equal(body.nodes[0].sessionId, "child-1");
    assert.equal(body.nodes[0].state, "running");
  });
});

describe("POST /api/agent/[id]/subagents (Grok)", () => {
  it("interrupts a meta-only child via cancelSubagent", async () => {
    const { cancelled, sent } = stubRuntime();
    const response = await POST(postRequest({
      action: "interrupt",
      childSessionId: "child-1",
    }), params());
    assert.equal(response.status, 200);
    assert.deepEqual(cancelled, ["child-1"]);
    assert.equal(sent.length, 0);
    const body = await response.json();
    assert.equal(body.success, true);
    assert.equal(body.data.action, "interrupt");
    assert.equal(body.data.childSessionId, "child-1");
  });

  it("rejects resume as not supported", async () => {
    stubRuntime();
    const response = await POST(postRequest({
      action: "resume",
      childSessionId: "child-1",
      message: "go on",
    }), params());
    assert.ok(response.status === 400 || response.status === 500);
    const body = await response.json();
    assert.match(String(body.error), /not supported/i);
  });

  it("rejects blank steering messages on the exported POST handler", async () => {
    stubRuntime();
    for (const message of [undefined, "", "   "]) {
      const response = await POST(postRequest({
        action: "steer",
        childSessionId: "child-1",
        ...(message === undefined ? {} : { message }),
      }), params());
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.match(String(body.error), /non-empty message/i);
    }
  });

  it("cancels the real subagentId when it differs from childSessionId", async () => {
    const otherId = "root-2";
    const otherDir = join(home, "sessions", encodeURIComponent("/tmp/p"), otherId);
    mkdirSync(join(otherDir, "subagents", "run-abc"), { recursive: true });
    writeFileSync(join(otherDir, "summary.json"), JSON.stringify({
      info: { id: otherId, cwd: "/tmp/p" },
      session_summary: "Other",
      created_at: "2026-08-19T00:00:00.000Z",
      updated_at: "2026-08-19T00:00:00.000Z",
      generated_title: "Other",
    }));
    writeFileSync(join(otherDir, "subagents", "run-abc", "meta.json"), JSON.stringify({
      subagent_id: "run-abc",
      parent_session_id: otherId,
      child_session_id: "sess-xyz",
      subagent_type: "explore",
      description: "look around",
      status: "running",
    }));
    const { cancelled } = stubRuntime();
    const response = await POST(postRequest({
      action: "interrupt",
      childSessionId: "sess-xyz",
    }), { params: Promise.resolve({ id: otherId }) });
    assert.equal(response.status, 200);
    assert.deepEqual(cancelled, ["run-abc"]);
  });

  it("steers through the root session prompt", async () => {
    const { sent, cancelled } = stubRuntime();
    const response = await POST(postRequest({
      action: "steer",
      childSessionId: "child-1",
      message: "keep going",
    }), params());
    assert.equal(response.status, 200);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].sessionId, "root-1");
    assert.equal(sent[0].command.type, "prompt");
    assert.equal(sent[0].command.streamingBehavior, "steer");
    assert.equal(sent[0].command.message, "keep going");
    assert.equal(cancelled.length, 0);
  });
});
