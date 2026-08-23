import assert from "node:assert/strict";
import test from "node:test";
import { readAcpPlanUpdate } from "./plan.ts";

test("reads complete ACP plan updates", () => {
  assert.deepEqual(readAcpPlanUpdate({
    sessionUpdate: "plan",
    plan: { entries: [
      { content: "Inspect", priority: "high", status: "in_progress" },
      { content: "Implement", priority: "medium", status: "pending" },
    ] },
  }), {
    entries: [
      { content: "Inspect", priority: "high", status: "in_progress" },
      { content: "Implement", priority: "medium", status: "pending" },
    ],
  });
});

test("rejects malformed ACP plan updates", () => {
  assert.equal(readAcpPlanUpdate({ sessionUpdate: "plan", plan: { entries: [{ content: "bad", status: "unknown" }] } }), null);
  assert.equal(readAcpPlanUpdate({ sessionUpdate: "agent_message_chunk" }), null);
});
