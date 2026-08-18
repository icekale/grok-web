import { createInterface } from "node:readline";

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function result(id, value) {
  write({ jsonrpc: "2.0", id, result: value });
}

function error(id, code, message) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

function notify(method, params) {
  write({ jsonrpc: "2.0", method, params });
}

let waiting = null;

createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (method === "initialize") {
    result(id, { protocolVersion: 1, agentCapabilities: {} });
    return;
  }
  if (method === "session/new") {
    result(id, { sessionId: "sess-new-1" });
    return;
  }
  if (method === "session/load") {
    if (params?.sessionId === "missing") {
      error(id, -32000, "session not found");
      return;
    }
    result(id, { sessionId: params.sessionId });
    return;
  }
  if (method === "session/prompt") {
    if (params?.prompt?.[0]?.text === "WAIT") {
      waiting = { id, sessionId: params.sessionId };
      return;
    }
    const sessionId = params?.sessionId;
    notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "think" },
      },
    });
    notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
      },
    });
    result(id, { stopReason: "end_turn" });
    return;
  }
  if (method === "session/cancel") {
    if (waiting && waiting.sessionId === params?.sessionId) {
      result(waiting.id, { stopReason: "cancelled" });
      waiting = null;
    }
    return;
  }
  if (method === "_x.ai/interject") {
    result(id, { result: { status: "queued" } });
    return;
  }
  if (method === "_x.ai/session/fork") {
    result(id, { newSessionId: "sess-fork-1" });
    return;
  }
  if (method === "_x.ai/rewind/execute") {
    result(id, { success: true, target_prompt_index: params?.targetPromptIndex ?? 0, mode: "all" });
    return;
  }
});
