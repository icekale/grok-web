import { JsonRpcConn } from "./jsonrpc.ts";
import {
  resolvePermission,
  translatePermissionRequest,
  type PermissionUiRequest,
} from "./permissions.ts";

type PendingPermission = {
  request: unknown;
  requestId: string;
  startedAt: number;
  timer: ReturnType<typeof setTimeout>;
};

export class AcpConnection {
  private readonly rpc: JsonRpcConn;
  private readonly permissionTimeoutMs: number;
  private readonly now: () => number;
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly permissionHandlers = new Set<(event: PermissionUiRequest) => void>();
  private readonly fuzzyWaiters = new Map<string, (matches: Array<{ path: string; type?: string; name?: string }>) => void>();
  availableCommands: Array<{ name: string; description?: string }> = [];

  constructor(rpc: JsonRpcConn, options: { permissionTimeoutMs?: number; now?: () => number } = {}) {
    this.rpc = rpc;
    this.permissionTimeoutMs = options.permissionTimeoutMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.rpc.onNotification((method, params, id) => {
      if (method === "_x.ai/search/fuzzy/status" && isRecord(params) && typeof params.searchId === "string") {
        const waiter = this.fuzzyWaiters.get(params.searchId);
        if (waiter) {
          this.fuzzyWaiters.delete(params.searchId);
          waiter(Array.isArray(params.matches) ? params.matches : []);
        }
        return;
      }
      if (method !== "session/request_permission" || typeof id !== "number") return;
      const sessionId = validSessionId(params);
      if (!sessionId) {
        const startedAt = this.now();
        this.rpc.respond(id, resolvePermission({ cancelled: true }, params, {
          startedAt,
          now: startedAt,
          timeoutMs: this.permissionTimeoutMs,
        }));
        return;
      }
      const requestId = String(id);
      const key = permissionKey(sessionId, requestId);
      const existing = this.pendingPermissions.get(key);
      if (existing) clearTimeout(existing.timer);
      const startedAt = this.now();
      const timer = setTimeout(() => this.expirePermission(key), this.permissionTimeoutMs);
      this.pendingPermissions.set(key, { request: params, requestId, startedAt, timer });
      const event = translatePermissionRequest(params, id);
      const uiRequest = sessionId ? { ...event, sessionId } : event;
      for (const handler of this.permissionHandlers) handler(uiRequest);
    });
    this.rpc.onClose(() => {
      for (const pending of this.pendingPermissions.values()) clearTimeout(pending.timer);
      this.pendingPermissions.clear();
    });
  }

  onPermission(handler: (event: PermissionUiRequest) => void): () => void {
    this.permissionHandlers.add(handler);
    return () => {
      this.permissionHandlers.delete(handler);
    };
  }

  completePermission(
    sessionId: string,
    id: string,
    ui: { confirmed?: boolean; cancelled?: boolean },
  ): void {
    const key = permissionKey(sessionId, id);
    const pending = this.pendingPermissions.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingPermissions.delete(key);
    this.rpc.respond(Number(id), resolvePermission(ui, pending.request, {
      startedAt: pending.startedAt,
      now: this.now(),
      timeoutMs: this.permissionTimeoutMs,
    }));
  }

  private expirePermission(id: string): void {
    const pending = this.pendingPermissions.get(id);
    if (!pending) return;
    this.pendingPermissions.delete(id);
    this.rpc.respond(Number(pending.requestId), resolvePermission({ cancelled: true }, pending.request, {
      startedAt: pending.startedAt,
      now: this.now(),
      timeoutMs: this.permissionTimeoutMs,
    }));
  }

  onClose(handler: (error: Error) => void): () => void {
    return this.rpc.onClose(handler);
  }

  close(): void {
    this.rpc.close();
  }

  async initialize(): Promise<unknown> {
    const raw = await this.rpc.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    });
    this.availableCommands = readAvailableCommands(raw);
    return raw;
  }

  sessionNew(cwd: string, meta: Record<string, unknown> = {}): Promise<{ sessionId: string }> {
    return this.rpc.request("session/new", {
      cwd,
      mcpServers: [],
      _meta: meta,
    }) as Promise<{ sessionId: string }>;
  }

  sessionLoad(sessionId: string, cwd?: string): Promise<{ sessionId: string }> {
    return this.rpc.request("session/load", {
      sessionId,
      cwd,
      mcpServers: [],
    }) as Promise<{ sessionId: string }>;
  }

  sessionResume(sessionId: string, cwd: string): Promise<{ sessionId?: string }> {
    return this.rpc.request("session/resume", {
      sessionId,
      cwd,
      mcpServers: [],
    }) as Promise<{ sessionId?: string }>;
  }

  sessionClose(sessionId: string): Promise<{ _meta?: { "x.ai/closeOutcome"?: string }; outcome?: string }> {
    return this.rpc.request("session/close", { sessionId }) as Promise<{
      _meta?: { "x.ai/closeOutcome"?: string };
      outcome?: string;
    }>;
  }

  sessionPrompt(sessionId: string, text: string): Promise<unknown> {
    return this.rpc.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }],
    });
  }

  sessionCancel(sessionId: string): void {
    this.rpc.notify("session/cancel", { sessionId });
  }

  sessionInterject(sessionId: string, text: string): Promise<unknown> {
    return this.rpc.request("_x.ai/interject", { sessionId, text });
  }

  sessionFork(params: {
    sourceSessionId: string;
    sourceCwd: string;
    newCwd: string;
  }): Promise<{ newSessionId: string }> {
    return this.rpc.request("_x.ai/session/fork", params) as Promise<{ newSessionId: string }>;
  }

  rewindExecute(sessionId: string, targetPromptIndex: number): Promise<{ success?: boolean; error?: string }> {
    return this.rpc.request("_x.ai/rewind/execute", {
      sessionId,
      targetPromptIndex,
    }) as Promise<{ success?: boolean; error?: string }>;
  }

  modelsList(): Promise<{ currentModelId: string; availableModels: Array<{ modelId: string; name?: string; _meta?: unknown }> }> {
    return this.rpc.request("_x.ai/models/list", {}).then((raw) => unwrapResult(raw) as never);
  }

  sessionSetModel(sessionId: string, modelId: string): Promise<{ modelId: string }> {
    return this.rpc.request("session/set_model", { sessionId, modelId }).then((raw) => {
      const meta = raw && typeof raw === "object" && "_meta" in raw
        ? (raw as { _meta?: { model?: { Ok?: string } } })._meta
        : undefined;
      return { modelId: meta?.model?.Ok ?? modelId };
    });
  }

  sessionSetMode(sessionId: string, modeId: string): Promise<unknown> {
    return this.rpc.request("session/set_mode", { sessionId, modeId });
  }

  sessionSetConfigOption(
    sessionId: string,
    id: string,
    value: string | boolean,
  ): Promise<unknown> {
    return this.rpc.request("session/set_config_option", {
      sessionId,
      id,
      configId: id,
      value,
    });
  }

  fsList(path: string): Promise<{ nodes: Array<{ name: string; path: string; type: string }> }> {
    return this.rpc.request("_x.ai/fs/list", { path }).then((raw) => unwrapResult(raw) as never);
  }

  fsRead(path: string): Promise<{ content: string }> {
    return this.rpc.request("_x.ai/fs/read_file", { path }).then((raw) => unwrapResult(raw) as never);
  }

  fsWrite(path: string, content: string): Promise<void> {
    return this.rpc.request("_x.ai/fs/write_file", { path, content }).then(() => undefined);
  }

  gitStatus(): Promise<unknown> {
    return this.rpc.request("_x.ai/git/status", {}).then(unwrapResult);
  }

  async gitStage(paths: string[]): Promise<{ paths: string[] }> {
    if (paths.length === 0) throw new Error("paths are required");
    return this.rpc.request("_x.ai/git/stage", { paths }).then((raw) => unwrapResult(raw) as never);
  }

  async gitDiscard(paths: string[]): Promise<unknown> {
    if (paths.length === 0) throw new Error("paths are required");
    return this.rpc.request("_x.ai/git/discard", { paths }).then(unwrapResult);
  }

  async gitCommit(message: string): Promise<{ ok?: boolean }> {
    const trimmed = message.trim();
    if (!trimmed) throw new Error("message is required");
    return this.rpc.request("_x.ai/git/commit", { message: trimmed }).then((raw) => unwrapResult(raw) as never);
  }

  gitDiffs(paths: string[], includePatch = false): Promise<{
    files: Array<{ path: string; type?: string; additions?: number; deletions?: number; patch?: string }>;
  }> {
    return this.rpc.request("_x.ai/git/diffs", {
      ...(paths.length > 0 ? { paths } : {}),
      ...(includePatch ? { includePatch: true } : {}),
    }).then((raw) => unwrapResult(raw) as never);
  }

  worktreeList(): Promise<unknown> {
    return this.rpc.request("_x.ai/git/worktree/list", {}).then(unwrapResult);
  }

  worktreeCreate(sessionId: string, sourcePath: string): Promise<{ worktreePath?: string; status?: string }> {
    return this.rpc.request("_x.ai/git/worktree/create", { sessionId, sourcePath }).then((raw) => unwrapResult(raw) as never);
  }

  worktreeRemove(worktreePath: string): Promise<unknown> {
    return this.rpc.request("_x.ai/git/worktree/remove", { worktreePath }).then(unwrapResult);
  }

  authCheck(): Promise<{ authenticated: boolean; meta?: unknown }> {
    return this.rpc.request("_x.ai/auth/check_subscription", {}) as Promise<{ authenticated: boolean; meta?: unknown }>;
  }

  authGetUrl(): Promise<{ auth_url: string; external_provider?: boolean; mode?: string }> {
    return this.rpc.request("_x.ai/auth/get_url", {}) as Promise<{
      auth_url: string;
      external_provider?: boolean;
      mode?: string;
    }>;
  }

  authSubmitCode(code: string): Promise<{ submitted?: boolean }> {
    return this.rpc.request("_x.ai/auth/submit_code", { code }) as Promise<{ submitted?: boolean }>;
  }

  authCancel(): Promise<{ cancelled?: boolean }> {
    return this.rpc.request("_x.ai/auth/cancel", {}) as Promise<{ cancelled?: boolean }>;
  }

  authLogout(): Promise<{ ok?: boolean; was_logged_in?: boolean; api_key_still_set?: boolean }> {
    return this.rpc.request("_x.ai/auth/logout", {}) as Promise<{
      ok?: boolean;
      was_logged_in?: boolean;
      api_key_still_set?: boolean;
    }>;
  }

  authenticate(methodId: string): Promise<unknown> {
    return this.rpc.request("authenticate", { methodId });
  }

  mcpList(): Promise<{ servers: Array<{
    name: string;
    source?: string;
    type?: string;
    command?: string;
    session?: { enabled?: boolean };
  }> }> {
    return this.rpc.request("_x.ai/mcp/list", {}).then((raw) => unwrapResult(raw) as never);
  }

  mcpToggle(sessionId: string, serverName: string, enabled: boolean): Promise<unknown> {
    return this.rpc.request("_x.ai/mcp/toggle", {
      session_id: sessionId,
      server_name: serverName,
      enabled,
    }).then(unwrapResult);
  }

  mcpUpsert(sessionId: string, serverName: string, transport: { command?: string; url?: string; args?: string[] }): Promise<unknown> {
    return this.rpc.request("_x.ai/mcp/upsert", {
      session_id: sessionId,
      server_name: serverName,
      ...transport,
    }).then(unwrapResult);
  }

  mcpDelete(sessionId: string, serverName: string): Promise<unknown> {
    return this.rpc.request("_x.ai/mcp/delete", {
      session_id: sessionId,
      server_name: serverName,
    }).then(unwrapResult);
  }

  skillsList(cwd: string): Promise<{ skills: Array<{
    name: string;
    description?: string;
    path: string;
    scope?: string;
    enabled?: boolean;
    disable_model_invocation?: boolean;
  }> }> {
    return this.rpc.request("_x.ai/skills/list", { cwd }).then((raw) => unwrapResult(raw) as never);
  }

  skillsToggle(name: string, enabled: boolean): Promise<{ skills: Array<{ name: string; enabled?: boolean; path?: string }> }> {
    return this.rpc.request("_x.ai/skills/toggle", { name, enabled }).then((raw) => unwrapResult(raw) as never);
  }

  subagentListRunning(sessionId: string): Promise<{
    subagents: Array<{
      subagentId: string;
      childSessionId?: string;
      description?: string;
      status?: string;
      subagentType?: string;
    }>;
  }> {
    return this.rpc.request("_x.ai/subagent/list_running", { sessionId }).then((raw) => unwrapResult(raw) as never);
  }

  subagentCancel(subagentId: string): Promise<{
    subagentId?: string;
    cancelled?: boolean;
    outcome?: { kind?: string };
  }> {
    return this.rpc.request("_x.ai/subagent/cancel", { subagentId }).then((raw) => unwrapResult(raw) as never);
  }

  sessionRename(sessionId: string, title: string): Promise<{ success?: boolean }> {
    return this.rpc.request("_x.ai/session/rename", { sessionId, title }) as Promise<{ success?: boolean }>;
  }

  terminalCreate(
    sessionId: string,
    command: string,
    options: { cwd?: string; excludeFromContext?: boolean } = {},
  ): Promise<{ terminalId: string }> {
    return this.rpc.request("_x.ai/terminal/create", {
      sessionId,
      command,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.excludeFromContext ? { excludeFromContext: true } : {}),
    }).then((raw) => unwrapResult(raw) as never);
  }

  terminalWaitForExit(sessionId: string, terminalId: string): Promise<{ exitCode?: number }> {
    return this.rpc.request("_x.ai/terminal/wait_for_exit", { sessionId, terminalId })
      .then((raw) => unwrapResult(raw) as never);
  }

  terminalOutput(sessionId: string, terminalId: string): Promise<{
    output?: string;
    truncated?: boolean;
    exitStatus?: { exitCode?: number };
  }> {
    return this.rpc.request("_x.ai/terminal/output", { sessionId, terminalId })
      .then((raw) => unwrapResult(raw) as never);
  }

  async searchFuzzy(cwd: string, query: string): Promise<Array<{ path: string; type?: string; name?: string }>> {
    const opened = await this.rpc.request("_x.ai/search/fuzzy/open", { cwd }).then((raw) => unwrapResult(raw) as {
      searchId?: string;
    });
    const searchId = opened.searchId;
    if (!searchId) throw new Error("fuzzy search did not return a searchId");
    const matches = new Promise<Array<{ path: string; type?: string; name?: string }>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fuzzyWaiters.delete(searchId);
        reject(new Error("fuzzy search timed out"));
      }, 3_000);
      this.fuzzyWaiters.set(searchId, (found) => {
        clearTimeout(timer);
        resolve(found);
      });
    });
    await this.rpc.request("_x.ai/search/fuzzy/change", { searchId, query }).then(unwrapResult);
    return matches;
  }

  terminalKill(sessionId: string, terminalId: string): Promise<{ outcome?: string }> {
    return this.rpc.request("_x.ai/terminal/kill", { sessionId, terminalId })
      .then((raw) => unwrapResult(raw) as never);
  }

  feedback(sessionId: string, text: string): Promise<{ success?: boolean }> {
    const feedback_text = text.trim();
    if (!feedback_text) throw new Error("feedback_text is required");
    return this.rpc.request("_x.ai/feedback", { session_id: sessionId, feedback_text }) as Promise<{ success?: boolean }>;
  }

  recap(sessionId: string): Promise<{ ok?: boolean; text?: string }> {
    return this.rpc.request("_x.ai/recap", { sessionId }).then((raw) => unwrapResult(raw) as never);
  }

  promptHistory(cwd: string): Promise<{ prompts: string[] }> {
    return this.rpc.request("_x.ai/prompt_history", { cwd }) as Promise<{ prompts: string[] }>;
  }

  compactConversation(sessionId: string, customInstructions?: string): Promise<{
    tokensBefore?: number;
    estimatedTokensAfter?: number;
  }> {
    return this.rpc.request("_x.ai/compact_conversation", {
      session_id: sessionId,
      ...(customInstructions ? { custom_instructions: customInstructions } : {}),
    }).then((raw) => unwrapResult(raw) as never);
  }

  onSessionUpdate(handler: (sessionId: string, update: unknown) => void): () => void {
    return this.rpc.onNotification((method, params) => {
      if (method !== "session/update" || !isRecord(params) || typeof params.sessionId !== "string") {
        return;
      }
      const commands = readAvailableCommands({ update: params.update });
      if (commands.length > 0) this.availableCommands = commands;
      handler(params.sessionId, params.update);
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validSessionId(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.sessionId !== "string") return undefined;
  return value.sessionId.length > 0 && value.sessionId.trim() === value.sessionId
    ? value.sessionId
    : undefined;
}

function permissionKey(sessionId: string, requestId: string): string {
  return JSON.stringify([sessionId, requestId]);
}

function readAvailableCommands(value: unknown): Array<{ name: string; description?: string }> {
  const record = isRecord(value) ? value : {};
  const meta = isRecord(record._meta) ? record._meta : {};
  const update = isRecord(record.update) ? record.update : {};
  const raw = Array.isArray(meta.availableCommands)
    ? meta.availableCommands
    : update.sessionUpdate === "available_commands_update" && Array.isArray(update.availableCommands)
      ? update.availableCommands
      : [];
  return raw.flatMap((item) => {
    if (!isRecord(item) || typeof item.name !== "string" || !item.name) return [];
    return [{
      name: item.name,
      ...(typeof item.description === "string" ? { description: item.description } : {}),
    }];
  });
}

function unwrapResult(value: unknown): unknown {
  if (value && typeof value === "object" && "result" in value) {
    return (value as { result: unknown }).result;
  }
  return value;
}
