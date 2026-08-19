import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { grokSessionsDir } from "./grok-home.ts";
import type { SessionInfo } from "./types";

export type { SessionInfo };

export async function listGrokSessions(): Promise<SessionInfo[]> {
  const root = grokSessionsDir();
  let groups;
  try {
    groups = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const sessions: SessionInfo[] = [];
  for (const group of groups) {
    if (!group.isDirectory()) continue;
    const groupDir = join(root, group.name);
    const cwd = await resolveGroupCwd(groupDir, group.name);
    let children;
    try {
      children = await readdir(groupDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (!child.isDirectory()) continue;
      const session = await readSession(join(groupDir, child.name), child.name, cwd);
      if (session) sessions.push(session);
    }
  }

  sessions.sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0));
  return sessions;
}

export async function findGrokSession(id: string): Promise<SessionInfo | null> {
  const sessions = await listGrokSessions();
  return sessions.find((session) => session.id === id) ?? null;
}

async function resolveGroupCwd(groupDir: string, groupName: string): Promise<string> {
  try {
    const raw = await readFile(join(groupDir, ".cwd"), "utf8");
    const line = raw.split(/\r?\n/, 1)[0]?.trim();
    if (line) return line;
  } catch {
    // no usable .cwd
  }
  try {
    return decodeURIComponent(groupName);
  } catch {
    return groupName;
  }
}

async function readSession(
  sessionDir: string,
  dirName: string,
  cwd: string,
): Promise<SessionInfo | null> {
  let body: Record<string, unknown>;
  try {
    const raw = await readFile(join(sessionDir, "summary.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    body = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const info =
    body.info != null && typeof body.info === "object" && !Array.isArray(body.info)
      ? (body.info as Record<string, unknown>)
      : {};
  const id = stringField(info.id) || dirName;
  const name = stringField(body.generated_title) || stringField(body.session_summary);
  const created = stringField(body.created_at);
  const modified = stringField(body.last_active_at) || stringField(body.updated_at);
  const messageCount =
    numberField(body.num_chat_messages) ?? numberField(body.num_messages) ?? 0;
  const firstMessage = stringField(body.session_summary) || "(no messages)";
  const parentSessionId =
    stringField(info.parent_session_id) || stringField(body.parent_session_id) || undefined;
  const sessionKind = stringField(body.session_kind);

  const session: SessionInfo = {
    id,
    cwd,
    path: sessionDir,
    name,
    created,
    modified,
    messageCount,
    firstMessage,
  };
  if (parentSessionId) session.parentSessionId = parentSessionId;
  if (sessionKind === "subagent" || sessionKind === "subagent_resume") {
    session.sessionRole = "subagent";
  }
  return session;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
