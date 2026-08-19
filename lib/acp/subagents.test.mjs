import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { controlGrokSubagent, findGrokChild, grokSubagentTree } from "./subagents.ts";

function session(id, parentSessionId, extras = {}) {
  return {
    id,
    path: `/tmp/${id}`,
    cwd: "/tmp",
    name: extras.name ?? id,
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 1,
    firstMessage: extras.firstMessage ?? id,
    ...(parentSessionId ? { parentSessionId } : {}),
    ...extras,
  };
}

describe("grok subagent adapter", () => {
  it("lists child sessions under the root", () => {
    const sessions = [
      session("root"),
      session("child", "root", { name: "subagent-worker-317e1ca0-1" }),
    ];
    const tree = grokSubagentTree("root", sessions, 1);
    assert.equal(tree.rootSessionId, "root");
    assert.equal(tree.nodes.length, 1);
    assert.equal(tree.nodes[0].sessionId, "child");
    assert.equal(tree.nodes[0].parentSessionId, "root");
    assert.ok(findGrokChild("root", "child", sessions));
    assert.equal(findGrokChild("root", "root", sessions), null);
    assert.equal(tree.rpcAvailable, false);
    assert.equal(tree.unavailableReason, "offline");
  });

  it("merges disk metas with live running rows", () => {
    const sessions = [session("root"), session("child-1", undefined, { name: "look around" })];
    const tree = grokSubagentTree("root", sessions, 10, {
      metas: [{
        subagentId: "child-1",
        parentSessionId: "root",
        childSessionId: "child-1",
        agent: "explore",
        task: "look around",
        status: "completed",
      }],
      live: [{ subagentId: "child-1", status: "running", description: "look around", subagentType: "explore" }],
      rpcAvailable: true,
    });
    assert.equal(tree.rpcAvailable, true);
    assert.equal(tree.unavailableReason, undefined);
    assert.equal(tree.nodes.length, 1);
    assert.equal(tree.nodes[0].state, "running");
    assert.equal(tree.nodes[0].canInterrupt, true);
    assert.equal(tree.nodes[0].canSteer, true);
    assert.equal(tree.nodes[0].canResume, false);
  });

  it("steers through the root and cancels the child on interrupt", async () => {
    const sent = [];
    const cancelled = [];
    const runtime = {
      send: async (sessionId, command) => {
        sent.push({ sessionId, command });
        return { ok: true };
      },
      cancelSubagent: async (subagentId) => {
        cancelled.push(subagentId);
        return { cancelled: true };
      },
    };
    await controlGrokSubagent(runtime, "root", "child", "steer", "keep going");
    await controlGrokSubagent(runtime, "root", "child", "interrupt");
    assert.deepEqual(sent.map((item) => item.sessionId), ["root"]);
    assert.equal(sent[0].command.type, "prompt");
    assert.equal(sent[0].command.streamingBehavior, "steer");
    assert.deepEqual(cancelled, ["child"]);
    assert.ok(!sent.some((item) => item.sessionId === "child"));
    assert.ok(!sent.some((item) => item.command.type === "abort"));
  });

  it("cancels the child subagentId on interrupt instead of aborting the root", async () => {
    const sent = [];
    const cancelled = [];
    const runtime = {
      send: async (sessionId, command) => {
        sent.push({ sessionId, command });
        return { ok: true };
      },
      cancelSubagent: async (subagentId) => {
        cancelled.push(subagentId);
        return { cancelled: true };
      },
    };
    await controlGrokSubagent(runtime, "root", "child-1", "interrupt");
    assert.deepEqual(cancelled, ["child-1"]);
    assert.equal(sent.length, 0);
  });

  it("returns a clear error when resume has no ACP method", async () => {
    await assert.rejects(
      () => controlGrokSubagent({ send: async () => ({}) }, "root", "child-1", "resume", "go"),
      /not supported/i,
    );
  });

  it("resumes a child session then prompts it", async () => {
    const resumed = [];
    const sent = [];
    await controlGrokSubagent({
      send: async (sessionId, command) => {
        sent.push({ sessionId, command });
        return {};
      },
      resumeSession: async (sessionId, cwd) => {
        resumed.push({ sessionId, cwd });
      },
    }, "root", "child-1", "resume", "go");
    assert.deepEqual(resumed, [{ sessionId: "child-1", cwd: undefined }]);
    assert.equal(sent[0].sessionId, "child-1");
    assert.equal(sent[0].command.type, "prompt");
    assert.equal(sent[0].command.message, "go");
  });
});
