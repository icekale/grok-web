import { findGrokSession, listGrokSessions } from "./session-index.ts";
import type { SessionContext, SessionEntry, SessionHeader, SessionInfo } from "./types";

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

export function getSessionEntries(_filePath: string): SessionEntry[] {
  return [];
}

export function buildSessionContext(
  _entries: SessionEntry[],
  _leafId?: string | null,
  _options: { deferThinking?: boolean; deferToolResultImages?: boolean; deferToolResults?: boolean } = {},
): SessionContext {
  return {
    messages: [],
    entryIds: [],
    thinkingLevel: "off",
    model: null,
  };
}
