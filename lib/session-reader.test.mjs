import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createJiti } from "jiti";

const home = mkdtempSync(join(tmpdir(), "grok-session-reader-"));
const previousHome = process.env.GROK_HOME;
process.env.GROK_HOME = home;
after(() => {
  if (previousHome === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = previousHome;
});

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { getSessionEntries, resolveSessionPath } = await jiti.import("./session-reader.ts");

function updateLine(update, meta = {}) {
  return JSON.stringify({
    timestamp: 1,
    method: "session/update",
    params: { sessionId: "s", update, _meta: meta },
  });
}

describe("getSessionEntries", () => {
  it("reads Grok updates.jsonl and exposes bash fullOutputPath entries", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    const dir = join(home, "sessions", encodeURIComponent("/tmp/p"), id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "summary.json"), JSON.stringify({
      info: { id, cwd: "/tmp/p" },
      session_summary: "Root",
      created_at: "2026-08-19T00:00:00.000Z",
      updated_at: "2026-08-19T00:00:00.000Z",
    }));
    const outputPath = join(tmpdir(), "pi-bash-ab12.log");
    writeFileSync(join(dir, "updates.jsonl"), [
      updateLine({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "run it" } }, { eventId: "u1" }),
      updateLine({
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "bash",
        input: { command: "printf test" },
      }, { eventId: "a1" }),
      updateLine({
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        content: { type: "text", text: "test" },
        fullOutputPath: outputPath,
        status: "completed",
      }),
    ].join("\n"));

    const entries = getSessionEntries(dir);
    assert.ok(entries.some((entry) => entry.type === "message" && entry.message.role === "user"));
    const bash = entries.find((entry) => (
      entry.type === "message" && entry.message.role === "bashExecution"
    ));
    assert.ok(bash);
    assert.equal(bash.message.fullOutputPath, outputPath);
    assert.equal(bash.message.command, "printf test");
  });

  it("reads native session.jsonl message entries", () => {
    const filePath = join(home, "legacy-session.jsonl");
    writeFileSync(filePath, `${JSON.stringify({
      type: "message",
      id: "bash-1",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: "bashExecution",
        command: "printf test",
        output: "test",
        fullOutputPath: "/tmp/pi-bash-legacy.log",
      },
    })}\n`);
    const entries = getSessionEntries(filePath);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].message.fullOutputPath, "/tmp/pi-bash-legacy.log");
  });

  it("resolves a Grok session directory from its id", async () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    const path = await resolveSessionPath(id);
    assert.ok(path);
    assert.ok(path.endsWith(id));
  });
});
