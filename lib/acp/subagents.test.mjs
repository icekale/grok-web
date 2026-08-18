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
  });

  it("steers and pauses only through the root runtime", async () => {
    const sent = [];
    const runtime = {
      send: async (sessionId, command) => {
        sent.push({ sessionId, command });
        return { ok: true };
      },
    };
    await controlGrokSubagent(runtime, "root", "child", "steer", "keep going");
    await controlGrokSubagent(runtime, "root", "child", "interrupt");
    assert.deepEqual(sent.map((item) => item.sessionId), ["root", "root"]);
    assert.equal(sent[0].command.type, "prompt");
    assert.equal(sent[0].command.streamingBehavior, "steer");
    assert.equal(sent[1].command.type, "abort");
    assert.ok(!sent.some((item) => item.sessionId === "child"));
  });
});
