import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseChatHistoryActivity, parseSessionSignals, readSessionContextUsage } from "./session-signals.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "acp/fixtures");

function chatHistoryText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((row) => typeof row === "string" ? row : JSON.stringify(row)).join("\n");
  }
  return "";
}

describe("parseSessionSignals", () => {
  it("reads used tokens, window, and percent from Grok signals.json", () => {
    assert.deepEqual(parseSessionSignals(JSON.stringify({
      contextWindowUsage: 6,
      contextTokensUsed: 33669,
      contextWindowTokens: 500000,
    })), {
      percent: 6,
      contextWindow: 500000,
      tokens: 33669,
    });
  });

  it("reads turn and tool counts from Grok signals.json", () => {
    const overlay = JSON.parse(readFileSync(join(fixtures, "signals-overlay.json"), "utf8"));
    assert.deepEqual(parseSessionSignals(JSON.stringify(overlay.signals)), {
      percent: 31,
      contextWindow: 500000,
      tokens: 159068,
      userMessages: 21,
      toolCalls: 619,
    });
  });

  it("computes percent when Grok omitted contextWindowUsage", () => {
    const usage = parseSessionSignals(JSON.stringify({
      contextTokensUsed: 25000,
      contextWindowTokens: 100000,
    }));
    assert.equal(usage?.contextWindow, 100000);
    assert.equal(usage?.tokens, 25000);
    assert.equal(usage?.percent, 25);
  });

  it("returns null without a positive context window", () => {
    assert.equal(parseSessionSignals("{"), null);
    assert.equal(parseSessionSignals("{}"), null);
    assert.equal(parseSessionSignals(JSON.stringify({
      contextTokensUsed: 10,
      contextWindowTokens: 0,
    })), null);
  });
});

describe("parseChatHistoryActivity", () => {
  it("counts current-context user queries and unique tool results", () => {
    const raw = [
      JSON.stringify({ type: "user", content: [{ type: "text", text: "<user_info>\nOS\n</user_info>" }] }),
      JSON.stringify({ type: "user", content: [{ type: "text", text: "<user_query>\nhello\n</user_query>" }] }),
      JSON.stringify({ type: "user", synthetic_reason: "mcp", content: [{ type: "text", text: "<system-reminder>\nMCP\n</system-reminder>" }] }),
      JSON.stringify({ type: "user", content: [{ type: "text", text: "<user_query>\nagain\n</user_query>" }] }),
      JSON.stringify({ type: "tool_result", tool_call_id: "call-1", content: "ok" }),
      JSON.stringify({ type: "tool_result", tool_call_id: "call-2", content: "ok" }),
      JSON.stringify({ type: "assistant", content: "hi" }),
    ].join("\n");
    assert.deepEqual(parseChatHistoryActivity(raw), { userMessages: 2, toolCalls: 2 });
  });

  it("collapses chunked tool_result ids into one tool call", () => {
    const raw = readFileSync(join(fixtures, "chunked-tool-ids.jsonl"), "utf8");
    const toolRows = raw.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line))
      .filter((row) => row.type === "tool_result");
    assert.ok(toolRows.length > 2);
    assert.deepEqual(parseChatHistoryActivity(raw), { userMessages: 1, toolCalls: 2 });
    assert.notEqual(parseChatHistoryActivity(raw).toolCalls, toolRows.length);
  });

  it("overlays lifetime signals with the current chat_history window", () => {
    const overlay = JSON.parse(readFileSync(join(fixtures, "signals-overlay.json"), "utf8"));
    const lifetime = parseSessionSignals(JSON.stringify(overlay.signals));
    const window = parseChatHistoryActivity(chatHistoryText(overlay.chatHistory));
    assert.equal(lifetime.toolCalls, 619);
    assert.equal(window.toolCalls, 2);
    assert.deepEqual(window, parseChatHistoryActivity(readFileSync(join(fixtures, "chunked-tool-ids.jsonl"), "utf8")));
    const merged = { ...lifetime, ...window };
    assert.equal(merged.toolCalls, 2);
    assert.equal(merged.userMessages, 1);
    assert.notEqual(merged.toolCalls, lifetime.toolCalls);
  });
});

describe("readSessionContextUsage", () => {
  it("loads signals.json for a session on disk", async () => {
    const home = await mkdtemp(join(tmpdir(), "grok-signals-"));
    const prev = process.env.GROK_HOME;
    process.env.GROK_HOME = home;
    try {
      const id = "01ssssssssssssssssssssssss";
      const dir = join(home, "sessions", encodeURIComponent("/tmp/p"), id);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "summary.json"), JSON.stringify({
        info: { id, cwd: "/tmp/p" },
        created_at: "2026-08-20T00:00:00.000Z",
        updated_at: "2026-08-20T00:00:00.000Z",
      }));
      await writeFile(join(dir, "signals.json"), JSON.stringify({
        contextWindowUsage: 12.5,
        contextTokensUsed: 62500,
        contextWindowTokens: 500000,
        turnCount: 21,
        toolCallCount: 619,
      }));
      await writeFile(join(dir, "chat_history.jsonl"), [
        JSON.stringify({ type: "user", content: [{ type: "text", text: "<user_query>\nnow\n</user_query>" }] }),
        JSON.stringify({ type: "tool_result", tool_call_id: "call-a", content: "ok" }),
        JSON.stringify({ type: "tool_result", tool_call_id: "call-b", content: "ok" }),
      ].join("\n"));
      assert.deepEqual(await readSessionContextUsage(id), {
        percent: 12.5,
        contextWindow: 500000,
        tokens: 62500,
        userMessages: 1,
        toolCalls: 2,
      });
      assert.equal(await readSessionContextUsage("missing"), null);
    } finally {
      if (prev === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = prev;
    }
  });
});
