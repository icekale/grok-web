import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { mapUpdatesJsonl, toolResultText, type HistoryMessage } from "./history-map.ts";
import { findGrokSession, listGrokSessions } from "./session-index.ts";
import type { AgentMessage, SessionContext, SessionEntry, SessionHeader, SessionInfo } from "./types";

export function getAgentDir(): string {
  throw new Error("not implemented in foundation");
}

export async function attachSessionProjectInfo(sessions: SessionInfo[]): Promise<SessionInfo[]> {
  return sessions.map((session) => ({
    ...session,
    projectRoot: session.cwd,
  }));
}

export function mergeSessionLists(
  persistedSessions: SessionInfo[],
  supplementalSessions: SessionInfo[],
): SessionInfo[] {
  const byId = new Map(supplementalSessions.map((session) => [session.id, session]));
  for (const session of persistedSessions) byId.set(session.id, session);
  return [...byId.values()].sort((a, b) => b.modified.localeCompare(a.modified));
}

export async function listAllSessions(_options: { force?: boolean } = {}): Promise<SessionInfo[]> {
  return attachSessionProjectInfo(await listGrokSessions());
}

export function invalidateSessionListCache(): void {}

export function discoverNestedSessions(_parents: Array<Pick<SessionInfo, "id" | "path">>): SessionInfo[] {
  return [];
}

export async function resolveSessionPath(sessionId: string): Promise<string | null> {
  const session = await findGrokSession(sessionId);
  return session?.path ?? null;
}

export async function resolveSessionIdByPath(_filePath: string): Promise<string | undefined> {
  return undefined;
}

export function cacheSessionPath(_sessionId: string, _filePath: string): void {}

export function invalidateSessionPathCache(_sessionId: string): void {}

export function readSessionHeader(_filePath: string): SessionHeader | null {
  return null;
}

export function getSessionEntries(filePath: string): SessionEntry[] {
  const text = readSessionText(filePath);
  const native: SessionEntry[] = [];
  const commandsByTool = new Map<string, string>();
  const bashByPath = new Map<string, SessionEntry>();

  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isRecord(record) || record.type === "session") continue;
    if (isSessionEntry(record)) {
      native.push(record);
      continue;
    }
    collectBashHints(record, commandsByTool, bashByPath);
  }

  const entries = native.length > 0 ? [...native] : mapGrokEntries(text);
  for (const bash of bashByPath.values()) {
    const path = bash.message.role === "bashExecution" ? bash.message.fullOutputPath : undefined;
    if (!path) continue;
    if (entries.some((entry) => (
      entry.type === "message"
      && entry.message.role === "bashExecution"
      && entry.message.fullOutputPath === path
    ))) {
      continue;
    }
    entries.push(bash);
  }
  return entries;
}

export function buildSessionContext(
  entries: SessionEntry[],
  leafId?: string | null,
  _options: { deferThinking?: boolean; deferToolResultImages?: boolean; deferToolResults?: boolean } = {},
): SessionContext {
  const messages: AgentMessage[] = [];
  const entryIds: string[] = [];
  for (const entry of entries) {
    if (entry.type === "message") {
      messages.push(entry.message);
      entryIds.push(entry.id);
    }
    if (leafId && entry.id === leafId) break;
  }
  return {
    messages,
    entryIds,
    thinkingLevel: "off",
    model: null,
  };
}

function readSessionText(filePath: string): string {
  try {
    const target = existsSync(filePath) && statSync(filePath).isDirectory()
      ? join(filePath, "updates.jsonl")
      : filePath;
    return readFileSync(target, "utf8");
  } catch {
    return "";
  }
}

function mapGrokEntries(text: string): SessionEntry[] {
  const { messages, entryIds } = mapUpdatesJsonl(text);
  const entries: SessionEntry[] = [];
  let parentId: string | null = null;
  for (let i = 0; i < messages.length; i++) {
    const id = entryIds[i] ?? `msg-${i}`;
    entries.push({
      type: "message",
      id,
      parentId,
      timestamp: timestampOf(messages[i]),
      message: toAgentMessage(messages[i]),
    });
    parentId = id;
  }
  return entries;
}

function collectBashHints(
  record: Record<string, unknown>,
  commandsByTool: Map<string, string>,
  bashByPath: Map<string, SessionEntry>,
): void {
  const seen = new Set<object>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isRecord(value) || seen.has(value)) return;
    seen.add(value);
    const toolCallId = stringField(value.toolCallId) || stringField(value.id);
    const toolName = stringField(value.title) || stringField(value.toolName) || stringField(value.kind);
    const input = isRecord(value.input) ? value.input : isRecord(value.rawInput) ? value.rawInput : undefined;
    if (toolCallId && isBashTool(toolName) && input && typeof input.command === "string") {
      commandsByTool.set(toolCallId, input.command);
    }
    if (typeof value.fullOutputPath === "string" && value.fullOutputPath) {
      const command = (toolCallId && commandsByTool.get(toolCallId))
        || (input && typeof input.command === "string" ? input.command : "")
        || stringField(value.command);
      bashByPath.set(value.fullOutputPath, {
        type: "message",
        id: toolCallId || `bash-${bashByPath.size}`,
        parentId: null,
        timestamp: timestampString(record),
        message: {
          role: "bashExecution",
          command,
          output: toolResultText(value.content ?? value.rawOutput ?? value.output),
          fullOutputPath: value.fullOutputPath,
        },
      });
    }
    for (const nested of Object.values(value)) visit(nested);
  };
  visit(record);
}

function toAgentMessage(message: HistoryMessage): AgentMessage {
  if (message.role === "user") {
    return {
      role: "user",
      content: message.content,
      ...(message.timestamp !== undefined ? { timestamp: message.timestamp } : {}),
    };
  }
  if (message.role === "toolResult") return message;
  return {
    role: "assistant",
    content: message.content,
    model: message.model,
    provider: message.provider,
    ...(message.timestamp !== undefined ? { timestamp: message.timestamp } : {}),
  };
}

function timestampOf(message: HistoryMessage): string {
  if (typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) {
    return new Date(message.timestamp).toISOString();
  }
  return new Date(0).toISOString();
}

function timestampString(record: Record<string, unknown>): string {
  return typeof record.timestamp === "number" && Number.isFinite(record.timestamp)
    ? new Date(record.timestamp > 1e12 ? record.timestamp : record.timestamp * 1000).toISOString()
    : new Date(0).toISOString();
}

function isSessionEntry(record: Record<string, unknown>): record is SessionEntry {
  return typeof record.type === "string"
    && typeof record.id === "string"
    && record.type !== "session"
    && (record.type !== "message" || isRecord(record.message));
}

function isBashTool(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized === "bash" || normalized === "shell" || normalized === "terminal";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}
