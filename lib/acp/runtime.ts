import { spawn, type ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { grokHome } from "../grok-home.ts";
import { discoverGrokCapabilities } from "../grok-capabilities.ts";
import { readRuntimeProfile, validateRuntimeProfile, writeRuntimeProfile, type RuntimeProfile } from "../runtime-profile.ts";
import { readPermissionMode, sessionNewMeta } from "../grok-settings/home-config.ts";
import { historyUserText, mapUpdatesJsonl } from "../history-map.ts";
import { findGrokSession } from "../session-index.ts";
import { readContextUsageFromDir, readSessionContextUsage } from "../session-signals.ts";
import { invalidateSessionListCache } from "../session-reader.ts";
import {
  AcpConnection,
  type GrokActionOutcome,
  type GrokMarketplaceAction,
  type GrokPluginInfo,
  type GrokPluginsAction,
} from "./connection.ts";
import { JsonRpcConn } from "./jsonrpc.ts";
import { AcpTurnMapper } from "./map-events.ts";
import { syncSettingsModelsToGrokConfig } from "../grok-model-table.ts";
import { readModelsConfig } from "../models-config-store.ts";
import { defaultGrokEffortLevel, GROK_EFFORT_LEVELS } from "../grok-effort-levels.ts";
import { mapGrokModels, selectedGrokEffort, selectedGrokModelId } from "./models.ts";
import type { PermissionUiRequest } from "./permissions.ts";
import { grokAgentArgs, grokAgentEnv, resolveGrokBin } from "./process.ts";
import { SessionQueue, type QueueSnapshot } from "./queue.ts";
import { promptIndexForEntry, resolveSessionEntries } from "./rewind-map.ts";
import { readAcpModes, type AcpModes } from "./modes.ts";
import {
  advertisedToolPresets,
  applyConfigOptionUpdate,
  hasToolsConfig,
  readAcpConfigOptions,
  rememberToolsPreset,
  selectedToolsPreset,
  toolEntriesForPreset,
  type AcpConfigOption,
} from "./config-options.ts";
import { getPresetFromTools, type ToolEntry, type ToolPreset } from "../tool-presets.ts";
import { validateAgentImages } from "../image-attachments.ts";
import { getPromptGeneration } from "../prompt-generation.ts";

export type AgentCommand =
  | { type: "prompt"; message: string; images?: unknown[]; streamingBehavior?: "steer" | "followUp" }
  | { type: "steer"; message: string }
  | { type: "follow_up"; message: string }
  | { type: "clear_queue" }
  | { type: "get_state" }
  | { type: "extension_ui_response"; id: string; confirmed?: boolean; cancelled?: boolean; value?: string }
  | { type: string; [key: string]: unknown };

function commandField(command: AgentCommand, key: string): unknown {
  return (command as Record<string, unknown>)[key];
}

type SessionListener = (event: Record<string, unknown>) => void;

type SessionState = {
  mapper: AcpTurnMapper;
  loaded: boolean;
  busy: boolean;
  bashStarting: boolean;
  bashTerminalIds: Set<string>;
  queue: SessionQueue;
  cwd?: string;
  modelId?: string;
  thinkingLevel?: string;
  hasUserPrompt?: boolean;
  configOptions: AcpConfigOption[];
  modes: AcpModes;
  eventSequence: number;
  eventPromptGeneration?: number;
  queuedPromptGenerations: Array<number | undefined>;
};

export class AgentCapabilityError extends Error {
  readonly status = 501;
  constructor(message: string) {
    super(message);
    this.name = "AgentCapabilityError";
  }
}

export class AgentCommandError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "AgentCommandError";
    this.status = status;
    this.code = code;
  }
}

function sanitizeRuntimeError(error: unknown): string {
  return String(error instanceof Error ? error.message : error).replace(/(?:[A-Za-z]:\\|\\\\|\/(?!\/))[^\s"'<>]*/g, "<path>").slice(0, 500);
}

function canonicalCwd(cwd: string): string {
  const resolved = resolve(cwd);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (childHasExited(child)) return;
  let exited = false;
  let resolveExit: () => void = () => {};
  const exit = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const onExit = () => {
    exited = true;
    resolveExit();
  };
  child.once("exit", onExit);
  child.once("error", onExit);
  try {
    child.kill("SIGTERM");
  } catch {
    exited = true;
  }
  await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (!exited && !childHasExited(child)) {
    try {
      child.kill("SIGKILL");
    } catch {
      // The child may have exited between the check and escalation.
    }
    await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 1_000))]);
  }
  child.removeListener("exit", onExit);
  child.removeListener("error", onExit);
}

function extraAcpReadRoots(): string[] {
  return [join(homedir(), ".agents"), join(grokHome(), "docs"), join(grokHome(), "skills")].map(canonicalCwd);
}

export class AgentRuntime {
  private readonly connectFn: () => Promise<AcpConnection>;
  private readonly resolveEntries: typeof resolveSessionEntries;
  private acp: AcpConnection | undefined;
  private connectionGeneration = 0;
  private startupToken = 0;
  private starting: Promise<void> | undefined;
  private unsubUpdate: (() => void) | undefined;
  private unsubPermission: (() => void) | undefined;
  private unsubPermissionResolved: (() => void) | undefined;
  private unsubClose: (() => void) | undefined;
  private child: ChildProcess | undefined;
  private readonly connectionChildren = new WeakMap<AcpConnection, ChildProcess>();
  private readonly sessions = new Map<string, SessionState>();
  private readonly listeners = new Map<string, Set<SessionListener>>();
  private readonly sequencedListeners = new Map<string, Set<(entry: { sequence: number; event: Record<string, unknown>; promptGeneration?: number }) => void>>();
  private readonly workspaceSessionStarts = new Map<string, Promise<string>>();
  private profileApplyChain: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(options?: {
    connect?: () => Promise<AcpConnection>;
    resolveEntries?: typeof resolveSessionEntries;
  }) {
    this.connectFn = options?.connect ?? (() => this.connectDefault());
    this.resolveEntries = options?.resolveEntries ?? resolveSessionEntries;
  }

  async ensureProcess(): Promise<void> {
    if (this.disposed) throw new Error("Agent runtime is disposed");
    if (this.acp) return;
    const starting = this.starting ??= this.startProcess();
    try {
      await starting;
    } catch (error) {
      if (this.starting === starting) this.starting = undefined;
      throw error;
    }
    if (!this.acp) throw new Error("ACP process is not available");
  }

  async createSession(cwd: string): Promise<string> {
    const canonical = canonicalCwd(cwd);
    await this.ensureProcess();
    const connection = this.captureConnection();
    const created = await connection.acp.sessionNew(
      canonical,
      sessionNewMeta(readPermissionMode()),
    );
    this.assertCurrentConnection(connection, "session/new");
    const session = this.ensureSession(created.sessionId);
    session.loaded = true;
    session.cwd = canonical;
    session.modelId = selectedGrokModelId(created) ?? "grok-4.6";
    session.thinkingLevel = selectedGrokEffort(created) ?? defaultGrokEffortLevel([...GROK_EFFORT_LEVELS]);
    session.configOptions = readAcpConfigOptions(created);
    session.modes = readAcpModes(created);
    return created.sessionId;
  }

  async loadSession(sessionId: string, cwd?: string): Promise<void> {
    const canonical = cwd ? canonicalCwd(cwd) : undefined;
    await this.ensureProcess();
    const connection = this.captureConnection();
    const loaded = await connection.acp.sessionLoad(
      sessionId,
      canonical,
      sessionNewMeta(readPermissionMode()),
    );
    this.assertCurrentConnection(connection, "session/load");
    const session = this.ensureSession(sessionId);
    session.loaded = true;
    session.cwd = canonical;
    const modelId = selectedGrokModelId(loaded);
    if (modelId) session.modelId = modelId;
    const effort = selectedGrokEffort(loaded);
    if (effort) session.thinkingLevel = effort;
    const options = readAcpConfigOptions(loaded);
    if (options.length > 0) session.configOptions = options;
    session.modes = readAcpModes(loaded);
  }

  async resumeSession(sessionId: string, cwd?: string): Promise<void> {
    await this.ensureProcess();
    const directory = cwd ? canonicalCwd(cwd) : this.ensureSession(sessionId).cwd || canonicalCwd(process.cwd());
    const connection = this.captureConnection();
    await connection.acp.sessionResume(sessionId, directory);
    this.assertCurrentConnection(connection, "session/resume");
    const session = this.ensureSession(sessionId);
    session.loaded = true;
    session.cwd = directory;
  }

  async listModels() {
    await this.ensureProcess();
    return mapGrokModels(await this.requireAcp().modelsList());
  }

  async recycleProcess(): Promise<void> {
    const child = this.child;
    this.sessions.clear();
    this.listeners.clear();
    this.sequencedListeners.clear();
    this.dropConnection();
    if (child && !child.killed) child.kill();
    this.child = undefined;
    await this.ensureProcess();
  }

  async applyRuntimeProfile(next: RuntimeProfile, store: { read: () => RuntimeProfile; write: (profile: RuntimeProfile) => void } = {
    read: () => readRuntimeProfile(),
    write: (profile) => { writeRuntimeProfile(profile); },
  }): Promise<{ status: "applied" | "degraded"; profile?: RuntimeProfile; error?: string; rollbackError?: string }> {
    const operation = this.profileApplyChain.then(async () => {
      const candidate = validateRuntimeProfile(next);
      if (this.listBusyIds().length > 0) throw new AgentCommandError(409, "runtime_busy", "Grok is busy");
      const previous = store.read();
      const recoverable = [...this.sessions.values()]
        .filter((session) => session.loaded && session.cwd)
        .map((session) => ({ id: [...this.sessions.entries()].find(([, value]) => value === session)?.[0], cwd: session.cwd }))
        .filter((entry): entry is { id: string; cwd: string } => Boolean(entry.id && entry.cwd));
      const listeners = new Map([...this.listeners].map(([id, set]) => [id, new Set(set)] as const));
      const sequencedListeners = new Map([...this.sequencedListeners].map(([id, set]) => [id, new Set(set)] as const));
      const restoreListeners = () => {
        for (const [id, set] of listeners) this.listeners.set(id, set);
        for (const [id, set] of sequencedListeners) this.sequencedListeners.set(id, set);
      };
      store.write(candidate);
      try {
        await this.recycleProcess();
        restoreListeners();
        for (const entry of recoverable) await this.loadSession(entry.id, entry.cwd);
        return { status: "applied" as const, profile: candidate };
      } catch (candidateError) {
        store.write(previous);
        try {
          await this.recycleProcess();
          restoreListeners();
          for (const entry of recoverable) await this.loadSession(entry.id, entry.cwd);
        } catch (rollbackError) {
          return { status: "degraded" as const, error: sanitizeRuntimeError(candidateError), rollbackError: sanitizeRuntimeError(rollbackError) };
        }
        throw new AgentCommandError(503, "runtime_start_failed", sanitizeRuntimeError(candidateError));
      }
    });
    this.profileApplyChain = operation.catch(() => undefined);
    return operation;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.startupToken += 1;
    const startup = this.starting;
    const acp = this.acp;
    const child = this.child;
    if (acp) {
      for (const [sessionId, session] of this.sessions) {
        if (this.isSessionBashRunning(session)) {
          try {
            await this.killBashTerminals(sessionId);
          } catch {
            // Shutdown must continue even when a terminal has already vanished.
          }
        }
        if (session.busy) {
          try {
            acp.sessionCancel(sessionId);
          } catch {
            // The transport may already be closing.
          }
        }
      }
    }
    this.dropConnection();
    try {
      acp?.close();
    } catch {
      // Shutdown is best effort after state has been detached.
    }
    if (child) await terminateChild(child);
    if (startup) {
      await Promise.race([
        startup.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ]);
    }
    this.child = undefined;
    this.sessions.clear();
    this.listeners.clear();
    this.sequencedListeners.clear();
    this.starting = undefined;
  }

  async fsWrite(path: string, content: string): Promise<void> {
    await this.ensureProcess();
    await this.requireAcp().fsWrite(path, content);
  }

  async gitStatus(): Promise<unknown> {
    await this.ensureProcess();
    return this.requireAcp().gitStatus();
  }

  async gitDiffs(paths: string[], includePatch = false) {
    await this.ensureProcess();
    return this.requireAcp().gitDiffs(paths, includePatch);
  }

  async gitStage(paths: string[]) {
    await this.ensureProcess();
    return this.requireAcp().gitStage(paths);
  }

  async gitDiscard(paths: string[]) {
    await this.ensureProcess();
    return this.requireAcp().gitDiscard(paths);
  }

  async gitCommit(message: string) {
    await this.ensureProcess();
    return this.requireAcp().gitCommit(message);
  }

  async searchFuzzy(cwd: string, query: string) {
    await this.ensureProcess();
    return this.requireAcp().searchFuzzy(cwd, query);
  }

  async closeSession(sessionId: string) {
    await this.ensureProcess();
    return this.requireAcp().sessionClose(sessionId);
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

  async listMcp(cwd: string) {
    return this.withWorkspaceSession(cwd, (sessionId) => this.requireAcp().mcpList(sessionId)) as Promise<{
      servers: Array<{
        name: string;
        source?: string;
        type?: string;
        command?: string;
        url?: string;
        session?: { enabled?: boolean };
      }>;
    }>;
  }

  private async workspaceSession(cwd: string): Promise<string> {
    const canonical = canonicalCwd(cwd);
    await this.ensureProcess();
    const loaded = [...this.sessions].find(([, session]) => (
      session.loaded && session.cwd && canonicalCwd(session.cwd) === canonical
    ));
    if (loaded) return loaded[0];
    const current = this.workspaceSessionStarts.get(canonical);
    if (current) return current;
    const start = this.createSession(canonical);
    this.workspaceSessionStarts.set(canonical, start);
    try {
      return await start;
    } finally {
      if (this.workspaceSessionStarts.get(canonical) === start) this.workspaceSessionStarts.delete(canonical);
    }
  }

  async withWorkspaceSession(cwd: string, fn: (sessionId: string) => Promise<unknown>) {
    return fn(await this.workspaceSession(cwd));
  }

  async toggleMcp(cwd: string, name: string, enabled: boolean) {
    return this.withWorkspaceSession(cwd, (sessionId) => this.requireAcp().mcpToggle(sessionId, name, enabled));
  }

  async upsertMcp(cwd: string, name: string, transport: { command?: string; url?: string; args?: string[] }) {
    return this.withWorkspaceSession(cwd, (sessionId) => this.requireAcp().mcpUpsert(sessionId, name, transport));
  }

  async deleteMcp(cwd: string, name: string) {
    return this.withWorkspaceSession(cwd, (sessionId) => this.requireAcp().mcpDelete(sessionId, name));
  }

  async listPlugins(cwd: string) {
    return this.withWorkspaceSession(cwd, (sessionId) => this.requireAcp().pluginsList(sessionId)) as Promise<{
      plugins: GrokPluginInfo[];
    }>;
  }

  async pluginsAction(cwd: string, action: GrokPluginsAction) {
    return this.withWorkspaceSession(cwd, (sessionId) => this.requireAcp().pluginsAction(sessionId, action)) as Promise<GrokActionOutcome>;
  }

  async listMarketplace(cwd: string) {
    return this.withWorkspaceSession(cwd, (sessionId) => this.requireAcp().marketplaceList(sessionId));
  }

  async marketplaceAction(cwd: string, action: GrokMarketplaceAction) {
    return this.withWorkspaceSession(cwd, (sessionId) => this.requireAcp().marketplaceAction(sessionId, action)) as Promise<GrokActionOutcome>;
  }

  async listSkills(cwd: string) {
    await this.ensureProcess();
    return this.requireAcp().skillsList(cwd);
  }

  async toggleSkill(name: string, enabled: boolean) {
    await this.ensureProcess();
    return this.requireAcp().skillsToggle(name, enabled);
  }

  async worktreeList(): Promise<unknown> {
    await this.ensureProcess();
    return this.requireAcp().worktreeList();
  }

  async worktreeCreate(sessionId: string, sourcePath: string): Promise<{ worktreePath?: string; status?: string }> {
    await this.ensureProcess();
    return this.requireAcp().worktreeCreate(sessionId, sourcePath);
  }

  async forkSessionIntoCwd(sourceSessionId: string, sourceCwd: string, newCwd: string): Promise<{ newSessionId: string }> {
    await this.ensureProcess();
    const result = await this.requireAcp().sessionFork({ sourceSessionId, sourceCwd, newCwd });
    const session = this.ensureSession(result.newSessionId);
    session.loaded = true;
    session.cwd = canonicalCwd(newCwd);
    return result;
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
      case "prompt": {
        await this.ensureProcess();
        const generation = commandField(command, "promptGeneration");
        const behavior = promptBehavior(command);
        const session = this.ensureSession(sessionId);
        return this.sendPrompt(
          sessionId,
          stringField(command.message),
          behavior,
          commandImages(command),
          typeof generation === "number" ? generation : undefined,
          true,
        );
      }
      case "steer":
        return this.sendPrompt(sessionId, stringField(command.message), "steer", commandImages(command));
      case "follow_up":
        return this.sendPrompt(sessionId, stringField(command.message), "followUp", commandImages(command));
      case "clear_queue":
        return this.clearQueue(sessionId);
      case "queue_remove": {
        const session = this.ensureSession(sessionId);
        const kind = kindField(command);
        const text = stringField(command.text);
        const index = kind === "followUp" ? session.queue.snapshot().followUp.indexOf(text) : -1;
        session.queue.remove(kind, text);
        if (index >= 0) session.queuedPromptGenerations.splice(index, 1);
        this.emitQueue(sessionId);
        return session.queue.snapshot();
      }
      case "queue_edit":
        return this.mutateQueue(sessionId, () =>
          this.ensureSession(sessionId).queue.edit(kindField(command), stringField(command.text), stringField(command.replacement)));
      case "queue_steer_item": {
        const session = this.ensureSession(sessionId);
        const kind = kindField(command);
        const textValue = stringField(command.text);
        const index = kind === "followUp" ? session.queue.snapshot().followUp.indexOf(textValue) : -1;
        const text = session.queue.take(kind, textValue);
        if (index >= 0) session.queuedPromptGenerations.splice(index, 1);
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
        session.queuedPromptGenerations = [];
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
        return this.sendPermission(sessionId, command);
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
      case "get_tools":
        return this.getTools(sessionId);
      case "set_tools":
        return this.setTools(sessionId, command);
      case "abort_compaction":
        return this.sendAbort(sessionId);
      case "get_last_assistant_text":
        return this.lastAssistantText(sessionId);
      case "get_session_stats":
        return this.sessionStats(sessionId);
      case "abort":
        return this.sendAbort(sessionId);
      case "fork":
        return this.sendFork(sessionId, command);
      case "navigate_tree":
        return this.sendNavigateTree(sessionId, command);
      case "set_model": {
        const modelId = stringField(command.modelId);
        if (!modelId) throw new Error("modelId is required");
        const wrote = syncSettingsModelsToGrokConfig(readModelsConfig());
        const cwd = this.sessions.get(sessionId)?.cwd;
        let listed = await this.listModels();
        const known = listed.modelList.some((model) => model.id === modelId);
        if (wrote.length > 0 || (!known && modelId.includes("/"))) {
          await this.recycleProcess();
          if (cwd) await this.loadSession(sessionId, cwd);
          listed = await this.listModels();
        }
        if (!listed.modelList.some((model) => model.id === modelId)) {
          throw new Error(`Unknown model: ${modelId}`);
        }
        const set = await this.requireAcp().sessionSetModel(sessionId, modelId);
        const session = this.ensureSession(sessionId);
        session.modelId = set.modelId;
        return { provider: "grok", id: session.modelId };
      }
      case "set_standard_mode": {
        const modeId = stringField(command.modeId);
        if (!modeId) throw new Error("modeId is required");
        const session = this.ensureSession(sessionId);
        if (session.modes.available.length > 0 && !session.modes.available.some((mode) => mode.id === modeId)) {
          throw new AgentCommandError(400, "mode_unadvertised", "ACP mode is not advertised");
        }
        await this.ensureProcess();
        await this.requireAcp().sessionSetMode(sessionId, modeId);
        session.modes = { ...session.modes, current: modeId };
        return { modeId };
      }
      case "set_thinking_level": {
        await this.ensureProcess();
        const level = stringField(command.level);
        if (!level) throw new Error("level is required");
        const session = this.ensureSession(sessionId);
        const previous = session.thinkingLevel;
        await this.requireAcp().sessionSetMode(sessionId, level);
        session.thinkingLevel = level;
        return { level, previous };
      }
      case "get_commands":
        return this.listSlashCommands(sessionId);
      case "reload": {
        const cwd = this.ensureSession(sessionId).cwd;
        if (cwd) {
          try {
            await this.pluginsAction(cwd, { type: "reload" });
          } catch {
            // Plugin registry rebuild is best-effort; session tools/commands still refresh.
          }
        }
        return { success: true };
      }
      case "bash":
        return this.runBash(sessionId, command);
      case "abort_bash":
        return this.abortBash(sessionId);
      case "extension_ui_input":
        throw new Error("Extension custom UI is not supported");
      case "run_command": {
        const name = stringField(command.name).replace(/^\//, "");
        if (!name) throw new Error("name is required");
        const args = stringField(command.args).trim();
        return this.sendPrompt(sessionId, args ? `/${name} ${args}` : `/${name}`);
      }
      case "feedback": {
        const text = stringField(command.text).trim();
        if (!text) throw new Error("feedback_text is required");
        await this.ensureProcess();
        return this.requireAcp().feedback(sessionId, text);
      }
      case "recap":
        await this.ensureProcess();
        return this.requireAcp().recap(sessionId);
      case "get_prompt_history": {
        await this.ensureProcess();
        const cwd = this.ensureSession(sessionId).cwd || process.cwd();
        return this.requireAcp().promptHistory(cwd);
      }
      default:
        throw new Error("not implemented in this phase: " + command.type);
    }
  }

  subscribe(sessionId: string, listener: SessionListener): () => void {
    let listeners = this.listeners.get(sessionId);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(sessionId, listeners);
    }
    listeners.add(listener);
    return () => {
      const current = this.listeners.get(sessionId);
      current?.delete(listener);
      if (current?.size === 0) this.listeners.delete(sessionId);
    };
  }

  subscribeSequenced(
    sessionId: string,
    listener: (entry: { sequence: number; event: Record<string, unknown>; promptGeneration?: number }) => void,
  ): () => void {
    let listeners = this.sequencedListeners.get(sessionId);
    if (!listeners) {
      listeners = new Set();
      this.sequencedListeners.set(sessionId, listeners);
    }
    listeners.add(listener);
    return () => {
      const current = this.sequencedListeners.get(sessionId);
      current?.delete(listener);
      if (current?.size === 0) this.sequencedListeners.delete(sessionId);
    };
  }

  async getSessionSnapshot(sessionId: string) {
    const session = this.ensureSession(sessionId);
    const state = await this.getState(sessionId);
    return {
      ...state,
      type: "session_snapshot" as const,
      sessionId,
      promptGeneration: getPromptGeneration(sessionId),
      busy: this.isBusy(sessionId),
      streamingMessage: this.getStreamingMessage(sessionId),
      pendingPermissions: this.acp?.pendingPermissionsForSession(sessionId) ?? [],
      eventSequence: session.eventSequence,
    };
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.loaded === true;
  }

  isBusy(sessionId: string): boolean {
    return this.isSessionBusy(this.sessions.get(sessionId));
  }

  getStreamingMessage(sessionId: string): ReturnType<AcpTurnMapper["snapshot"]> {
    if (!this.isBusy(sessionId)) return null;
    return this.sessions.get(sessionId)?.mapper.snapshot() ?? null;
  }

  listBusyIds(): string[] {
    const ids: string[] = [];
    for (const [sessionId, session] of this.sessions) {
      if (this.isSessionBusy(session)) ids.push(sessionId);
    }
    return ids;
  }

  hasBusySessionForCwd(cwd: string): boolean {
    const target = canonicalCwd(cwd);
    for (const session of this.sessions.values()) {
      if (this.isSessionBusy(session) && session.cwd && canonicalCwd(session.cwd) === target) return true;
    }
    return false;
  }

  async dropSessionsForCwd(cwd: string): Promise<number> {
    const target = canonicalCwd(cwd);
    const ids: string[] = [];
    for (const [sessionId, session] of this.sessions) {
      if (session.cwd && canonicalCwd(session.cwd) === target) ids.push(sessionId);
    }
    for (const sessionId of ids) {
      const session = this.sessions.get(sessionId);
      if (this.isSessionBusy(session)) {
        try {
          await this.sendAbort(sessionId);
        } catch {
          // Session is being dropped either way so trust can take effect.
        }
      }
      this.sessions.delete(sessionId);
    }
    return ids.length;
  }

  private async getState(sessionId: string): Promise<{
    isStreaming: boolean;
    isPromptRunning: boolean;
    isBashRunning: boolean;
    model: { provider: "grok"; id: string };
    thinkingLevel: string;
    queuedMessages: QueueSnapshot;
    toolPresets: ToolPreset[];
    modes?: AcpModes;
    contextUsage?: { percent: number | null; contextWindow: number; tokens: number | null };
  }> {
    const session = this.sessions.get(sessionId);
    const promptBusy = session?.busy === true;
    const contextUsage = await readSessionContextUsage(sessionId);
    return {
      isStreaming: promptBusy,
      isPromptRunning: promptBusy,
      isBashRunning: this.isSessionBashRunning(session),
      model: { provider: "grok", id: session?.modelId ?? "grok-4.6" },
      thinkingLevel: session?.thinkingLevel ?? defaultGrokEffortLevel([...GROK_EFFORT_LEVELS]),
      queuedMessages: session?.queue.snapshot() ?? { steering: [], followUp: [] },
      toolPresets: advertisedToolPresets(session?.configOptions ?? []),
      ...(session?.modes.available.length ? { modes: session.modes } : {}),
      ...(contextUsage ? { contextUsage } : {}),
    };
  }

  private async sendPrompt(
    sessionId: string,
    message: string,
    streamingBehavior?: "steer" | "followUp",
    images?: unknown,
    promptGeneration?: number,
    processReady = false,
  ): Promise<unknown> {
    const imageError = validateAgentImages(images);
    if (imageError) throw new Error(imageError);
    if (!processReady) await this.ensureProcess();
    const session = this.ensureSession(sessionId);
    session.hasUserPrompt = true;
    if (this.isSessionBashRunning(session)) {
      throw new Error("Cannot send a prompt while a shell command is running");
    }
    if (session.busy) {
      if (hasPromptImages(images)) {
        throw new Error("Images cannot be sent while a prompt is running");
      }
      if (streamingBehavior === "steer") {
        return this.requireAcp().sessionInterject(sessionId, message);
      }
      const snap = session.queue.enqueue("followUp", message);
      session.queuedPromptGenerations.push(promptGeneration);
      this.emit(sessionId, [{ type: "queue_update", ...snap }]);
      return snap;
    }
    return this.runPrompt(sessionId, message, images, promptGeneration);
  }

  private async runPrompt(
    sessionId: string,
    message: string,
    images?: unknown,
    promptGeneration?: number,
  ): Promise<unknown> {
    const session = this.ensureSession(sessionId);
    const previousPromptGeneration = session.eventPromptGeneration;
    if (promptGeneration !== undefined) session.eventPromptGeneration = promptGeneration;
    session.busy = true;
    session.mapper.begin();
    try {
      const result = await this.requireAcp().sessionPrompt(sessionId, message, Array.isArray(images) ? images : []);
      this.emit(sessionId, session.mapper.endTurn());
      const stopReason = result && typeof result === "object" && "stopReason" in result
        && typeof (result as { stopReason?: unknown }).stopReason === "string"
        ? (result as { stopReason: string }).stopReason
        : "";
      if (stopReason !== "cancelled") {
        const next = session.queue.takeNext("followUp");
        if (next !== undefined) {
          const nextGeneration = session.queuedPromptGenerations.shift();
          this.emit(sessionId, [{ type: "queue_update", ...session.queue.snapshot() }]);
          return await this.runPrompt(sessionId, next, undefined, nextGeneration);
        }
      }
      return result;
    } finally {
      session.eventPromptGeneration = previousPromptGeneration;
      session.busy = false;
    }
  }

  private clearQueue(sessionId: string): QueueSnapshot {
    const session = this.ensureSession(sessionId);
    const snap = session.queue.clear();
    session.queuedPromptGenerations = [];
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

  private async sendPermission(sessionId: string, command: AgentCommand): Promise<void> {
    await this.ensureProcess();
    const result = this.requireAcp().completePermission(sessionId, stringField(commandField(command, "id")), {
      confirmed: commandField(command, "confirmed") === true,
      cancelled: commandField(command, "cancelled") === true,
    });
    if (result.status === "already_resolved") {
      throw new AgentCommandError(409, "already_resolved", "Permission was already resolved");
    }
  }

  private async sendAbort(sessionId: string): Promise<unknown> {
    await this.ensureProcess();
    await this.killBashTerminals(sessionId);
    this.requireAcp().sessionCancel(sessionId);
    return null;
  }

  private async runBash(sessionId: string, command: AgentCommand): Promise<{
    output: string;
    exitCode?: number;
    truncated: boolean;
  }> {
    const script = stringField(commandField(command, "command"));
    if (!script) throw new Error("command is required");
    if (this.isBusy(sessionId)) throw new Error("Cannot run a shell command while the session is busy");
    const session = this.ensureSession(sessionId);
    session.bashStarting = true;
    try {
      await this.ensureProcess();
      const created = await this.requireAcp().terminalCreate(sessionId, script, {
        cwd: session.cwd,
        excludeFromContext: commandField(command, "excludeFromContext") === true,
      });
      session.bashTerminalIds.add(created.terminalId);
      session.bashStarting = false;
      try {
        const waited = await this.requireAcp().terminalWaitForExit(sessionId, created.terminalId);
        const out = await this.requireAcp().terminalOutput(sessionId, created.terminalId);
        return {
          output: typeof out.output === "string" ? out.output : "",
          exitCode: waited.exitCode ?? out.exitStatus?.exitCode,
          truncated: out.truncated === true,
        };
      } catch (error) {
        await this.killBashTerminals(sessionId);
        throw error;
      } finally {
        session.bashTerminalIds.delete(created.terminalId);
      }
    } finally {
      session.bashStarting = false;
    }
  }

  private async abortBash(sessionId: string): Promise<unknown> {
    await this.ensureProcess();
    return this.killBashTerminals(sessionId);
  }

  private async listSlashCommands(sessionId: string) {
    const cwd = this.ensureSession(sessionId).cwd || process.cwd();
    const listed = await this.listSkills(cwd);
    const webBuiltins = new Set(["compact", "reload", "name", "rename", "delete", "export", "session", "copy", "feedback", "recap", "plugins", "marketplace", "skills", "mcp"]);
    const allSkills = listed.skills ?? [];
    const skillNames = new Set(allSkills.map((skill) => skill.name));
    const fromAcp = (this.acp?.availableCommands ?? [])
      .filter((command) => !webBuiltins.has(command.name) && !skillNames.has(command.name))
      .map((command) => ({
        name: command.name,
        description: command.description ?? command.name,
        source: "extension" as const,
      }));
    const fromSkills = allSkills
      .filter((skill) => skill.enabled !== false)
      .map((skill) => ({
        name: skill.name,
        description: skill.description ?? skill.name,
        source: "skill" as const,
        sourceInfo: {
          path: skill.path,
          source: "grok",
          scope: skill.scope === "user" ? "user" as const : "project" as const,
          origin: "top-level" as const,
        },
      }));
    return { commands: [...fromAcp, ...fromSkills] };
  }

  private async lastAssistantText(sessionId: string): Promise<{ text: string }> {
    const found = await findGrokSession(sessionId);
    if (!found) return { text: "" };
    try {
      const text = await readFile(join(found.path, "updates.jsonl"), "utf8");
      const { messages } = mapUpdatesJsonl(text);
      const last = [...messages].reverse().find((message) => message.role === "assistant");
      if (!last || last.role !== "assistant") return { text: "" };
      return {
        text: last.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join(""),
      };
    } catch {
      return { text: "" };
    }
  }

  private async sessionStats(sessionId: string): Promise<{
    sessionId: string;
    sessionName?: string;
    userMessages: number;
    assistantMessages: number;
    toolCalls: number;
    toolResults: number;
    totalMessages: number;
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
    cost: number;
    contextUsage?: { percent: number | null; contextWindow: number; tokens: number | null };
  }> {
    const empty = {
      sessionId,
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
    };
    const found = await findGrokSession(sessionId);
    const contextUsage = found ? await readContextUsageFromDir(found.path) : null;
    const withUsage = {
      ...empty,
      ...(contextUsage ? { contextUsage } : {}),
      ...(contextUsage?.userMessages != null ? { userMessages: contextUsage.userMessages } : {}),
      ...(contextUsage?.toolCalls != null ? { toolCalls: contextUsage.toolCalls, toolResults: contextUsage.toolCalls } : {}),
    };
    if (!found) return withUsage;
    try {
      const text = await readFile(join(found.path, "updates.jsonl"), "utf8");
      const { messages } = mapUpdatesJsonl(text);
      let toolCalls = 0;
      for (const message of messages) {
        if (message.role !== "assistant") continue;
        toolCalls += message.content.filter((part) => part.type === "toolCall").length;
      }
      const userMessages = messages.filter((message) => message.role === "user").length;
      const assistantMessages = messages.filter((message) => message.role === "assistant").length;
      return {
        ...withUsage,
        sessionName: found.name || undefined,
        userMessages: contextUsage?.userMessages ?? userMessages,
        assistantMessages,
        toolCalls: contextUsage?.toolCalls ?? toolCalls,
        toolResults: contextUsage?.toolCalls ?? toolCalls,
        totalMessages: messages.length,
      };
    } catch {
      return { ...withUsage, sessionName: found.name || undefined };
    }
  }

  private async sendFork(sessionId: string, command: AgentCommand): Promise<{ cancelled: false; newSessionId: string }> {
    await this.ensureProcess();
    const session = this.ensureSession(sessionId);
    const cwd = session.cwd ?? (await findGrokSession(sessionId))?.cwd;
    if (!cwd) throw new Error("Cannot fork without a session cwd");
    const connection = this.captureConnection();
    const forked = await connection.acp.sessionFork({
      sourceSessionId: sessionId,
      sourceCwd: cwd,
      newCwd: cwd,
    });
    this.assertCurrentConnection(connection, "session/fork");
    const forkedSession = this.ensureSession(forked.newSessionId);
    forkedSession.loaded = true;
    forkedSession.cwd = cwd;
    invalidateSessionListCache();
    const entryId = typeof commandField(command, "entryId") === "string" ? commandField(command, "entryId") as string : "";
    if (entryId) {
      await this.rewindSession(forked.newSessionId, sessionId, entryId);
    }
    return { cancelled: false, newSessionId: forked.newSessionId };
  }

  private async sendNavigateTree(sessionId: string, command: AgentCommand): Promise<{ cancelled: false }> {
    await this.ensureProcess();
    await this.rewindSession(sessionId, sessionId, stringField(commandField(command, "targetId")));
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
    const startupToken = ++this.startupToken;
    const acp = await this.connectFn();
    const child = this.connectionChildren.get(acp) ?? this.child;
    try {
      await acp.initialize();
    } catch (error) {
      if (child && !child.killed) child.kill();
      if (this.child === child) this.child = undefined;
      throw error;
    }
    if (this.startupToken !== startupToken) {
      if (typeof acp.close === "function") acp.close();
      if (child && !child.killed) child.kill();
      if (this.child === child) this.child = undefined;
      throw new Error("ACP startup superseded");
    }
    this.unsubUpdate?.();
    this.unsubPermission?.();
    this.unsubPermissionResolved?.();
    this.unsubClose?.();
    this.acp = acp;
    const generation = ++this.connectionGeneration;
    if (typeof acp.onClose === "function") {
      this.unsubClose = acp.onClose(() => {
        if (this.acp === acp && this.connectionGeneration === generation) this.dropConnection();
      });
    }
    this.unsubUpdate = acp.onSessionUpdate((sessionId, update) => {
      const session = this.ensureSession(sessionId);
      session.configOptions = applyConfigOptionUpdate(session.configOptions, update);
      this.emit(sessionId, session.mapper.push(update));
      if (update && typeof update === "object" && "sessionUpdate" in update
        && (update as { sessionUpdate?: unknown }).sessionUpdate === "turn_completed") {
        void readSessionContextUsage(sessionId).then((usage) => {
          if (usage) this.emit(sessionId, [{ type: "context_usage", contextUsage: usage }]);
        });
      }
    });
    this.unsubPermission = acp.onPermission((event) => {
      this.forwardPermission(event);
    });
    if (typeof acp.onPermissionResolved === "function") {
      this.unsubPermissionResolved = acp.onPermissionResolved((event) => {
        this.emit(event.sessionId, [event]);
      });
    }
  }

  private async connectDefault(): Promise<AcpConnection> {
    const bin = resolveGrokBin();
    const capabilities = await discoverGrokCapabilities(bin);
    const profile = readRuntimeProfile();
    const child = spawn(bin, grokAgentArgs(profile, capabilities), { stdio: ["pipe", "pipe", "inherit"], env: grokAgentEnv() });
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
    const acp = new AcpConnection(new JsonRpcConn({ stdin: child.stdin, stdout: child.stdout }), {
      fsContext: (sessionId) => {
        const cwd = sessionId ? this.sessions.get(sessionId)?.cwd : undefined;
        const roots = cwd ? [canonicalCwd(cwd)] : [];
        return { cwd, roots, readRoots: [...roots, ...extraAcpReadRoots()] };
      },
    });
    this.connectionChildren.set(acp, child);
    return acp;
  }

  private dropConnection(): void {
    this.workspaceSessionStarts.clear();
    this.unsubUpdate?.();
    this.unsubPermission?.();
    this.unsubPermissionResolved?.();
    this.unsubClose?.();
    this.unsubUpdate = undefined;
    this.unsubPermission = undefined;
    this.unsubPermissionResolved = undefined;
    this.unsubClose = undefined;
    for (const session of this.sessions.values()) session.loaded = false;
    this.acp = undefined;
    this.connectionGeneration += 1;
    this.startupToken += 1;
    this.starting = undefined;
  }

  private forwardPermission(event: PermissionUiRequest & { sessionId?: string }): void {
    const sessionId = typeof event.sessionId === "string" && event.sessionId.trim() === event.sessionId
      ? event.sessionId
      : "";
    if (sessionId) this.emit(sessionId, [event]);
  }

  private isSessionBashRunning(session: SessionState | undefined): boolean {
    return Boolean(session?.bashStarting) || (session?.bashTerminalIds.size ?? 0) > 0;
  }

  private isSessionBusy(session: SessionState | undefined): boolean {
    return session?.busy === true || this.isSessionBashRunning(session);
  }

  private async killBashTerminals(sessionId: string): Promise<unknown> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const terminalIds = [...session.bashTerminalIds];
    session.bashStarting = false;
    if (terminalIds.length === 0) return null;
    let last: unknown = null;
    for (const terminalId of terminalIds) {
      try {
        last = await this.requireAcp().terminalKill(sessionId, terminalId);
      } catch {
        // A vanished terminal should not block abort or session drop.
      }
      session.bashTerminalIds.delete(terminalId);
    }
    return last;
  }

  private ensureSession(sessionId: string): SessionState {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        mapper: new AcpTurnMapper(),
        loaded: false,
        busy: false,
        bashStarting: false,
        bashTerminalIds: new Set(),
        queue: new SessionQueue(),
        configOptions: [],
        modes: { current: null, available: [] },
        eventSequence: 0,
        queuedPromptGenerations: [],
      };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  private emit(sessionId: string, events: Array<Record<string, unknown>>): void {
    const session = this.ensureSession(sessionId);
    if (events.length === 0) return;
    const listeners = this.listeners.get(sessionId);
    const sequenced = this.sequencedListeners.get(sessionId);
    for (const event of events) {
      session.eventSequence += 1;
      for (const listener of [...(listeners ?? [])]) listener(event);
      for (const listener of [...(sequenced ?? [])]) {
        listener({
          sequence: session.eventSequence,
          event,
          ...(session.eventPromptGeneration !== undefined ? { promptGeneration: session.eventPromptGeneration } : {}),
        });
      }
    }
  }

  private getTools(sessionId: string): ToolEntry[] {
    const session = this.ensureSession(sessionId);
    if (!hasToolsConfig(session.configOptions)) {
      throw new AgentCapabilityError("Tool presets are not advertised");
    }
    return toolEntriesForPreset(selectedToolsPreset(session.configOptions) ?? "default");
  }

  private async setTools(sessionId: string, command: AgentCommand): Promise<ToolEntry[]> {
    const session = this.ensureSession(sessionId);
    if (!hasToolsConfig(session.configOptions)) {
      throw new AgentCapabilityError("Tool presets are not advertised");
    }
    const toolNames = commandField(command, "toolNames");
    const names = Array.isArray(toolNames)
      ? toolNames.filter((name): name is string => typeof name === "string")
      : [];
    const preset = getPresetFromTools(names.map((name) => ({ name, description: name, active: true })));
    await this.ensureProcess();
    const updated = await this.requireAcp().sessionSetConfigOption(sessionId, "tools", preset);
    const options = readAcpConfigOptions(updated);
    session.configOptions = options.length > 0
      ? options
      : rememberToolsPreset(session.configOptions, preset);
    return this.getTools(sessionId);
  }

  private requireAcp(): AcpConnection {
    if (!this.acp) throw new Error("ACP process is not available");
    return this.acp;
  }

  private captureConnection(): { acp: AcpConnection; generation: number } {
    return { acp: this.requireAcp(), generation: this.connectionGeneration };
  }

  private assertCurrentConnection(
    connection: { acp: AcpConnection; generation: number },
    operation: string,
  ): void {
    if (this.acp !== connection.acp || this.connectionGeneration !== connection.generation) {
      throw new Error(`ACP connection changed during ${operation}`);
    }
  }
}

const RUNTIME_KEY = "__grokWebAgentRuntime";

type GrokWebGlobals = typeof globalThis & { [RUNTIME_KEY]?: AgentRuntime };

function runtimeStore(): GrokWebGlobals {
  return globalThis as GrokWebGlobals;
}

export function getAgentRuntime(): AgentRuntime {
  const g = runtimeStore();
  g[RUNTIME_KEY] ??= new AgentRuntime();
  return g[RUNTIME_KEY];
}

export function peekAgentRuntime(): AgentRuntime | undefined {
  return runtimeStore()[RUNTIME_KEY];
}

export function setAgentRuntime(runtime: AgentRuntime | undefined): void {
  const g = runtimeStore();
  if (runtime) g[RUNTIME_KEY] = runtime;
  else delete g[RUNTIME_KEY];
}

export function resetAgentRuntime(): void {
  setAgentRuntime(undefined);
}

export async function disposeAgentRuntime(): Promise<void> {
  await peekAgentRuntime()?.dispose();
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

function hasPromptImages(images: unknown): boolean {
  return Array.isArray(images) && images.length > 0;
}

async function diskHasUserMessages(sessionId: string): Promise<boolean> {
  const found = await findGrokSession(sessionId);
  if (!found) return false;
  try {
    const text = await readFile(join(found.path, "updates.jsonl"), "utf8");
    return mapUpdatesJsonl(text).messages.some((message) => (
      message.role === "user" && historyUserText(message.content).trim().length > 0
    ));
  } catch {
    return false;
  }
}
