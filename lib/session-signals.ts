import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ContextUsage } from "./pi-types.ts";
import { findGrokSession } from "./session-index.ts";

export async function readSessionContextUsage(sessionId: string): Promise<ContextUsage | null> {
  const found = await findGrokSession(sessionId);
  if (!found) return null;
  return readContextUsageFromDir(found.path);
}

export async function readContextUsageFromDir(sessionDir: string): Promise<ContextUsage | null> {
  let usage: ContextUsage | null;
  try {
    usage = parseSessionSignals(await readFile(join(sessionDir, "signals.json"), "utf8"));
  } catch {
    return null;
  }
  if (!usage) return null;
  try {
    const activity = parseChatHistoryActivity(await readFile(join(sessionDir, "chat_history.jsonl"), "utf8"));
    return { ...usage, ...activity };
  } catch {
    return usage;
  }
}

export function parseSessionSignals(raw: string): ContextUsage | null {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  if (body == null || typeof body !== "object" || Array.isArray(body)) return null;
  const rec = body as Record<string, unknown>;
  const contextWindow = finiteNumber(rec.contextWindowTokens);
  if (contextWindow == null || contextWindow <= 0) return null;
  const tokens = finiteNumber(rec.contextTokensUsed);
  const used = tokens == null ? null : Math.max(0, tokens);
  let percent = finiteNumber(rec.contextWindowUsage);
  if (percent == null && used != null) percent = (used / contextWindow) * 100;
  const userMessages = integerCount(rec.turnCount) ?? integerCount(rec.userMessageCount);
  const toolCalls = integerCount(rec.toolCallCount);
  return {
    percent: percent == null ? null : Math.min(100, Math.max(0, percent)),
    contextWindow,
    tokens: used,
    ...(userMessages != null ? { userMessages } : {}),
    ...(toolCalls != null ? { toolCalls } : {}),
  };
}

export function parseChatHistoryActivity(raw: string): { userMessages: number; toolCalls: number } {
  let userMessages = 0;
  const toolIds = new Set<string>();
  let toolRows = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row == null || typeof row !== "object" || Array.isArray(row)) continue;
    const rec = row as Record<string, unknown>;
    if (rec.type === "tool_result") {
      toolRows += 1;
      if (typeof rec.tool_call_id === "string" && rec.tool_call_id) {
        toolIds.add(logicalToolCallId(rec.tool_call_id));
      }
    }
    if (rec.type === "user" && isCountedUserTurn(rec)) userMessages += 1;
  }
  return {
    userMessages,
    toolCalls: toolIds.size > 0 ? toolIds.size : toolRows,
  };
}

const TOOL_CALL_ID = /^call-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:-\d+)?$/i;

function logicalToolCallId(toolCallId: string): string {
  const match = toolCallId.match(TOOL_CALL_ID);
  if (!match) return toolCallId;
  return toolCallId.replace(/-\d+$/, "");
}

function isCountedUserTurn(rec: Record<string, unknown>): boolean {
  if (typeof rec.synthetic_reason === "string" && rec.synthetic_reason) return false;
  const text = flattenUserText(rec.content);
  if (text.includes("<user_query>")) return true;
  if (text.includes("<system-reminder>") || text.includes("<user_info>")) return false;
  return text.trim().length > 0;
}

function flattenUserText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const part of content) {
    if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
      text += part.text;
    }
  }
  return text;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function integerCount(value: unknown): number | undefined {
  const n = finiteNumber(value);
  if (n == null || n < 0 || !Number.isInteger(n)) return undefined;
  return n;
}
