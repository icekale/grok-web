import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pinSession } from "./app-meta.ts";
import { getSessionContext, getSessionDetail, getSessions, postMeta } from "./session-http.ts";

describe("GET /api/sessions", () => {
  it("lists fixture sessions from GROK_HOME", async () => {
    const home = await mkdtemp(join(tmpdir(), "grok-api-"));
    const prev = process.env.GROK_HOME;
    process.env.GROK_HOME = home;
    try {
      const id = "01dddddddddddddddddddddddd";
      const dir = join(home, "sessions", encodeURIComponent("/tmp/p"), id);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "summary.json"), JSON.stringify({
        info: { id, cwd: "/tmp/p" },
        session_summary: "Hello",
        created_at: "2026-08-18T13:00:00.000Z",
        updated_at: "2026-08-18T13:00:00.000Z",
        num_chat_messages: 1,
        generated_title: "Hello",
      }));
      const res = await getSessions(new Request("http://127.0.0.1/api/sessions"));
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.sessions[0].id, id);
      assert.equal(body.sessions[0].cwd, "/tmp/p");
      assert.deepEqual(body.runningSessionIds, []);
    } finally {
      if (prev === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = prev;
    }
  });

  it("omits subagent sessions from the sidebar list but still finds them by id", async () => {
    const home = await mkdtemp(join(tmpdir(), "grok-api-hide-sub-"));
    const prev = process.env.GROK_HOME;
    process.env.GROK_HOME = home;
    try {
      const rootId = "01hhhhhhhhhhhhhhhhhhhhhhhh";
      const childId = "01iiiiiiiiiiiiiiiiiiiiiiii";
      const rootDir = join(home, "sessions", encodeURIComponent("/tmp/p"), rootId);
      const childDir = join(home, "sessions", encodeURIComponent("/tmp/wt"), childId);
      await mkdir(rootDir, { recursive: true });
      await mkdir(childDir, { recursive: true });
      await writeFile(join(rootDir, "summary.json"), JSON.stringify({
        info: { id: rootId, cwd: "/tmp/p" },
        session_summary: "Root",
        created_at: "2026-08-19T00:00:00.000Z",
        updated_at: "2026-08-19T00:00:00.000Z",
        generated_title: "Root",
      }));
      await writeFile(join(childDir, "summary.json"), JSON.stringify({
        info: { id: childId, cwd: "/tmp/wt" },
        session_kind: "subagent",
        session_summary: "Child",
        created_at: "2026-08-19T00:00:00.000Z",
        updated_at: "2026-08-19T00:00:00.000Z",
        generated_title: "Child",
      }));
      const res = await getSessions(new Request("http://127.0.0.1/api/sessions"));
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.deepEqual(body.sessions.map((session) => session.id), [rootId]);
      const detail = await getSessionDetail(new Request(`http://127.0.0.1/api/sessions/${childId}`), childId);
      assert.equal(detail.status, 200);
      assert.equal((await detail.json()).sessionId, childId);
    } finally {
      if (prev === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = prev;
    }
  });

  it("includes meta pinnedIds and archivedIds", async () => {
    const home = await mkdtemp(join(tmpdir(), "grok-api-meta-"));
    const prev = process.env.GROK_HOME;
    process.env.GROK_HOME = home;
    try {
      await pinSession("01dddddddddddddddddddddddd", true);
      const res = await getSessions(new Request("http://127.0.0.1/api/sessions"));
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.deepEqual(body.meta, {
        pinnedIds: ["01dddddddddddddddddddddddd"],
        archivedIds: [],
      });
    } finally {
      if (prev === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = prev;
    }
  });
});

function updateLine(update, meta = {}) {
  return JSON.stringify({
    timestamp: 1,
    method: "session/update",
    params: { sessionId: "s", update, _meta: meta },
  });
}

describe("GET /api/sessions/:id/context", () => {
  it("maps updates.jsonl into messages and entryIds", async () => {
    const home = await mkdtemp(join(tmpdir(), "grok-api-ctx-"));
    const prev = process.env.GROK_HOME;
    process.env.GROK_HOME = home;
    try {
      const id = "01eeeeeeeeeeeeeeeeeeeeeeee";
      const dir = join(home, "sessions", encodeURIComponent("/tmp/p"), id);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "summary.json"), JSON.stringify({
        info: { id, cwd: "/tmp/p" },
        session_summary: "Hi",
        created_at: "2026-08-18T13:00:00.000Z",
        updated_at: "2026-08-18T13:00:00.000Z",
        num_chat_messages: 2,
        generated_title: "Hi",
      }));
      await writeFile(join(dir, "updates.jsonl"), [
        updateLine({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Hi" } }, { eventId: "e1" }),
        updateLine({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Yo" } }, { eventId: "e2", modelId: "grok-4.6" }),
      ].join("\n"));
      const res = await getSessionContext(new Request(`http://127.0.0.1/api/sessions/${id}/context`), id);
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.context.messages.length, 2);
      assert.equal(body.context.messages[0].role, "user");
      assert.equal(body.context.messages[0].content, "Hi");
      assert.equal(body.context.messages[1].role, "assistant");
      assert.deepEqual(body.context.messages[1].content, [{ type: "text", text: "Yo" }]);
      assert.deepEqual(body.context.entryIds, ["e1", "e2"]);
    } finally {
      if (prev === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = prev;
    }
  });

  it("returns 404 when the session is missing", async () => {
    const home = await mkdtemp(join(tmpdir(), "grok-api-404-"));
    const prev = process.env.GROK_HOME;
    process.env.GROK_HOME = home;
    try {
      const res = await getSessionContext(
        new Request("http://127.0.0.1/api/sessions/missing/context"),
        "missing",
      );
      assert.equal(res.status, 404);
    } finally {
      if (prev === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = prev;
    }
  });
});

describe("GET /api/sessions/:id", () => {
  it("maps updates.jsonl into session detail context.messages", async () => {
    const home = await mkdtemp(join(tmpdir(), "grok-api-detail-"));
    const prev = process.env.GROK_HOME;
    process.env.GROK_HOME = home;
    try {
      const id = "01ffffffffffffffffffffffff";
      const dir = join(home, "sessions", encodeURIComponent("/tmp/p"), id);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "summary.json"), JSON.stringify({
        info: { id, cwd: "/tmp/p" },
        session_summary: "Hi",
        created_at: "2026-08-18T13:00:00.000Z",
        updated_at: "2026-08-18T13:00:00.000Z",
        num_chat_messages: 2,
        generated_title: "Hi",
      }));
      await writeFile(join(dir, "updates.jsonl"), [
        updateLine({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Hi" } }, { eventId: "e1" }),
        updateLine({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Yo" } }, { eventId: "e2", modelId: "grok-4.6" }),
      ].join("\n"));
      const res = await getSessionDetail(new Request(`http://127.0.0.1/api/sessions/${id}`), id);
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.sessionId, id);
      assert.equal(body.filePath, dir);
      assert.equal(body.info.path, dir);
      assert.equal(body.leafId, "e2");
      assert.deepEqual(body.tree, []);
      assert.equal(typeof body.totalActiveMs, "number");
      assert.equal(body.context.messages.length, 2);
      assert.equal(body.context.messages[0].role, "user");
      assert.equal(body.context.messages[0].content, "Hi");
      assert.equal(body.context.messages[1].role, "assistant");
      assert.deepEqual(body.context.messages[1].content, [{ type: "text", text: "Yo" }]);
      assert.deepEqual(body.context.entryIds, ["e1", "e2"]);
    } finally {
      if (prev === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = prev;
    }
  });

  it("returns 404 when the session is missing", async () => {
    const home = await mkdtemp(join(tmpdir(), "grok-api-detail-404-"));
    const prev = process.env.GROK_HOME;
    process.env.GROK_HOME = home;
    try {
      const res = await getSessionDetail(
        new Request("http://127.0.0.1/api/sessions/missing"),
        "missing",
      );
      assert.equal(res.status, 404);
    } finally {
      if (prev === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = prev;
    }
  });
});

describe("POST /api/meta", () => {
  it("pins and archives via postMeta", async () => {
    const home = await mkdtemp(join(tmpdir(), "grok-api-post-meta-"));
    const prev = process.env.GROK_HOME;
    process.env.GROK_HOME = home;
    try {
      const pinRes = await postMeta(new Request("http://127.0.0.1/api/meta", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: { id: "a", value: true } }),
      }));
      const pinBody = await pinRes.json();
      assert.equal(pinRes.status, 200);
      assert.deepEqual(pinBody.pinnedIds, ["a"]);
      assert.deepEqual(pinBody.archivedIds, []);

      const archiveRes = await postMeta(new Request("http://127.0.0.1/api/meta", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archive: { id: "b", value: true } }),
      }));
      const archiveBody = await archiveRes.json();
      assert.equal(archiveRes.status, 200);
      assert.deepEqual(archiveBody.pinnedIds, ["a"]);
      assert.deepEqual(archiveBody.archivedIds, ["b"]);

      const bothRes = await postMeta(new Request("http://127.0.0.1/api/meta", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pin: { id: "a", value: false },
          archive: { id: "a", value: true },
        }),
      }));
      const bothBody = await bothRes.json();
      assert.equal(bothRes.status, 200);
      assert.ok(!bothBody.pinnedIds.includes("a"));
      assert.ok(bothBody.archivedIds.includes("a"));
      assert.ok(bothBody.archivedIds.includes("b"));
    } finally {
      if (prev === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = prev;
    }
  });
});
