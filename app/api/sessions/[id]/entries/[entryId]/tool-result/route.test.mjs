import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET } = await jiti.import("./route.ts");

function updateLine(update, meta = {}) {
  return JSON.stringify({
    timestamp: 1,
    method: "session/update",
    params: { sessionId: "s", update, _meta: meta },
  });
}

function writeToolResultSession(extraLines = []) {
  const home = mkdtempSync(join(tmpdir(), "grok-tool-result-"));
  const id = "01qqqqqqqqqqqqqqqqqqqqqqqq";
  const dir = join(home, "sessions", encodeURIComponent("/tmp/p"), id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "summary.json"), JSON.stringify({
    info: { id, cwd: "/tmp/p" },
    session_summary: "Tools",
    created_at: "2026-08-19T00:00:00.000Z",
    updated_at: "2026-08-19T00:00:00.000Z",
    generated_title: "Tools",
  }));
  writeFileSync(join(dir, "updates.jsonl"), [
    updateLine({ sessionUpdate: "tool_call", toolCallId: "tr-1", title: "bash" }, { eventId: "tr-1" }),
    updateLine({
      sessionUpdate: "tool_call_update",
      toolCallId: "tr-1",
      content: { type: "text", text: "full result" },
    }, { eventId: "tr-1" }),
    ...extraLines,
  ].join("\n"));
  return { home, id, toolEntryId: "tr-1" };
}

async function withHome(home, fn) {
  const prev = process.env.GROK_HOME;
  process.env.GROK_HOME = home;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
}

test("returns the full normalized tool result for a valid entry", async () => {
  const { home, id, toolEntryId } = writeToolResultSession();
  await withHome(home, async () => {
    const response = await GET(
      new Request(`http://localhost/api/sessions/${id}/entries/${toolEntryId}/tool-result`),
      { params: Promise.resolve({ id, entryId: toolEntryId }) },
    );
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).result, {
      role: "toolResult",
      toolCallId: toolEntryId,
      content: [{ type: "text", text: "full result" }],
    });
  });
});

test("returns 404 for an unknown entry id", async () => {
  const { home, id } = writeToolResultSession();
  await withHome(home, async () => {
    const response = await GET(
      new Request(`http://localhost/api/sessions/${id}/entries/missing/tool-result`),
      { params: Promise.resolve({ id, entryId: "missing" }) },
    );
    assert.equal(response.status, 404);
  });
});

test("returns 404 when the entry is an assistant message, not a tool result", async () => {
  const assistantEntryId = "a-1";
  const { home, id } = writeToolResultSession([
    updateLine(
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } },
      { eventId: assistantEntryId },
    ),
  ]);
  await withHome(home, async () => {
    const response = await GET(
      new Request(`http://localhost/api/sessions/${id}/entries/${assistantEntryId}/tool-result`),
      { params: Promise.resolve({ id, entryId: assistantEntryId }) },
    );
    assert.equal(response.status, 404);
  });
});

test("returns 404 for an unknown session", async () => {
  const response = await GET(
    new Request("http://localhost/api/sessions/unknown-session/entries/x/tool-result"),
    { params: Promise.resolve({ id: "unknown-session", entryId: "x" }) },
  );
  assert.equal(response.status, 404);
});
