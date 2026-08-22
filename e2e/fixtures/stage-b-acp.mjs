#!/usr/bin/env node
import { createInterface } from "node:readline";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const logPath = process.env.GROK_WEB_STAGE_B_LOG;
const cwdSessions = new Map();
const sessions = new Map();
let nextSession = 1;
let nextRequest = 1;
let pendingPermission;

function log(method, params = {}) {
  if (!logPath) return;
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${JSON.stringify({ method, params })}\n`);
}
function send(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function result(id, value) { send({ jsonrpc: "2.0", id, result: value }); }
function failure(id, message, code = -32601) { send({ jsonrpc: "2.0", id, error: { code, message } }); }
function notify(method, params) { send({ jsonrpc: "2.0", method, params }); }
function sessionIdFor(cwd) {
  const existing = cwdSessions.get(cwd);
  if (existing) return existing;
  const id = `stage-b-${nextSession++}`;
  cwdSessions.set(cwd, id);
  sessions.set(id, { cwd, mode: "default" });
  return id;
}
function snapshot(sessionId) {
  const session = sessions.get(sessionId);
  return {
    sessionId,
    configOptions: [{
      id: "mode",
      name: "Mode",
      type: "select",
      currentValue: session?.mode ?? "default",
      options: [
        { value: "default", name: "Default" },
        { value: "high", name: "High" },
        { value: "off", name: "Off" },
      ],
    }],
  };
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const { id, method, params = {} } = message;
  log(method, params);

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
    if (!sessions.has(sessionId)) sessions.set(sessionId, { cwd: params.cwd, mode: "default" });
    result(id, snapshot(sessionId));
    return;
  }
  if (method === "session/close") {
    result(id, { _meta: { "x.ai/closeOutcome": "closed" } });
    return;
  }
  if (method === "session/set_mode") {
    const session = sessions.get(params.sessionId);
    if (!session || !["default", "high", "off"].includes(params.modeId)) {
      failure(id, "unsupported mode", -32602);
      return;
    }
    session.mode = params.modeId;
    result(id, snapshot(params.sessionId));
    notify("session/update", { sessionId: params.sessionId, update: { sessionUpdate: "config_option_update", configOptions: snapshot(params.sessionId).configOptions } });
    return;
  }
  if (method === "session/prompt") {
    const sessionId = params.sessionId;
    const text = params.prompt?.[0]?.text ?? "";
    notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: text === "E2E_PARTIAL" ? "E2E_PAR" : "E2E_STREAM_OK" } } });
    if (text === "E2E_PARTIAL") {
      notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "TIAL_OK" } } });
    }
    if (text === "E2E_APPROVAL") {
      const requestId = nextRequest++;
      pendingPermission = { requestId, sessionId, promptId: id };
      log("session/request_permission", { sessionId, requestId });
      send({ jsonrpc: "2.0", id: requestId, method: "session/request_permission", params: {
        sessionId,
        toolCall: { title: "Allow fixture", kind: "execute", rawInput: { command: "echo E2E" } },
        options: [{ optionId: "allow-once", label: "Allow once", kind: "allow_once" }, { optionId: "reject-once", label: "Reject", kind: "reject_once" }],
      } });
    } else {
      result(id, { stopReason: "end_turn" });
    }
    return;
  }
  if (method === "session/cancel") {
    result(id, { stopReason: "cancelled" });
    return;
  }
  if (method === "_x.ai/mcp/list") {
    result(id, { servers: [{ name: `mcp-${params.session_id ?? "none"}`, source: "stage-b" }] });
    return;
  }
  if (method === "_x.ai/plugins/list") {
    result(id, { plugins: [{ name: `plugin-${params.sessionId ?? "none"}`, enabled: true }] });
    return;
  }
  if (method === "_x.ai/marketplace/list") {
    result(id, { sources: [] });
    return;
  }
  if (method === "_x.ai/plugins/action" || method === "_x.ai/marketplace/action") {
    result(id, { status: "success", message: "stage-b fixture" });
    return;
  }
  if (method === "_x.ai/auth/check_subscription") { result(id, { authenticated: true }); return; }
  if (method === "_x.ai/models/list") { result(id, { result: { currentModelId: "grok-4.6", availableModels: [{ modelId: "grok-4.6", name: "Grok 4.6" }] } }); return; }
  if (method === "_x.ai/git/worktree/list") { result(id, { worktrees: [] }); return; }

  if (pendingPermission && id === pendingPermission.requestId && message.result) {
    log("permission_response", { sessionId: pendingPermission.sessionId, result: message.result });
    const promptId = pendingPermission.promptId;
    pendingPermission = undefined;
    result(promptId, { stopReason: "end_turn" });
    return;
  }
  failure(id, `Unknown method: ${method}`);
});
