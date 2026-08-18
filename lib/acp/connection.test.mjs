import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { JsonRpcConn } from "./jsonrpc.ts";
import { AcpConnection } from "./connection.ts";

function spawnFake() {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./fake-agent.mjs", import.meta.url))], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const rpc = new JsonRpcConn({ stdin: child.stdin, stdout: child.stdout });
  return { child, acp: new AcpConnection(rpc) };
}

describe("AcpConnection", () => {
  it("creates a session, streams prompt updates, and rejects a missing load", async () => {
    const { child, acp } = spawnFake();
    try {
      await acp.initialize();
      const { sessionId } = await acp.sessionNew("/tmp/p");
      assert.equal(typeof sessionId, "string");
      const updates = [];
      const stop = acp.onSessionUpdate((_id, update) => updates.push(update));
      const result = await acp.sessionPrompt(sessionId, "Hi");
      stop();
      assert.equal(result.stopReason, "end_turn");
      assert.ok(updates.some((u) => u.sessionUpdate === "agent_thought_chunk"));
      assert.ok(updates.some((u) => u.sessionUpdate === "agent_message_chunk"));
      await assert.rejects(acp.sessionLoad("missing"), /session not found/);
    } finally {
      child.kill();
    }
  });
});
