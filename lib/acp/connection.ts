import { JsonRpcConn } from "./jsonrpc.ts";

export class AcpConnection {
  private readonly rpc: JsonRpcConn;

  constructor(rpc: JsonRpcConn) {
    this.rpc = rpc;
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
