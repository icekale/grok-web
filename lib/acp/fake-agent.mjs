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

function sessionConfigResult(sessionId) {
  return {
    sessionId,
    configOptions: [{
      id: "tools",
      name: "Tools",
      type: "select",
      currentValue: toolsPreset,
      options: [
        { value: "none", name: "None" },
        { value: "read-only", name: "Read only" },
        { value: "default", name: "Default" },
        { value: "full", name: "Full" },
      ],
    }],
  };
}

let waiting = null;
let currentModel = "grok-4.6";
let toolsPreset = "default";
let authenticated = false;
const files = new Map();
const mcpServers = new Map([
  ["docs", { name: "docs", source: "local", type: "stdio", command: "true" }],
]);
const runningSubs = new Map();
const terminals = new Map();
const skills = [
  {
    name: "demo",
    description: "demo skill",
    path: "/tmp/demo/SKILL.md",
    scope: "user",
    enabled: true,
    disable_model_invocation: false,
  },
  {
    name: "local",
    description: "local skill",
    path: "/tmp/local/SKILL.md",
    scope: "local",
    enabled: true,
    disable_model_invocation: false,
  },
];

createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (method === "initialize") {
    result(id, {
      protocolVersion: 1,
      agentCapabilities: {
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
      },
      _meta: {
        grokShell: true,
        availableCommands: [
          { name: "compact", description: "Compress conversation history" },
          { name: "always-approve", description: "Toggle always-approve" },
          { name: "session-info", description: "Show session details" },
          { name: "demo", description: "demo skill from acp" },
        ],
      },
    });
    return;
  }
  if (method === "session/close") {
    if (!params?.sessionId) {
      error(id, -32602, "missing field `sessionId`");
      return;
    }
    result(id, { _meta: { "x.ai/closeOutcome": "closed" } });
    return;
  }
  if (method === "session/resume") {
    if (!params?.sessionId) {
      error(id, -32602, "missing field `sessionId`");
      return;
    }
    if (!params?.cwd) {
      error(id, -32602, "missing field `cwd`");
      return;
    }
    result(id, { sessionId: params.sessionId });
    return;
  }
  if (method === "session/new") {
    toolsPreset = "default";
    result(id, sessionConfigResult("sess-new-1"));
    return;
  }
  if (method === "session/load") {
    if (params?.sessionId === "missing") {
      error(id, -32000, "session not found");
      return;
    }
    if (!Array.isArray(params?.mcpServers)) {
      error(id, -32602, "Invalid params");
      return;
    }
    result(id, sessionConfigResult(params.sessionId));
    return;
  }
  if (method === "session/set_config_option") {
    const optionId = params?.id ?? params?.configId;
    if (optionId !== "tools") {
      error(id, -32602, "unknown config option");
      return;
    }
    toolsPreset = params?.value ?? toolsPreset;
    result(id, sessionConfigResult(params?.sessionId ?? "sess-new-1"));
    return;
  }
  if (method === "session/prompt") {
    if (params?.prompt?.[0]?.text === "WAIT") {
      waiting = { id, sessionId: params.sessionId };
      return;
    }
    const sessionId = params?.sessionId;
    if (params?.prompt?.[0]?.text === "BASH") {
      notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call-fake-1",
          title: "run_terminal_command",
          rawInput: { command: "ls", description: "List files" },
        },
      });
      notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-fake-1",
          title: "Execute `ls`",
          kind: "execute",
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: "a.ts\n" } }],
        },
      });
      result(id, { stopReason: "end_turn" });
      return;
    }
    if (params?.prompt?.[0]?.text === "SPAWN_SUB") {
      const current = runningSubs.get(sessionId) ?? [];
      current.push({
        subagentId: "sub-1",
        childSessionId: "sub-1",
        description: "explore task",
        status: "running",
        subagentType: "explore",
      });
      runningSubs.set(sessionId, current);
    }
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
  if (method === "_x.ai/git/stage") {
    if (!Array.isArray(params?.paths) || params.paths.length === 0) {
      error(id, -32602, "paths are required");
      return;
    }
    result(id, { result: { paths: params.paths } });
    return;
  }
  if (method === "_x.ai/git/discard") {
    if (!Array.isArray(params?.paths) || params.paths.length === 0) {
      error(id, -32602, "paths are required");
      return;
    }
    result(id, { result: { ok: true } });
    return;
  }
  if (method === "_x.ai/git/commit") {
    if (!params?.message || String(params.message).trim() === "") {
      error(id, -32602, "missing field `message`");
      return;
    }
    result(id, { result: { ok: true } });
    return;
  }
  if (method === "_x.ai/feedback") {
    if (!params?.session_id) {
      error(id, -32602, "missing field `session_id`");
      return;
    }
    if (!params?.feedback_text) {
      error(id, -32602, "missing field `feedback_text`");
      return;
    }
    result(id, { success: true });
    return;
  }
  if (method === "_x.ai/recap") {
    if (!params?.sessionId) {
      error(id, -32602, "missing field `sessionId`");
      return;
    }
    result(id, { result: { ok: true } });
    return;
  }
  if (method === "_x.ai/prompt_history") {
    if (!params?.cwd) {
      error(id, -32602, "missing field `cwd`");
      return;
    }
    result(id, { prompts: ["prev"] });
    return;
  }
  if (method === "_x.ai/git/diffs") {
    const patch = params?.includePatch
      ? "diff --git a/readme.md b/readme.md\n@@ -1,1 +1,2 @@\n+ok\n"
      : undefined;
    result(id, {
      result: {
        files: [{
          path: (params?.paths?.[0] ?? "readme.md"),
          type: "edit",
          additions: 1,
          deletions: 0,
          ...(patch ? { patch } : {}),
        }],
      },
    });
    return;
  }
  if (method === "_x.ai/search/fuzzy/open") {
    if (!params?.cwd && !params?.sessionId) {
      error(id, -32602, "cwd or sessionId required");
      return;
    }
    result(id, { sessionId: params.sessionId ?? "agent", searchId: "search-1" });
    return;
  }
  if (method === "_x.ai/search/fuzzy/change") {
    if (!params?.searchId) {
      error(id, -32602, "missing field `searchId`");
      return;
    }
    notify("_x.ai/search/fuzzy/status", {
      sessionId: "agent",
      searchId: params.searchId,
      matches: [{
        name: "runtime.ts",
        type: "file",
        path: "/tmp/p/lib/runtime.ts",
        score: 100,
      }],
    });
    result(id, { sessionId: "agent", searchId: params.searchId });
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
  if (method === "_x.ai/mcp/list") {
    result(id, { result: { servers: [...mcpServers.values()] } });
    return;
  }
  if (method === "_x.ai/mcp/toggle") {
    const server = mcpServers.get(params?.server_name);
    if (server) {
      server.session = { enabled: params?.enabled };
      if (params?.enabled === false) {
        server.command = "";
      }
    }
    result(id, { result: { ok: true } });
    return;
  }
  if (method === "_x.ai/mcp/upsert") {
    const name = params?.server_name;
    mcpServers.set(name, {
      name,
      source: params?.source ?? "local",
      type: params?.url ? "http" : "stdio",
      command: params?.command,
      url: params?.url,
      args: params?.args,
    });
    result(id, { result: { ok: true } });
    return;
  }
  if (method === "_x.ai/mcp/delete") {
    mcpServers.delete(params?.server_name);
    result(id, { result: { ok: true } });
    return;
  }
  if (method === "_x.ai/skills/list") {
    if (!params?.cwd) {
      error(id, -32602, "missing field `cwd`");
      return;
    }
    result(id, { result: { skills } });
    return;
  }
  if (method === "_x.ai/skills/toggle") {
    if (!params?.name) {
      error(id, -32602, "missing field `name`");
      return;
    }
    if (typeof params.enabled !== "boolean") {
      error(id, -32602, "missing field `enabled`");
      return;
    }
    const skill = skills.find((item) => item.name === params.name);
    if (skill) skill.enabled = params.enabled;
    result(id, { result: { skills } });
    return;
  }
  if (method === "_x.ai/subagent/list_running") {
    if (!params?.sessionId) {
      error(id, -32602, "missing field `sessionId`");
      return;
    }
    result(id, { result: { subagents: [...(runningSubs.get(params.sessionId) ?? [])] } });
    return;
  }
  if (method === "_x.ai/subagent/cancel") {
    if (!params?.subagentId) {
      error(id, -32602, "missing field `subagentId`");
      return;
    }
    let found = false;
    for (const [sessionId, items] of runningSubs) {
      const next = items.filter((item) => item.subagentId !== params.subagentId);
      if (next.length !== items.length) found = true;
      runningSubs.set(sessionId, next);
    }
    result(id, {
      result: {
        subagentId: params.subagentId,
        cancelled: found,
        outcome: { kind: found ? "cancelled" : "not_found" },
      },
    });
    return;
  }
  if (method === "_x.ai/session/rename") {
    if (!params?.sessionId) {
      error(id, -32602, "missing field `sessionId`");
      return;
    }
    if (!params?.title || String(params.title).trim() === "") {
      error(id, -32600, "title must not be blank");
      return;
    }
    result(id, { success: true });
    return;
  }
  if (method === "_x.ai/terminal/create") {
    if (!params?.sessionId) {
      error(id, -32602, "missing field `sessionId`");
      return;
    }
    if (!params?.command) {
      error(id, -32602, "missing field `command`");
      return;
    }
    const terminalId = `term-${terminals.size + 1}`;
    const waiting = String(params.command).includes("WAIT_BASH");
    terminals.set(terminalId, {
      sessionId: params.sessionId,
      command: params.command,
      cwd: params.cwd,
      output: waiting ? "" : `ran:${params.command}`,
      exitCode: waiting ? null : 0,
      waiters: [],
    });
    result(id, { result: { terminalId } });
    return;
  }
  if (method === "_x.ai/terminal/wait_for_exit") {
    if (!params?.sessionId || !params?.terminalId) {
      error(id, -32602, "missing field `terminalId`");
      return;
    }
    const term = terminals.get(params.terminalId);
    if (!term) {
      error(id, -32602, "unknown terminal");
      return;
    }
    if (term.exitCode !== null) {
      result(id, { result: { exitCode: term.exitCode } });
      return;
    }
    term.waiters.push(id);
    return;
  }
  if (method === "_x.ai/terminal/output") {
    if (!params?.sessionId || !params?.terminalId) {
      error(id, -32602, "missing field `terminalId`");
      return;
    }
    const term = terminals.get(params.terminalId);
    if (!term) {
      error(id, -32602, "unknown terminal");
      return;
    }
    result(id, {
      result: {
        output: term.output,
        truncated: false,
        ...(term.exitCode !== null ? { exitStatus: { exitCode: term.exitCode } } : {}),
      },
    });
    return;
  }
  if (method === "_x.ai/terminal/kill") {
    if (!params?.terminalId) {
      error(id, -32602, "missing field `terminalId`");
      return;
    }
    const term = terminals.get(params.terminalId);
    if (!term) {
      result(id, { result: { outcome: "already_exited" } });
      return;
    }
    term.exitCode = 137;
    for (const waiter of term.waiters.splice(0)) {
      result(waiter, { result: { exitCode: 137 } });
    }
    result(id, { result: { outcome: "killed" } });
    return;
  }
  if (method === "_x.ai/compact_conversation") {
    if (!params?.session_id) {
      error(id, -32602, "missing field `session_id`");
      return;
    }
    result(id, { result: { tokensBefore: 100, estimatedTokensAfter: 40 } });
    return;
  }
});
