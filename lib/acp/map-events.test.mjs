import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AcpTurnMapper } from "./map-events.ts";

describe("AcpTurnMapper", () => {
  it("emits agent_start then text/thinking deltas then end sequence", () => {
    const mapper = new AcpTurnMapper();
    const events = [
      ...mapper.push({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "th" } }),
      ...mapper.push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }),
      ...mapper.endTurn(),
    ];
    assert.equal(events[0].type, "agent_start");
    assert.equal(events[1].type, "message_update");
    assert.equal(events[1].assistantMessageEvent.type, "thinking_start");
    assert.equal(events[2].assistantMessageEvent.type, "thinking_delta");
    assert.equal(events[2].assistantMessageEvent.delta, "th");
    assert.equal(events[1].assistantMessageEvent.contentIndex, events[2].assistantMessageEvent.contentIndex);
    assert.equal(events[3].assistantMessageEvent.type, "text_start");
    assert.equal(events[4].assistantMessageEvent.type, "text_delta");
    assert.equal(events[4].assistantMessageEvent.delta, "hi");
    assert.equal(events[3].assistantMessageEvent.contentIndex, events[4].assistantMessageEvent.contentIndex);
    assert.deepEqual(events.slice(-3).map((e) => e.type), ["agent_end", "prompt_done", "agent_settled"]);
  });

  it("maps tool_call and tool_call_update", () => {
    const mapper = new AcpTurnMapper();
    const start = mapper.push({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "read_file",
      input: { path: "a.ts" },
    });
    const update = mapper.push({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      title: "read_file",
      status: "completed",
    });
    assert.equal(start[1].assistantMessageEvent.type, "toolcall_start");
    assert.equal(start[1].assistantMessageEvent.toolName, "read_file");
    assert.equal(update[0].type, "tool_execution_update");
    assert.equal(update[0].toolCallId, "t1");
  });
});
