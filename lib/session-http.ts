import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { archiveSession, pinSession, readAppMeta } from "./app-meta.ts";
import { applyToolOutputUpdate, historyUserText, mapUpdatesJsonl } from "./history-map.ts";
import { packSessionArchive, renderSessionHtml } from "./session-export.ts";
import { findGrokSession } from "./session-index.ts";
import { readSessionContextUsage } from "./session-signals.ts";
import { isReservedSubagentSessionName } from "./session-relations.ts";
import { listAllSessions } from "./session-reader.ts";
import type { SessionInfo } from "./types.ts";
import { getAgentRuntime, peekAgentRuntime } from "./acp/runtime.ts";

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
        sessions: sessions
          .filter((session) => session.sessionRole !== "subagent")
          .map(compactSessionForList),
        runningSessionIds: getAgentRuntime().listBusyIds(),
        meta,
      },
      NO_STORE,
    );
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500, ...NO_STORE });
  }
}

async function loadMappedSession(id: string) {
  const session = await findGrokSession(id);
  if (!session) return null;
  let text = "";
  try {
    text = await readFile(join(session.path, "updates.jsonl"), "utf8");
  } catch {
    text = "";
  }
  return { session, ...mapUpdatesJsonl(text) };
}

export async function getSessionContext(_req: Request, id: string): Promise<Response> {
  try {
    const loaded = await loadMappedSession(id);
    if (!loaded) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }
    return Response.json({ context: { messages: loaded.messages, entryIds: loaded.entryIds } });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}

export async function getSessionDetail(_req: Request, id: string): Promise<Response> {
  try {
    const loaded = await loadMappedSession(id);
    if (!loaded) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }
    const { session, messages, entryIds } = loaded;
    const lastAssistant = messages.findLast((message) => message.role === "assistant");
    return Response.json({
      sessionId: id,
      filePath: session.path,
      totalActiveMs: 0,
      tree: [],
      leafId: entryIds.at(-1) ?? null,
      info: session,
      context: {
        messages,
        entryIds,
        thinkingLevel: "off",
        model: lastAssistant
          ? { provider: lastAssistant.provider, modelId: lastAssistant.model }
          : null,
      },
    });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}

const MAX_AUTO_NAME_LENGTH = 80;

export function titleFromHistory(messages: { role: string; content: unknown }[]): string {
  const user = messages.find((message) => message.role === "user");
  const text = historyUserText(user?.content);
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  return collapsed.length <= MAX_AUTO_NAME_LENGTH
    ? collapsed
    : collapsed.slice(0, MAX_AUTO_NAME_LENGTH).trimEnd();
}

export async function persistSessionName(id: string, name: string): Promise<Response> {
  if (!name) return Response.json({ error: "name is required" }, { status: 400 });
  if (isReservedSubagentSessionName(name)) {
    return Response.json({ error: "Reserved subagent session name" }, { status: 409 });
  }
  const session = await findGrokSession(id);
  if (!session) return Response.json({ error: "Session not found" }, { status: 404 });
  if (session.sessionRole === "subagent") {
    return Response.json({ error: "Cannot rename a subagent session" }, { status: 409 });
  }
  const summaryPath = join(session.path, "summary.json");
  try {
    const parsed: unknown = JSON.parse(readFileSync(summaryPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return Response.json({ error: "Invalid session summary" }, { status: 500 });
    }
    const rec = parsed as Record<string, unknown>;
    rec.generated_title = name;
    writeFileSync(summaryPath, `${JSON.stringify(rec, null, 2)}\n`);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
  const runtime = peekAgentRuntime();
  if (runtime) {
    try {
      await runtime.send(id, { type: "set_session_name", name });
    } catch {
      // Disk title is enough when ACP is down.
    }
  }
  return Response.json({ ok: true, id, name });
}

export async function patchSession(req: Request, id: string): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const name = body && typeof body === "object" && !Array.isArray(body) && typeof (body as { name?: unknown }).name === "string"
    ? (body as { name: string }).name.trim()
    : "";
  return persistSessionName(id, name);
}

export async function autoNameSession(id: string): Promise<Response> {
  const loaded = await loadMappedSession(id);
  if (!loaded) return Response.json({ error: "Session not found" }, { status: 404 });
  if (loaded.session.sessionRole === "subagent") {
    return Response.json({ error: "Cannot rename a subagent session" }, { status: 409 });
  }
  const title = titleFromHistory(loaded.messages);
  if (!title) {
    return Response.json({ error: "The session has no user messages to name" }, { status: 400 });
  }
  const persisted = await persistSessionName(id, title);
  if (!persisted.ok) return persisted;
  return Response.json({ title, usage: null });
}

export async function getThinking(req: Request, id: string, entryId: string): Promise<Response> {
  const blockIndexParam = new URL(req.url).searchParams.get("blockIndex");
  const blockIndex = blockIndexParam === null ? Number.NaN : Number(blockIndexParam);
  if (!Number.isSafeInteger(blockIndex) || blockIndex < 0) {
    return Response.json({ error: "Valid blockIndex is required" }, { status: 400 });
  }
  const loaded = await loadMappedSession(id);
  if (!loaded) return Response.json({ error: "Session not found" }, { status: 404 });
  const index = loaded.entryIds.indexOf(entryId);
  const message = index >= 0 ? loaded.messages[index] : undefined;
  if (!message || message.role !== "assistant") {
    return Response.json({ error: "Assistant message not found" }, { status: 404 });
  }
  const block = message.content[blockIndex];
  if (!block || block.type !== "thinking") {
    return Response.json({ error: "Thinking block not found" }, { status: 404 });
  }
  return Response.json({ thinking: block.thinking });
}

export async function getToolResult(_req: Request, id: string, entryId: string): Promise<Response> {
  const session = await findGrokSession(id);
  if (!session) return Response.json({ error: "Session not found" }, { status: 404 });
  let text = "";
  try {
    text = await readFile(join(session.path, "updates.jsonl"), "utf8");
  } catch {
    text = "";
  }
  let found = false;
  let output = { text: "" };
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    const params = (record as { params?: unknown }).params;
    if (!params || typeof params !== "object" || Array.isArray(params)) continue;
    const update = (params as { update?: unknown }).update;
    if (!update || typeof update !== "object" || Array.isArray(update)) continue;
    const kind = (update as { sessionUpdate?: unknown }).sessionUpdate;
    const toolCallId =
      typeof (update as { toolCallId?: unknown }).toolCallId === "string"
        ? (update as { toolCallId: string }).toolCallId
        : typeof (update as { id?: unknown }).id === "string"
          ? (update as { id: string }).id
          : "";
    if (toolCallId !== entryId) continue;
    if (kind === "tool_call" || kind === "tool_call_update") {
      found = true;
      output = applyToolOutputUpdate(output, update as Record<string, unknown>);
    }
  }
  if (!found) return Response.json({ error: "Tool result not found" }, { status: 404 });
  return Response.json({
    result: {
      role: "toolResult",
      toolCallId: entryId,
      content: output.text ? [{ type: "text", text: output.text }] : [],
    },
  });
}

export async function getSessionState(_req: Request, id: string): Promise<Response> {
  const session = await findGrokSession(id);
  if (!session) return Response.json({ error: "Session not found" }, { status: 404 });
  const contextUsage = await readSessionContextUsage(id);
  const runtime = peekAgentRuntime();
  if (runtime) {
    try {
      const state = await runtime.send(id, { type: "get_state" }) as Record<string, unknown>;
      return Response.json({
        running: runtime.isBusy(id),
        state: {
          ...state,
          ...(contextUsage ? { contextUsage } : {}),
        },
      });
    } catch {
      // Session is on disk but not loaded in ACP; return idle state.
    }
  }
  return Response.json({
    running: false,
    state: {
      thinkingLevel: "off",
      queuedMessages: { steering: [], followUp: [] },
      ...(contextUsage ? { contextUsage } : {}),
    },
  });
}

export async function deleteSession(id: string): Promise<Response> {
  const session = await findGrokSession(id);
  if (!session) return Response.json({ error: "Session not found" }, { status: 404 });
  try {
    await peekAgentRuntime()?.closeSession(id);
  } catch {
    // Disk delete still proceeds if the ACP session is already gone.
  }
  rmSync(session.path, { recursive: true, force: true });
  return Response.json({ ok: true, id });
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

function encodeHeaderValue(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (ch) =>
    `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function contentDisposition(fileName: string, inline: boolean): string {
  const fallback = fileName.replace(/[^\x20-\x7E]|["\\;\r\n]/g, "_") || "session.zip";
  const disposition = inline ? "inline" : "attachment";
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeHeaderValue(fileName)}`;
}

export async function getSessionExport(req: Request, id: string): Promise<Response> {
  const inline = new URL(req.url).searchParams.get("inline") === "1";
  try {
    const session = await findGrokSession(id);
    if (!session) return Response.json({ error: "Session not found" }, { status: 404 });

    if (inline) {
      let text = "";
      try {
        text = readFileSync(join(session.path, "updates.jsonl"), "utf8");
      } catch {
        text = "";
      }
      const { messages } = mapUpdatesJsonl(text);
      const html = renderSessionHtml(session.name || id, messages);
      return new Response(html, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Disposition": contentDisposition(`${id}.html`, true),
          "Cache-Control": "no-cache",
        },
      });
    }

    const archive = packSessionArchive(session.path, id);
    return new Response(Uint8Array.from(archive.bytes), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": contentDisposition(archive.fileName, false),
        "Cache-Control": "no-cache",
      },
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
