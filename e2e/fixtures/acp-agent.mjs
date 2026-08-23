#!/usr/bin/env node
import { createInterface } from "node:readline";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

const scenario = process.env.GROK_WEB_ACP_FIXTURE_SCENARIO || "core";
if (process.argv.includes("--version")) { process.stdout.write("grok-fixture 1.0.0\n"); process.exit(0); }
if (process.argv.includes("--help")) {
  if (process.argv.includes("stdio")) process.stdout.write("--leader-socket <PATH>\n");
  else if (process.argv.includes("agent")) process.stdout.write("--agent-profile <PATH>\n");
  else process.stdout.write("--agent <NAME> --sandbox <PROFILE> --permission-mode <MODE> --allow <RULE> --deny <RULE> --disable-web-search --no-subagents --max-turns <N> --rules <RULES> --restore-code --worktree [<WORKTREE>]\n");
  process.exit(0);
}
if (process.argv.includes("inspect")) { process.stdout.write(JSON.stringify({ agents: [{ name: "builder", description: "Fixture builder", source: { kind: "fixture" } }] }) + "\n"); process.exit(0); }
const logPath = process.env.GROK_WEB_ACP_FIXTURE_LOG || process.env.GROK_WEB_STAGE_B_LOG;
const controlPath = process.env.GROK_WEB_ACP_FIXTURE_CONTROL;
const testId = process.env.GROK_WEB_ACP_FIXTURE_TEST_ID || "acp-e2e";
const roots = parseRoots(process.env.GROK_WEB_ACP_FIXTURE_ROOTS);
const cwdSessions = new Map();
const sessions = new Map();
const pendingPermissions = new Map();
const pausedPrompts = new Map();
const fixtureWorktrees = new Map();
let nextSession = 1;
let nextRequest = 1;

function parseRoots(value) {
  if (!value) return new Map();
  try {
    const parsed = JSON.parse(value);
    return new Map(Object.entries(parsed));
  } catch {
    return new Map();
  }
}
function cwdAlias(cwd) {
  if (!cwd) return "<unknown-cwd>";
  for (const [root, alias] of roots) {
    if (cwd === root || cwd.startsWith(`${root}/`)) return alias;
  }
  if (cwd.endsWith("/project-a")) return "<project-a>";
  if (cwd.endsWith("/project-b")) return "<project-b>";
  return "<fixture-cwd>";
}
function sessionFor(params = {}) {
  const id = params.sessionId ?? params.session_id;
  return id ? sessions.get(id) : undefined;
}
function log(method, params = {}, session = sessionFor(params), status = "") {
  if (!logPath) return;
  const cwd = params.cwd || session?.cwd;
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${JSON.stringify({
    cwdAlias: cwdAlias(cwd),
    method,
    sessionId: session?.id || params.sessionId || params.session_id || "",
    status,
    testId,
    timestamp: Date.now(),
  })}\n`);
}
function send(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function result(id, value) { send({ jsonrpc: "2.0", id, result: value }); }
function failure(id, message, code = -32601) { send({ jsonrpc: "2.0", id, error: { code, message } }); }
function notify(method, params) { send({ jsonrpc: "2.0", method, params }); }
function sessionIdFor(cwd) {
  const id = `acp-e2e-${nextSession++}`;
  const session = { id, cwd, mode: "default" };
  cwdSessions.set(`${cwd}:${id}`, id);
  sessions.set(id, session);
  return id;
}
function configOptions(session) {
  return [{
    id: "mode",
    name: "Thinking",
    type: "select",
    currentValue: session?.mode ?? "default",
    options: [
      { value: "default", name: "Default" },
      { value: "high", name: "High" },
      { value: "off", name: "Off" },
    ],
  }];
}
function snapshot(sessionId) {
  const session = sessions.get(sessionId);
  return {
    sessionId,
    configOptions: configOptions(session),
    modes: { currentModeId: session?.mode ?? "default", availableModes: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }] },
    agentCapabilities: { promptCapabilities: { image: false } },
  };
}
function waitForControl(key, callback) {
  const timer = setInterval(() => {
    if (!controlPath || !existsSync(controlPath)) return;
    let command = "";
    try { command = readFileSync(controlPath, "utf8").trim(); } catch { return; }
    if (!command) return;
    clearInterval(timer);
    callback(command);
  }, 20);
}
function finishPrompt(id, sessionId, text = "E2E_STREAM_OK") {
  notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
  result(id, { stopReason: "end_turn" });
}
function startPrompt(id, sessionId, text) {
  if (text === "E2E_PAUSE" || text === "E2E_PARTIAL" || text === "WAIT") {
    pausedPrompts.set(sessionId, { id, text });
    notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: text === "WAIT" ? "" : "E2E_PAR" } } });
    if (text === "WAIT") return;
    return waitForControl(`${sessionId}:${id}`, (command) => {
      pausedPrompts.delete(sessionId);
      if (command === "cancel") {
        result(id, { stopReason: "cancelled" });
        return;
      }
      finishPrompt(id, sessionId, text === "E2E_PARTIAL" ? "TIAL_OK" : "E2E_STREAM_OK");
    });
  }
  if (text === "E2E_THOUGHT_TEXT" || text === "E2E_TEXT_MARKER") {
    notify("session/update", { sessionId, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "E2E_THINKING" } } });
    finishPrompt(id, sessionId, "E2E_STREAM_OK");
    return;
  }
  if (text === "E2E_TOOL") {
    notify("session/update", { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "e2e-tool-1", title: "run_terminal_command", rawInput: { command: "echo E2E_TOOL" } } });
    notify("session/update", { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "e2e-tool-1", status: "in_progress", title: "Running fixture" } });
    notify("session/update", { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "e2e-tool-1", status: "completed", content: [{ type: "content", content: { type: "text", text: "E2E_TOOL_OK" } }] } });
    result(id, { stopReason: "end_turn" });
    return;
  }
  if (text === "E2E_APPROVAL") {
    const requestId = nextRequest++;
    pendingPermissions.set(`${sessionId}:${requestId}`, { requestId, sessionId, promptId: id });
    send({ jsonrpc: "2.0", id: requestId, method: "session/request_permission", params: {
      sessionId,
      toolCall: { title: "Allow fixture", kind: "execute", rawInput: { command: "echo E2E" } },
      options: [{ optionId: "allow-once", label: "Allow once", kind: "allow_once" }, { optionId: "reject-once", label: "Reject", kind: "reject_once" }],
    } });
    return;
  }
  finishPrompt(id, sessionId, text === "E2E_TEXT_MARKER" ? "E2E_STREAM_OK" : "E2E_STREAM_OK");
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const { id, method, params = {} } = message;
  const session = sessionFor(params);
  const pendingResponse = id !== undefined && message.result
    ? [...pendingPermissions.values()].find((item) => item.requestId === id)
    : undefined;
  log(method || (pendingResponse ? "permission_response" : "rpc_response"), params, pendingResponse ? sessions.get(pendingResponse.sessionId) : session, pendingResponse ? (message.result?.outcome?.outcome === "selected" ? "allowed" : "rejected") : "");

  if (method === "initialize") {
    result(id, { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: false } } });
    return;
  }
  if (method === "session/new") {
    const sessionId = sessionIdFor(params.cwd);
    result(id, snapshot(sessionId));
    return;
  }
  if (method === "session/load") {
    const sessionId = params.sessionId;
    if (!sessions.has(sessionId)) sessions.set(sessionId, { id: sessionId, cwd: params.cwd, mode: "default" });
    result(id, snapshot(sessionId));
    return;
  }
  if (method === "session/close") {
    const closed = sessions.get(params.sessionId);
    if (closed && cwdSessions.get(closed.cwd) === params.sessionId) cwdSessions.delete(closed.cwd);
    sessions.delete(params.sessionId);
    pausedPrompts.delete(params.sessionId);
    result(id, { _meta: { "x.ai/closeOutcome": "closed" }, outcome: "closed" });
    return;
  }
  if (method === "session/set_mode" || method === "session/set_config_option") {
    const target = sessionFor(params);
    const mode = params.modeId ?? params.value;
    const allowed = ["default", "high", "off", "plan"];
    if (!target || !allowed.includes(mode)) {
      failure(id, "unsupported mode", -32602);
      return;
    }
    target.mode = mode;
    result(id, snapshot(target.id));
    notify("session/update", { sessionId: target.id, update: { sessionUpdate: "config_option_update", configOptions: configOptions(target) } });
    return;
  }
  if (method === "session/set_model") { result(id, { _meta: { model: { Ok: params.modelId || "grok-4.6" } } }); return; }
  if (method === "session/prompt") {
    startPrompt(id, params.sessionId, params.prompt?.[0]?.text ?? "");
    return;
  }
  if (method === "session/cancel") {
    const waiting = pausedPrompts.get(params.sessionId);
    if (waiting) {
      pausedPrompts.delete(params.sessionId);
      result(waiting.id, { stopReason: "cancelled" });
    }
    result(id, { stopReason: "cancelled" });
    return;
  }
  if (method === "_x.ai/mcp/list") { result(id, { servers: [{ name: `mcp-${params.session_id || "none"}`, source: "acp-e2e" }] }); return; }
  if (method === "_x.ai/plugins/list") { result(id, { plugins: [{ name: `plugin-${params.sessionId || "none"}`, enabled: true }] }); return; }
  if (method === "_x.ai/marketplace/list") { result(id, { sources: [] }); return; }
  if (method === "_x.ai/models/list") {
    result(id, { result: { currentModelId: "grok-4.6", availableModels: [{
      modelId: "grok-4.6",
      name: "Grok 4.6",
      _meta: {
        reasoningEffort: "high",
        reasoningEfforts: [
          { id: "off", label: "Off" },
          { id: "high", label: "High", default: true },
        ],
      },
    }] } });
    return;
  }
  if (method === "_x.ai/auth/check_subscription") { result(id, { authenticated: true }); return; }
  if (method === "_x.ai/git/worktree/list") { result(id, { worktrees: [...fixtureWorktrees.values()] }); return; }
  if (method === "_x.ai/git/worktree/create") {
    const sourcePath = params.sourcePath;
    const worktreePath = join(sourcePath, ".grok-web-e2e-restore");
    mkdirSync(worktreePath, { recursive: true });
    fixtureWorktrees.set(worktreePath, { path: worktreePath, branch: "restore/fixture" });
    result(id, { worktreePath });
    return;
  }
  if (method === "_x.ai/git/worktree/remove") {
    const worktreePath = params.worktreePath;
    fixtureWorktrees.delete(worktreePath);
    try { rmSync(worktreePath, { recursive: true, force: true }); } catch {}
    result(id, { status: "removed" });
    return;
  }
  if (method === "_x.ai/session/fork") {
    const source = sessionFor({ sessionId: params.sourceSessionId });
    const forkedId = `acp-e2e-fork-${nextSession++}`;
    sessions.set(forkedId, { id: forkedId, cwd: params.newCwd, mode: source?.mode ?? "default" });
    result(id, { newSessionId: forkedId });
    return;
  }
  if (method === "_x.ai/plugins/action" || method === "_x.ai/marketplace/action") { result(id, { status: "success" }); return; }

  if (pendingResponse) {
    pendingPermissions.delete(`${pendingResponse.sessionId}:${pendingResponse.requestId}`);
    result(pendingResponse.promptId, { stopReason: "end_turn" });
    return;
  }
  failure(id, `Method not found: ${method}`);
});

if (scenario === "fail-unknown") {
  // The default handler already rejects every method outside the explicit contract.
}
