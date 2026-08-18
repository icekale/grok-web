import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { archiveSession, pinSession, readAppMeta } from "./app-meta.ts";
import { mapUpdatesJsonl } from "./history-map.ts";
import { findGrokSession } from "./session-index.ts";
import { listAllSessions } from "./session-reader.ts";
import type { SessionInfo } from "./types.ts";

const SESSION_LIST_FIRST_MESSAGE_CHARS = 512;
const NO_STORE = { headers: { "Cache-Control": "no-store" } };

export function compactSessionForList(session: SessionInfo): SessionInfo {
  if (session.firstMessage.length <= SESSION_LIST_FIRST_MESSAGE_CHARS) return session;
  return { ...session, firstMessage: session.firstMessage.slice(0, SESSION_LIST_FIRST_MESSAGE_CHARS) };
}

export async function getSessions(_req: Request): Promise<Response> {
  try {
    const [sessions, meta] = await Promise.all([listAllSessions(), readAppMeta()]);
    return Response.json(
      {
        sessions: sessions.map(compactSessionForList),
        runningSessionIds: [],
        meta,
      },
      NO_STORE,
    );
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500, ...NO_STORE });
  }
}

export async function getSessionContext(_req: Request, id: string): Promise<Response> {
  try {
    const session = await findGrokSession(id);
    if (!session) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }
    let text = "";
    try {
      text = await readFile(join(session.path, "updates.jsonl"), "utf8");
    } catch {
      text = "";
    }
    const { messages, entryIds } = mapUpdatesJsonl(text);
    return Response.json({ context: { messages, entryIds } });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}

export async function postMeta(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "Invalid body" }, { status: 400 });
  }

  const rec = body as Record<string, unknown>;
  let meta = await readAppMeta();
  const pin = toggleAction(rec.pin);
  if (pin) meta = await pinSession(pin.id, pin.value);
  const archive = toggleAction(rec.archive);
  if (archive) meta = await archiveSession(archive.id, archive.value);
  return Response.json(meta);
}

function toggleAction(value: unknown): { id: string; value: boolean } | undefined {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const rec = value as Record<string, unknown>;
  if (typeof rec.id !== "string" || !rec.id || typeof rec.value !== "boolean") return undefined;
  return { id: rec.id, value: rec.value };
}
