import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { mapUpdatesJsonl } from "./history-map.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "acp/fixtures");

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

  it("does not duplicate a user bubble when Grok replays the same prompt mid-turn", () => {
    const text = [
      line({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Hi" } }, { eventId: "u1" }),
      line({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "one" } }, { eventId: "a1" }),
      line({ sessionUpdate: "tool_call", toolCallId: "t1", title: "read_file", rawInput: { target_file: "a.ts" } }),
      line({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Hi" } }, { eventId: "u2" }),
      line({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "two" } }),
    ].join("\n");
    const { messages } = mapUpdatesJsonl(text);
    assert.deepEqual(messages.map((message) => message.role), ["user", "assistant"]);
    assert.equal(messages[0].content, "Hi");
    assert.deepEqual(messages[1].content, [
      { type: "thinking", thinking: "one" },
      { type: "toolCall", toolCallId: "t1", toolName: "read_file", input: { target_file: "a.ts" } },
      { type: "thinking", thinking: "two" },
    ]);
  });

  it("keeps a second user bubble after turn_completed even if the text matches", () => {
    const text = [
      line({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Hi" } }, { eventId: "u1" }),
      line({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "A" } }, { eventId: "a1" }),
      line({ sessionUpdate: "turn_completed", stop_reason: "end_turn" }),
      line({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Hi" } }, { eventId: "u2" }),
      line({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "B" } }, { eventId: "a2" }),
    ].join("\n");
    const { messages } = mapUpdatesJsonl(text);
    assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "user", "assistant"]);
    assert.equal(messages[2].content, "Hi");
    assert.deepEqual(messages[3].content, [{ type: "text", text: "B" }]);
  });

  it("drops Grok schema padding from tool input", () => {
    const text = [
      line({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Go" } }, { eventId: "u1" }),
      line({
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "grep",
        rawInput: { pattern: "foo", path: null, variant: "Grep", "-i": false, multiline: false },
      }, { eventId: "a1" }),
      line({
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        rawInput: { variant: "Grep", pattern: "foo", glob: "*.ts", path: null, type: null },
      }),
    ].join("\n");
    const { messages } = mapUpdatesJsonl(text);
    assert.deepEqual(messages[1].content[0].input, { pattern: "foo", glob: "*.ts" });
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

  it("surfaces tool_call_update content as a toolResult keyed by toolCallId", () => {
    const text = [
      line({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Go" } }, { eventId: "u1" }),
      line({ sessionUpdate: "tool_call", toolCallId: "t1", title: "bash" }, { eventId: "a1" }),
      line({ sessionUpdate: "tool_call_update", toolCallId: "t1", content: { type: "text", text: "full " } }),
      line({ sessionUpdate: "tool_call_update", toolCallId: "t1", content: { type: "text", text: "result" }, status: "completed" }),
    ].join("\n");
    const { messages, entryIds } = mapUpdatesJsonl(text);
    assert.equal(messages[1].role, "assistant");
    assert.equal(messages[2].role, "toolResult");
    assert.deepEqual(messages[2], {
      role: "toolResult",
      toolCallId: "t1",
      toolName: "bash",
      content: [{ type: "text", text: "full result" }],
    });
    assert.equal(entryIds[2], "t1");
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
    assert.equal(messages[1].model, "grok-4.6");
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

  it("treats grok jsonl unix-second timestamps as milliseconds", () => {
    const unixSeconds = 1787153283;
    const text = JSON.stringify({
      timestamp: unixSeconds,
      method: "session/update",
      params: {
        sessionId: "s",
        update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Hi" } },
        _meta: { eventId: "e1" },
      },
    });
    const { messages } = mapUpdatesJsonl(text);
    assert.equal(messages[0].timestamp, unixSeconds * 1000);
    assert.equal(new Date(messages[0].timestamp).getUTCFullYear(), 2026);
  });

  it("keeps millisecond timestamps as milliseconds", () => {
    const unixMs = 1787153283000;
    const text = JSON.stringify({
      timestamp: unixMs,
      method: "session/update",
      params: {
        sessionId: "s",
        update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Hi" } },
      },
    });
    const { messages } = mapUpdatesJsonl(text);
    assert.equal(messages[0].timestamp, unixMs);
  });

  it("inserts tool results after the owning turn instead of appending them at the end", () => {
    const text = [
      line({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "First" } }, { eventId: "u1" }),
      line({ sessionUpdate: "tool_call", toolCallId: "t1", title: "bash" }, { eventId: "a1" }),
      line({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Second" } }, { eventId: "u2" }),
      line({ sessionUpdate: "tool_call", toolCallId: "t2", title: "read_file" }, { eventId: "a2" }),
      line({ sessionUpdate: "tool_call_update", toolCallId: "t1", content: { type: "text", text: "one" }, status: "completed" }),
      line({ sessionUpdate: "tool_call_update", toolCallId: "t2", content: { type: "text", text: "two" }, status: "completed" }),
    ].join("\n");
    const { messages, entryIds } = mapUpdatesJsonl(text);
    assert.deepEqual(messages.map((message) => message.role), [
      "user",
      "assistant",
      "toolResult",
      "user",
      "assistant",
      "toolResult",
    ]);
    assert.equal(messages[2].toolCallId, "t1");
    assert.equal(messages[2].content[0].text, "one");
    assert.equal(messages[5].toolCallId, "t2");
    assert.equal(messages[5].content[0].text, "two");
    assert.deepEqual(entryIds, ["u1", "a1", "t1", "u2", "a2", "t2"]);
  });

  it("replays the Grok bash fixture without the description prefix", () => {
    const { messages } = mapUpdatesJsonl(readFileSync(join(fixtures, "tool-bash.jsonl"), "utf8"));
    const tool = messages[1].content[0];
    assert.equal(tool.toolName, "bash");
    assert.equal(tool.input.command, "ls");
    assert.equal(messages[2].role, "toolResult");
    assert.equal(messages[2].content[0].text, "a.ts\n");
  });

  it("replays the Grok read fixture without replacing read_file with the path title", () => {
    const { messages } = mapUpdatesJsonl(readFileSync(join(fixtures, "tool-read.jsonl"), "utf8"));
    const tool = messages[1].content[0];
    assert.equal(tool.toolName, "read_file");
    assert.notEqual(tool.toolName, "Read `/tmp/a.ts`");
    assert.equal(tool.input.target_file, "/tmp/a.ts");
    assert.equal(messages[2].role, "toolResult");
    assert.equal(messages[2].content[0].text, "file body\n");
  });

  it("restores ACP image blocks on user messages", () => {
    const { messages } = mapUpdatesJsonl(readFileSync(join(fixtures, "user-image.jsonl"), "utf8"));
    assert.equal(messages[0].role, "user");
    assert.ok(Array.isArray(messages[0].content), "user image history must not collapse to a text-only string");
    const images = messages[0].content.filter((block) => block.type === "image");
    const texts = messages[0].content.filter((block) => block.type === "text");
    assert.ok(images.length > 0);
    assert.equal(texts[0]?.text, "look");
    const image = images[0];
    const data = image.source?.data ?? image.data;
    const mime = image.source?.media_type ?? image.mimeType;
    assert.equal(typeof data, "string");
    assert.ok(data.length > 0);
    assert.match(mime ?? "", /^image\//);
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
