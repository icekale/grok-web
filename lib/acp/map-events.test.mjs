import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { applyToolOutputUpdate, toolResultText } from "../history-map.ts";
import { AcpTurnMapper } from "./map-events.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

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
    assert.deepEqual(events.slice(-4).map((e) => e.type), ["message_end", "agent_end", "prompt_done", "agent_settled"]);
    assert.deepEqual(events.at(-4).message, {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "th" },
        { type: "text", text: "hi" },
      ],
      model: "",
      provider: "grok",
    });
    assert.equal(mapper.snapshot(), null);
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
    assert.equal(start[2].assistantMessageEvent.type, "toolcall_end");
    assert.deepEqual(start[2].assistantMessageEvent.toolCall, {
      type: "toolCall",
      id: "t1",
      name: "read_file",
      arguments: { path: "a.ts" },
    });
    assert.equal(update[0].type, "tool_execution_update");
    assert.equal(update[0].toolCallId, "t1");
  });

  it("keeps Grok terminal tools named bash instead of the Execute title", () => {
    const mapper = new AcpTurnMapper();
    const events = [];
    for (const line of readFileSync(join(fixtures, "tool-bash.jsonl"), "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      events.push(...mapper.push(JSON.parse(line).params.update));
    }
    const toolcallEnd = events.find((event) => event.assistantMessageEvent?.type === "toolcall_end");
    assert.equal(toolcallEnd.assistantMessageEvent.toolCall.name, "bash");
    const execUpdates = events.filter((event) => event.type === "tool_execution_update");
    assert.ok(execUpdates.length > 0);
    for (const event of execUpdates) {
      assert.equal(event.toolName, "bash");
      assert.notEqual(event.toolName, "Execute `ls`");
    }
    assert.equal(execUpdates.at(-1).partialResult.status, "completed");
    assert.equal(toolResultText(execUpdates.at(-1).partialResult), "a.ts\n");
    assert.notEqual(toolResultText(execUpdates.at(-1).partialResult), "List files");
  });

  it("accumulates bash stdout without concatenating the description chunk", () => {
    let output = { text: "" };
    output = applyToolOutputUpdate(output, {
      rawInput: { command: "ls", description: "List files" },
    }, "bash");
    output = applyToolOutputUpdate(output, {
      content: [{ type: "content", content: { type: "text", text: "List files" } }],
    }, "bash");
    output = applyToolOutputUpdate(output, {
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "a.ts\n" } }],
    }, "bash");
    assert.equal(toolResultText(output.text), "a.ts\n");
    assert.notEqual(output.text, "List filesa.ts\n");
  });
});
