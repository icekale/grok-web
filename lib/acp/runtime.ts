import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readPermissionMode, sessionNewMeta } from "../grok-settings/home-config.ts";
import { mapUpdatesJsonl } from "../history-map.ts";
import { findGrokSession } from "../session-index.ts";
import { invalidateSessionListCache } from "../session-reader.ts";
import { AcpConnection } from "./connection.ts";
import { JsonRpcConn } from "./jsonrpc.ts";
import { AcpTurnMapper } from "./map-events.ts";
import { mapGrokModels } from "./models.ts";
import type { PermissionUiRequest } from "./permissions.ts";
import { grokAgentArgs, resolveGrokBin } from "./process.ts";
import { SessionQueue, type QueueSnapshot } from "./queue.ts";
import { promptIndexForEntry, resolveSessionEntries } from "./rewind-map.ts";

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
  modelId?: string;
  thinkingLevel?: string;
  hasUserPrompt?: boolean;
};

export class AgentRuntime {
  private readonly connectFn: () => Promise<AcpConnection>;
  private readonly resolveEntries: typeof resolveSessionEntries;
  private acp: AcpConnection | undefined;
  private starting: Promise<void> | undefined;
  private unsubUpdate: (() => void) | undefined;
  private unsubPermission: (() => void) | undefined;
  private lastPermissionSessionId: string | undefined;
  private child: ChildProcess | undefined;
  private readonly sessions = new Map<string, SessionState>();

  constructor(options?: {
    connect?: () => Promise<AcpConnection>;
    resolveEntries?: typeof resolveSessionEntries;
  }) {
    this.connectFn = options?.connect ?? (() => this.connectDefault());
    this.resolveEntries = options?.resolveEntries ?? resolveSessionEntries;
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
    const { sessionId } = await this.requireAcp().sessionNew(
      cwd,
      sessionNewMeta(readPermissionMode()),
    );
    const session = this.ensureSession(sessionId);
    session.cwd = cwd;
    session.modelId = "grok-4.6";
    session.thinkingLevel = "off";
    return sessionId;
  }

  async loadSession(sessionId: string, cwd?: string): Promise<void> {
    await this.ensureProcess();
    await this.requireAcp().sessionLoad(sessionId, cwd);
    this.ensureSession(sessionId).cwd = cwd;
  }

  async listModels() {
    await this.ensureProcess();
    return mapGrokModels(await this.requireAcp().modelsList());
  }

  async fsWrite(path: string, content: string): Promise<void> {
    await this.ensureProcess();
    await this.requireAcp().fsWrite(path, content);
  }

  async gitStatus(): Promise<unknown> {
    await this.ensureProcess();
    return this.requireAcp().gitStatus();
  }

  async authCheck() {
    await this.ensureProcess();
    return this.requireAcp().authCheck();
  }

  async authGetUrl() {
    await this.ensureProcess();
    return this.requireAcp().authGetUrl();
  }

  async authSubmitCode(code: string) {
    await this.ensureProcess();
    return this.requireAcp().authSubmitCode(code);
  }

  async authCancel() {
    await this.ensureProcess();
    return this.requireAcp().authCancel();
  }

  async authLogout() {
    await this.ensureProcess();
    return this.requireAcp().authLogout();
  }

  async authenticate(methodId: string) {
    await this.ensureProcess();
    return this.requireAcp().authenticate(methodId);
  }

  async listMcp() {
    await this.ensureProcess();
    return this.requireAcp().mcpList();
  }

  async withSession(cwd: string, fn: (sessionId: string) => Promise<unknown>) {
    await this.ensureProcess();
    const existing = [...this.sessions.keys()][0];
    const sessionId = existing ?? await this.createSession(cwd);
    return fn(sessionId);
  }

  async toggleMcp(cwd: string, name: string, enabled: boolean) {
    return this.withSession(cwd, (sessionId) => this.requireAcp().mcpToggle(sessionId, name, enabled));
  }

  async upsertMcp(cwd: string, name: string, transport: { command?: string; url?: string; args?: string[] }) {
    return this.withSession(cwd, (sessionId) => this.requireAcp().mcpUpsert(sessionId, name, transport));
  }

  async deleteMcp(cwd: string, name: string) {
    return this.withSession(cwd, (sessionId) => this.requireAcp().mcpDelete(sessionId, name));
  }

  async listSkills(cwd: string) {
    await this.ensureProcess();
    return this.requireAcp().skillsList(cwd);
  }

  async toggleSkill(name: string, enabled: boolean) {
    await this.ensureProcess();
    return this.requireAcp().skillsToggle(name, enabled);
  }

  async worktreeCreate(sessionId: string, sourcePath: string): Promise<{ worktreePath?: string; status?: string }> {
    await this.ensureProcess();
    return this.requireAcp().worktreeCreate(sessionId, sourcePath);
  }

  async worktreeRemove(worktreePath: string): Promise<unknown> {
    await this.ensureProcess();
    return this.requireAcp().worktreeRemove(worktreePath);
  }

  async listRunningSubagents(sessionId: string) {
    await this.ensureProcess();
    return this.requireAcp().subagentListRunning(sessionId);
  }

  async cancelSubagent(subagentId: string) {
    await this.ensureProcess();
    return this.requireAcp().subagentCancel(subagentId);
  }

  async send(sessionId: string, command: AgentCommand): Promise<unknown> {
    switch (command.type) {
      case "get_state":
        return this.getState(sessionId);
      case "prompt":
        rejectUnsupportedImages(commandImages(command));
        return this.sendPrompt(sessionId, stringField(command.message), promptBehavior(command));
      case "steer":
        rejectUnsupportedImages(commandImages(command));
        return this.sendPrompt(sessionId, stringField(command.message), "steer");
      case "follow_up":
        rejectUnsupportedImages(commandImages(command));
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
        let last: unknown = session.queue.snapshot();
        for (const item of items) {
          if (this.isBusy(sessionId)) {
            await this.ensureProcess();
            last = await this.requireAcp().sessionInterject(sessionId, item);
          } else {
            last = await this.sendPrompt(sessionId, item);
          }
        }
        return last;
      }
      case "extension_ui_response":
        return this.sendPermission(command);
      case "set_session_name": {
        const name = stringField(command.name).trim();
        if (!name) throw new Error("Session name cannot be empty");
        await this.ensureProcess();
        return this.requireAcp().sessionRename(sessionId, name);
      }
      case "compact": {
        if (!this.ensureSession(sessionId).hasUserPrompt && !(await diskHasUserMessages(sessionId))) {
          throw new Error("Nothing to compact");
        }
        await this.ensureProcess();
        const instructions = typeof command.customInstructions === "string" ? command.customInstructions : undefined;
        return this.requireAcp().compactConversation(sessionId, instructions);
      }
      case "abort":
        return this.sendAbort(sessionId);
      case "fork":
        return this.sendFork(sessionId, command);
      case "navigate_tree":
        return this.sendNavigateTree(sessionId, command);
      case "set_model": {
        await this.ensureProcess();
        const modelId = stringField(command.modelId);
        if (!modelId) throw new Error("modelId is required");
        const set = await this.requireAcp().sessionSetModel(sessionId, modelId);
        const session = this.ensureSession(sessionId);
        session.modelId = set.modelId;
        return { provider: "grok", id: session.modelId };
      }
      case "set_thinking_level": {
        await this.ensureProcess();
        const level = stringField(command.level);
        if (!level) throw new Error("level is required");
        if (level !== "off") await this.requireAcp().sessionSetMode(sessionId, level);
        this.ensureSession(sessionId).thinkingLevel = level;
        return { level };
      }
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
    model: { provider: "grok"; id: string };
    thinkingLevel: string;
    queuedMessages: QueueSnapshot;
  } {
    const session = this.sessions.get(sessionId);
    const busy = this.isBusy(sessionId);
    return {
      isStreaming: busy,
      isPromptRunning: busy,
      model: { provider: "grok", id: session?.modelId ?? "grok" },
      thinkingLevel: session?.thinkingLevel ?? "off",
      queuedMessages: session?.queue.snapshot() ?? { steering: [], followUp: [] },
    };
  }

  private async sendPrompt(
    sessionId: string,
    message: string,
    streamingBehavior?: "steer" | "followUp",
  ): Promise<unknown> {
    await this.ensureProcess();
    const session = this.ensureSession(sessionId);
    session.hasUserPrompt = true;
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

  private async sendFork(sessionId: string, command: AgentCommand): Promise<{ cancelled: false; newSessionId: string }> {
    await this.ensureProcess();
    const session = this.ensureSession(sessionId);
    const cwd = session.cwd ?? (await findGrokSession(sessionId))?.cwd;
    if (!cwd) throw new Error("Cannot fork without a session cwd");
    const forked = await this.requireAcp().sessionFork({
      sourceSessionId: sessionId,
      sourceCwd: cwd,
      newCwd: cwd,
    });
    this.ensureSession(forked.newSessionId).cwd = cwd;
    invalidateSessionListCache();
    const entryId = typeof command.entryId === "string" ? command.entryId : "";
    if (entryId) {
      await this.rewindSession(forked.newSessionId, sessionId, entryId);
    }
    return { cancelled: false, newSessionId: forked.newSessionId };
  }

  private async sendNavigateTree(sessionId: string, command: AgentCommand): Promise<{ cancelled: false }> {
    await this.ensureProcess();
    await this.rewindSession(sessionId, sessionId, stringField(command.targetId));
    return { cancelled: false };
  }

  private async rewindSession(targetSessionId: string, sourceSessionId: string, entryId: string): Promise<void> {
    const { messages, entryIds } = await this.resolveEntries(sourceSessionId);
    const index = promptIndexForEntry(entryId, messages, entryIds);
    const rewinded = await this.requireAcp().rewindExecute(targetSessionId, index);
    if (rewinded.success === false) {
      throw new Error(rewinded.error || "Rewind failed");
    }
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

export function peekAgentRuntime(): AgentRuntime | undefined {
  return singleton;
}

export function setAgentRuntime(runtime: AgentRuntime | undefined): void {
  singleton = runtime;
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

function commandImages(command: AgentCommand): unknown {
  return "images" in command ? command.images : undefined;
}

function rejectUnsupportedImages(images: unknown): void {
  if (Array.isArray(images) && images.length > 0) {
    throw new Error("Images are not supported");
  }
}

async function diskHasUserMessages(sessionId: string): Promise<boolean> {
  const found = await findGrokSession(sessionId);
  if (!found) return false;
  if (found.messageCount > 0) return true;
  try {
    const text = await readFile(join(found.path, "updates.jsonl"), "utf8");
    return mapUpdatesJsonl(text).messages.some((message) => (
      message.role === "user" && typeof message.content === "string" && message.content.trim().length > 0
    ));
  } catch {
    return false;
  }
}
