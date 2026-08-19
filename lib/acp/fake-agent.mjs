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
let authenticated = false;
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
  if (method === "_x.ai/git/status") {
    result(id, { result: { root: process.cwd(), branch: "main", staged: [], unstaged: [] } });
    return;
  }
  if (method === "_x.ai/git/worktree/list") {
    result(id, { result: [] });
    return;
  }
  if (method === "_x.ai/git/worktree/create") {
    result(id, { result: { worktreePath: `${params?.sourcePath ?? ""}-wt`, status: "creating" } });
    return;
  }
  if (method === "_x.ai/git/worktree/remove") {
    result(id, { result: {} });
    return;
  }
  if (method === "_x.ai/auth/check_subscription") {
    result(id, { authenticated, meta: null });
    return;
  }
  if (method === "_x.ai/auth/get_url") {
    result(id, {
      auth_url: "https://accounts.x.ai/oauth2/device?user_code=FAKE-CODE",
      external_provider: false,
      mode: "device",
    });
    return;
  }
  if (method === "_x.ai/auth/submit_code") {
    if (!params?.code) {
      error(id, -32602, "missing field `code`");
      return;
    }
    authenticated = true;
    result(id, { submitted: true });
    return;
  }
  if (method === "_x.ai/auth/cancel") {
    result(id, { cancelled: true });
    return;
  }
  if (method === "_x.ai/auth/logout") {
    authenticated = false;
    result(id, { ok: true, was_logged_in: true, email: null, api_key_still_set: false });
    return;
  }
  if (method === "authenticate") {
    if (!params?.methodId) {
      error(id, -32602, "missing field `methodId`");
      return;
    }
    authenticated = true;
    result(id, {});
    return;
  }
});
