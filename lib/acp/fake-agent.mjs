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
let currentModel = "grok-4.6";
const files = new Map();

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
  if (method === "_x.ai/models/list") {
    result(id, {
      result: {
        currentModelId: currentModel,
        availableModels: [
          { modelId: "grok-4.6", name: "Grok 4.6" },
          { modelId: "grok-4.5", name: "Grok 4.5" },
        ],
      },
    });
    return;
  }
  if (method === "session/set_model") {
    currentModel = params?.modelId ?? currentModel;
    result(id, { _meta: { model: { Ok: currentModel } } });
    return;
  }
  if (method === "session/set_mode") {
    result(id, {});
    return;
  }
  if (method === "_x.ai/fs/list") {
    const prefix = params?.path ?? "";
    const nodes = [];
    for (const filePath of files.keys()) {
      if (filePath.startsWith(prefix)) {
        nodes.push({
          name: filePath.slice(filePath.lastIndexOf("/") + 1),
          path: filePath,
          type: "file",
          modifiedAt: new Date().toISOString(),
        });
      }
    }
    result(id, { result: { nodes } });
    return;
  }
  if (method === "_x.ai/fs/read_file") {
    result(id, { result: { content: files.get(params?.path) ?? "" } });
    return;
  }
  if (method === "_x.ai/fs/write_file") {
    files.set(params?.path, params?.content);
    result(id, { result: {} });
    return;
  }
});
