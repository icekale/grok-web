import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { findGrokSession, listGrokSessions } from "./session-index.ts";

async function writeSummary(dir, body) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "summary.json"), JSON.stringify(body));
}

describe("listGrokSessions", () => {
  it("groups encoded cwd and .cwd fallback, skips corrupt sessions", async () => {
    const home = await mkdtemp(join(tmpdir(), "grok-idx-"));
    const prev = process.env.GROK_HOME;
    process.env.GROK_HOME = home;
    try {
      const id1 = "01aaaaaaaaaaaaaaaaaaaaaaaa";
      const id2 = "01bbbbbbbbbbbbbbbbbbbbbbbb";
      const id3 = "01cccccccccccccccccccccccc";
      await writeSummary(join(home, "sessions", encodeURIComponent("/tmp/demo"), id1), {
        info: { id: id1, cwd: "/tmp/demo" },
        session_summary: "Fix login",
        created_at: "2026-08-18T13:00:00.000Z",
        updated_at: "2026-08-18T13:10:00.000Z",
        last_active_at: "2026-08-18T13:20:00.000Z",
        num_chat_messages: 4,
        generated_title: "Fix login bug",
      });
      const slug = join(home, "sessions", "too-long-slug");
      await mkdir(slug, { recursive: true });
      await writeFile(join(slug, ".cwd"), "/very/long/project\n");
      await writeSummary(join(slug, id2), {
        info: { id: id2, cwd: "/ignored" },
        session_summary: "Other",
        created_at: "2026-08-18T12:00:00.000Z",
        updated_at: "2026-08-18T12:00:00.000Z",
        num_messages: 2,
      });
      await mkdir(join(home, "sessions", encodeURIComponent("/tmp/bad"), id3), { recursive: true });
      await writeFile(join(home, "sessions", encodeURIComponent("/tmp/bad"), id3, "summary.json"), "{");

      const sessions = await listGrokSessions();
      assert.equal(sessions.length, 2);
      assert.equal(sessions[0].id, id1);
      assert.equal(sessions[0].cwd, "/tmp/demo");
      assert.equal(sessions[0].name, "Fix login bug");
      assert.equal(sessions[0].modified, "2026-08-18T13:20:00.000Z");
      assert.equal(sessions[0].messageCount, 4);
      assert.equal(sessions[0].firstMessage, "Fix login");
      assert.equal(sessions[0].path, join(home, "sessions", encodeURIComponent("/tmp/demo"), id1));
      assert.equal(sessions[1].id, id2);
      assert.equal(sessions[1].cwd, "/very/long/project");
      assert.equal(sessions[1].name, "Other");
    } finally {
      if (prev === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = prev;
    }
  });
});

describe("findGrokSession", () => {
  it("returns a session by exact id or null", async () => {
    const home = await mkdtemp(join(tmpdir(), "grok-idx-find-"));
    const prev = process.env.GROK_HOME;
    process.env.GROK_HOME = home;
    try {
      const id = "01dddddddddddddddddddddddd";
      await writeSummary(join(home, "sessions", encodeURIComponent("/tmp/demo"), id), {
        info: { id, cwd: "/tmp/demo" },
        session_summary: "Find me",
        created_at: "2026-08-18T13:00:00.000Z",
        updated_at: "2026-08-18T13:10:00.000Z",
        num_chat_messages: 1,
        generated_title: "Found",
      });
      const found = await findGrokSession(id);
      assert.equal(found?.id, id);
      assert.equal(found?.name, "Found");
      assert.equal(await findGrokSession("missing"), null);
    } finally {
      if (prev === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = prev;
    }
  });
});
