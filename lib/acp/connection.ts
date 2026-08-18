import { JsonRpcConn } from "./jsonrpc.ts";
import {
  resolvePermission,
  translatePermissionRequest,
  type PermissionUiRequest,
} from "./permissions.ts";

type PendingPermission = {
  request: unknown;
  startedAt: number;
  timer: ReturnType<typeof setTimeout>;
};

export class AcpConnection {
  private readonly rpc: JsonRpcConn;
  private readonly permissionTimeoutMs: number;
  private readonly now: () => number;
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly permissionHandlers = new Set<(event: PermissionUiRequest) => void>();

  constructor(rpc: JsonRpcConn, options: { permissionTimeoutMs?: number; now?: () => number } = {}) {
    this.rpc = rpc;
    this.permissionTimeoutMs = options.permissionTimeoutMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.rpc.onNotification((method, params, id) => {
      if (method !== "session/request_permission" || typeof id !== "number") return;
      const key = String(id);
      const existing = this.pendingPermissions.get(key);
      if (existing) clearTimeout(existing.timer);
      const startedAt = this.now();
      const timer = setTimeout(() => this.expirePermission(key), this.permissionTimeoutMs);
      this.pendingPermissions.set(key, { request: params, startedAt, timer });
      const event = translatePermissionRequest(params, id);
      const sessionId = isRecord(params) && typeof params.sessionId === "string" ? params.sessionId : undefined;
      const uiRequest = sessionId ? { ...event, sessionId } : event;
      for (const handler of this.permissionHandlers) handler(uiRequest);
    });
  }

  onPermission(handler: (event: PermissionUiRequest) => void): () => void {
    this.permissionHandlers.add(handler);
    return () => {
      this.permissionHandlers.delete(handler);
    };
  }

  completePermission(id: string, ui: { confirmed?: boolean; cancelled?: boolean }): void {
    const pending = this.pendingPermissions.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingPermissions.delete(id);
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
    this.rpc.respond(Number(id), resolvePermission({ cancelled: true }, pending.request, {
      startedAt: pending.startedAt,
      now: this.now(),
      timeoutMs: this.permissionTimeoutMs,
    }));
  }

  initialize(): Promise<unknown> {
    return this.rpc.request("initialize", { protocolVersion: 1 });
  }

  sessionNew(cwd: string): Promise<{ sessionId: string }> {
    return this.rpc.request("session/new", {
      cwd,
      mcpServers: [],
      _meta: {},
    }) as Promise<{ sessionId: string }>;
  }

  sessionLoad(sessionId: string, cwd?: string): Promise<{ sessionId: string }> {
    return this.rpc.request("session/load", { sessionId, cwd }) as Promise<{ sessionId: string }>;
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

  onSessionUpdate(handler: (sessionId: string, update: unknown) => void): () => void {
    return this.rpc.onNotification((method, params) => {
      if (method !== "session/update" || !isRecord(params) || typeof params.sessionId !== "string") {
        return;
      }
      handler(params.sessionId, params.update);
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
