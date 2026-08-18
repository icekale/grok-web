import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapUpdatesJsonl } from "./history-map.ts";

function line(update, meta = {}) {
  return JSON.stringify({
    timestamp: 1,
    method: "session/update",
    params: { sessionId: "s", update, _meta: meta },
  });
}

describe("mapUpdatesJsonl", () => {
  it("merges chunks and tools into user/assistant messages", () => {
    const text = [
      line({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Hi" } }, { eventId: "e1", modelId: "grok-4.6" }),
      line({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "think" } }, { eventId: "e2" }),
      line({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Yo" } }, { eventId: "e3" }),
      line({ sessionUpdate: "tool_call", toolCallId: "t1", title: "read_file", input: { path: "a.ts" } }, { eventId: "e4" }),
      "{not json",
      line({ sessionUpdate: "unknown_thing" }),
    ].join("\n");
    const { messages, entryIds } = mapUpdatesJsonl(text);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, "user");
    assert.equal(messages[0].content, "Hi");
    assert.equal(messages[1].role, "assistant");
    assert.deepEqual(messages[1].content, [
      { type: "thinking", thinking: "think" },
      { type: "text", text: "Yo" },
      { type: "toolCall", toolCallId: "t1", toolName: "read_file", input: { path: "a.ts" } },
    ]);
    assert.equal(messages[1].provider, "grok");
    assert.equal(entryIds.length, 2);
    assert.equal(entryIds[0], "e1");
  });

  it("merges tool_call_update input by id without a new message", () => {
    const text = [
      line({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Go" } }, { eventId: "u1" }),
      line({ sessionUpdate: "tool_call", id: "t1", kind: "read_file", rawInput: { path: "a.ts" } }, { eventId: "a1" }),
      line({ sessionUpdate: "tool_call_update", toolCallId: "t1", input: { offset: 1 }, status: "completed" }),
    ].join("\n");
    const { messages, entryIds } = mapUpdatesJsonl(text);
    assert.equal(messages.length, 2);
    assert.deepEqual(messages[1].content, [
      {
        type: "toolCall",
        toolCallId: "t1",
        toolName: "read_file",
        input: { path: "a.ts", offset: 1 },
        status: "completed",
      },
    ]);
    assert.equal(entryIds.length, 2);
    assert.equal(entryIds[1], "a1");
  });

  it("concatenates consecutive same-role text and thought chunks", () => {
    const text = [
      line({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Hel" } }),
      line({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "lo" } }),
      line({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "th" } }),
      line({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "ink" } }),
      line({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Y" } }),
      line({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "o" } }),
    ].join("\n");
    const { messages } = mapUpdatesJsonl(text);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, "user");
    assert.equal(messages[0].content, "Hello");
    assert.equal(messages[1].role, "assistant");
    assert.deepEqual(messages[1].content, [
      { type: "thinking", thinking: "think" },
      { type: "text", text: "Yo" },
    ]);
    assert.equal(messages[1].model, "grok");
  });

  it("starts a new user message after an assistant", () => {
    const text = [
      line({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Hi" } }),
      line({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Yo" } }),
      line({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Again" } }),
    ].join("\n");
    const { messages } = mapUpdatesJsonl(text);
    assert.equal(messages.length, 3);
    assert.equal(messages[0].role, "user");
    assert.equal(messages[0].content, "Hi");
    assert.equal(messages[1].role, "assistant");
    assert.deepEqual(messages[1].content, [{ type: "text", text: "Yo" }]);
    assert.equal(messages[2].role, "user");
    assert.equal(messages[2].content, "Again");
  });

  it("assigns msg-0 incrementing when eventId is missing", () => {
    const text = [
      line({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Hi" } }),
      line({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Yo" } }),
    ].join("\n");
    const { entryIds } = mapUpdatesJsonl(text);
    assert.deepEqual(entryIds, ["msg-0", "msg-1"]);
  });

  it("inherits assistant model from an earlier _meta.modelId", () => {
    const text = [
      line(
        { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Hi" } },
        { eventId: "e1", modelId: "grok-4.6" },
      ),
      line({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Yo" } }),
    ].join("\n");
    const { messages } = mapUpdatesJsonl(text);
    assert.equal(messages[1].role, "assistant");
    assert.equal(messages[1].model, "grok-4.6");
  });
});
