import { JsonRpcConn } from "./jsonrpc.ts";
import {
  resolvePermission,
  translatePermissionRequest,
  type PermissionUiRequest,
} from "./permissions.ts";

export class AcpConnection {
  private readonly rpc: JsonRpcConn;
  private readonly pendingPermissions = new Map<string, unknown>();
  private readonly permissionHandlers = new Set<(event: PermissionUiRequest) => void>();

  constructor(rpc: JsonRpcConn) {
    this.rpc = rpc;
    this.rpc.onNotification((method, params, id) => {
      if (method !== "session/request_permission" || typeof id !== "number") return;
      const key = String(id);
      this.pendingPermissions.set(key, params);
      const event = translatePermissionRequest(params, id);
      for (const handler of this.permissionHandlers) handler(event);
    });
  }

  onPermission(handler: (event: PermissionUiRequest) => void): () => void {
    this.permissionHandlers.add(handler);
    return () => {
      this.permissionHandlers.delete(handler);
    };
  }

  completePermission(id: string, ui: { confirmed?: boolean; cancelled?: boolean }): void {
    const request = this.pendingPermissions.get(id);
    this.pendingPermissions.delete(id);
    this.rpc.respond(Number(id), resolvePermission(ui, request));
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
