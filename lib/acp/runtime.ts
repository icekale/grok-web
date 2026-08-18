import { spawn, type ChildProcess } from "node:child_process";
import { AcpConnection } from "./connection.ts";
import { JsonRpcConn } from "./jsonrpc.ts";
import { AcpTurnMapper } from "./map-events.ts";
import type { PermissionUiRequest } from "./permissions.ts";
import { grokAgentArgs, resolveGrokBin } from "./process.ts";
import { SessionQueue, type QueueSnapshot } from "./queue.ts";

export type AgentCommand =
  | { type: "prompt"; message: string; images?: unknown[]; streamingBehavior?: "steer" | "followUp" }
  | { type: "steer"; message: string }
  | { type: "follow_up"; message: string }
  | { type: "clear_queue" }
  | { type: "get_state" }
  | { type: "extension_ui_response"; id: string; confirmed?: boolean; cancelled?: boolean; value?: string }
  | { type: string; [key: string]: unknown };

type SessionListener = (event: Record<string, unknown>) => void;

type SessionState = {
  mapper: AcpTurnMapper;
  listeners: Set<SessionListener>;
  busy: boolean;
  queue: SessionQueue;
  cwd?: string;
};

export class AgentRuntime {
  private readonly connectFn: () => Promise<AcpConnection>;
  private acp: AcpConnection | undefined;
  private starting: Promise<void> | undefined;
  private unsubUpdate: (() => void) | undefined;
  private unsubPermission: (() => void) | undefined;
  private lastPermissionSessionId: string | undefined;
  private child: ChildProcess | undefined;
  private readonly sessions = new Map<string, SessionState>();

  constructor(options?: { connect?: () => Promise<AcpConnection> }) {
    this.connectFn = options?.connect ?? (() => this.connectDefault());
  }

  async ensureProcess(): Promise<void> {
    if (this.acp) return;
    this.starting ??= this.startProcess();
    try {
      await this.starting;
    } catch (error) {
      this.starting = undefined;
      throw error;
    }
    if (!this.acp) throw new Error("ACP process is not available");
  }

  async createSession(cwd: string): Promise<string> {
    await this.ensureProcess();
    const { sessionId } = await this.requireAcp().sessionNew(cwd);
    this.ensureSession(sessionId).cwd = cwd;
    return sessionId;
  }

  async loadSession(sessionId: string, cwd?: string): Promise<void> {
    await this.ensureProcess();
    await this.requireAcp().sessionLoad(sessionId, cwd);
    this.ensureSession(sessionId).cwd = cwd;
  }

  async send(sessionId: string, command: AgentCommand): Promise<unknown> {
    switch (command.type) {
      case "get_state":
        return this.getState(sessionId);
      case "prompt":
        return this.sendPrompt(sessionId, stringField(command.message), promptBehavior(command));
      case "steer":
        return this.sendPrompt(sessionId, stringField(command.message), "steer");
      case "follow_up":
        return this.sendPrompt(sessionId, stringField(command.message), "followUp");
      case "clear_queue":
        return this.clearQueue(sessionId);
      case "queue_remove":
        return this.mutateQueue(sessionId, () =>
          this.ensureSession(sessionId).queue.remove(kindField(command), stringField(command.text)));
      case "queue_edit":
        return this.mutateQueue(sessionId, () =>
          this.ensureSession(sessionId).queue.edit(kindField(command), stringField(command.text), stringField(command.replacement)));
      case "queue_steer_item": {
        const text = this.ensureSession(sessionId).queue.take(kindField(command), stringField(command.text));
        this.emitQueue(sessionId);
        if (text && this.isBusy(sessionId)) {
          await this.ensureProcess();
          await this.requireAcp().sessionInterject(sessionId, text);
        } else if (text) {
          return this.sendPrompt(sessionId, text);
        }
        return this.ensureSession(sessionId).queue.snapshot();
      }
      case "queue_steer_all": {
        const session = this.ensureSession(sessionId);
        const items = [...session.queue.snapshot().steering, ...session.queue.snapshot().followUp];
        session.queue.clear();
        this.emitQueue(sessionId);
        if (this.isBusy(sessionId)) {
          await this.ensureProcess();
          for (const item of items) await this.requireAcp().sessionInterject(sessionId, item);
        }
        return session.queue.snapshot();
      }
      case "extension_ui_response":
        return this.sendPermission(command);
      case "abort":
        return this.sendAbort(sessionId);
      default:
        throw new Error("not implemented in this phase: " + command.type);
    }
  }

  subscribe(sessionId: string, listener: SessionListener): () => void {
    this.ensureSession(sessionId).listeners.add(listener);
    return () => {
      this.sessions.get(sessionId)?.listeners.delete(listener);
    };
  }

  isBusy(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.busy === true;
  }

  listBusyIds(): string[] {
    const ids: string[] = [];
    for (const [sessionId, session] of this.sessions) {
      if (session.busy) ids.push(sessionId);
    }
    return ids;
  }

  private getState(sessionId: string): {
    isStreaming: boolean;
    isPromptRunning: boolean;
    model: { provider: "grok"; id: "grok" };
    thinkingLevel: "off";
    queuedMessages: QueueSnapshot;
  } {
    const busy = this.isBusy(sessionId);
    return {
      isStreaming: busy,
      isPromptRunning: busy,
      model: { provider: "grok", id: "grok" },
      thinkingLevel: "off",
      queuedMessages: this.sessions.get(sessionId)?.queue.snapshot() ?? { steering: [], followUp: [] },
    };
  }

  private async sendPrompt(
    sessionId: string,
    message: string,
    streamingBehavior?: "steer" | "followUp",
  ): Promise<unknown> {
    await this.ensureProcess();
    const session = this.ensureSession(sessionId);
    if (session.busy) {
      if (streamingBehavior === "steer") {
        return this.requireAcp().sessionInterject(sessionId, message);
      }
      const snap = session.queue.enqueue("followUp", message);
      this.emit(sessionId, [{ type: "queue_update", ...snap }]);
      return snap;
    }
    return this.runPrompt(sessionId, message);
  }

  private async runPrompt(sessionId: string, message: string): Promise<unknown> {
    const session = this.ensureSession(sessionId);
    session.busy = true;
    session.mapper.begin();
    try {
      const result = await this.requireAcp().sessionPrompt(sessionId, message);
      this.emit(sessionId, session.mapper.endTurn());
      const stopReason = result && typeof result === "object" && "stopReason" in result
        && typeof (result as { stopReason?: unknown }).stopReason === "string"
        ? (result as { stopReason: string }).stopReason
        : "";
      if (stopReason !== "cancelled") {
        const next = session.queue.takeNext("followUp");
        if (next !== undefined) {
          this.emit(sessionId, [{ type: "queue_update", ...session.queue.snapshot() }]);
          return await this.runPrompt(sessionId, next);
        }
      }
      return result;
    } finally {
      session.busy = false;
    }
  }

  private clearQueue(sessionId: string): QueueSnapshot {
    const session = this.ensureSession(sessionId);
    const snap = session.queue.clear();
    this.emitQueue(sessionId);
    return snap;
  }

  private mutateQueue(sessionId: string, fn: () => void): QueueSnapshot {
    fn();
    this.emitQueue(sessionId);
    return this.ensureSession(sessionId).queue.snapshot();
  }

  private emitQueue(sessionId: string): void {
    this.emit(sessionId, [{ type: "queue_update", ...this.ensureSession(sessionId).queue.snapshot() }]);
  }

  private async sendPermission(command: AgentCommand): Promise<void> {
    await this.ensureProcess();
    this.requireAcp().completePermission(stringField(command.id), {
      confirmed: command.confirmed === true,
      cancelled: command.cancelled === true,
    });
  }

  private async sendAbort(sessionId: string): Promise<unknown> {
    await this.ensureProcess();
    this.requireAcp().sessionCancel(sessionId);
    return null;
  }

  private async startProcess(): Promise<void> {
    const acp = await this.connectFn();
    try {
      await acp.initialize();
    } catch (error) {
      this.child?.kill();
      this.child = undefined;
      throw error;
    }
    this.unsubUpdate?.();
    this.unsubPermission?.();
    this.unsubUpdate = acp.onSessionUpdate((sessionId, update) => {
      const session = this.sessions.get(sessionId);
      if (!session) return;
      this.emit(sessionId, session.mapper.push(update));
    });
    this.unsubPermission = acp.onPermission((event) => {
      this.forwardPermission(event);
    });
    this.acp = acp;
  }

  private async connectDefault(): Promise<AcpConnection> {
    const bin = resolveGrokBin();
    const child = spawn(bin, grokAgentArgs(), { stdio: ["pipe", "pipe", "inherit"] });
    if (!child.stdin || !child.stdout) {
      child.kill();
      throw new Error("failed to open grok stdio");
    }
    this.child = child;
    child.once("exit", () => {
      if (this.child !== child) return;
      this.child = undefined;
      this.dropConnection();
    });
    return new AcpConnection(new JsonRpcConn({ stdin: child.stdin, stdout: child.stdout }));
  }

  private dropConnection(): void {
    this.unsubUpdate?.();
    this.unsubPermission?.();
    this.unsubUpdate = undefined;
    this.unsubPermission = undefined;
    this.lastPermissionSessionId = undefined;
    this.acp = undefined;
    this.starting = undefined;
  }

  private forwardPermission(event: PermissionUiRequest & { sessionId?: string }): void {
    if (typeof event.sessionId === "string" && event.sessionId) {
      this.lastPermissionSessionId = event.sessionId;
    }
    const sessionId = typeof event.sessionId === "string" && event.sessionId
      ? event.sessionId
      : this.lastPermissionSessionId;
    if (sessionId) {
      this.emit(sessionId, [event]);
      return;
    }
    const targets = this.listBusyIds().length > 0 ? this.listBusyIds() : [...this.sessions.keys()];
    for (const id of targets) this.emit(id, [{ ...event, sessionId: id }]);
  }

  private ensureSession(sessionId: string): SessionState {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { mapper: new AcpTurnMapper(), listeners: new Set(), busy: false, queue: new SessionQueue() };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  private emit(sessionId: string, events: Array<Record<string, unknown>>): void {
    const session = this.sessions.get(sessionId);
    if (!session || events.length === 0) return;
    for (const event of events) {
      for (const listener of [...session.listeners]) listener(event);
    }
  }

  private requireAcp(): AcpConnection {
    if (!this.acp) throw new Error("ACP process is not available");
    return this.acp;
  }
}

let singleton: AgentRuntime | undefined;

export function getAgentRuntime(): AgentRuntime {
  singleton ??= new AgentRuntime();
  return singleton;
}

export function resetAgentRuntime(): void {
  singleton = undefined;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function promptBehavior(command: AgentCommand): "steer" | "followUp" | undefined {
  const behavior = "streamingBehavior" in command ? command.streamingBehavior : undefined;
  return behavior === "steer" || behavior === "followUp" ? behavior : undefined;
}

function kindField(command: AgentCommand): "steering" | "followUp" {
  const kind = "kind" in command ? command.kind : undefined;
  return kind === "steering" || kind === "followUp" ? kind : "followUp";
}
