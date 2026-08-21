import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { pinSession } from "./app-meta.ts";
import { historyUserText, mapUpdatesJsonl } from "./history-map.ts";
import { autoNameSession, deleteSession, getSessionContext, getSessionDetail, getSessionState, getSessions, getThinking, patchSession, postMeta, titleFromHistory } from "./session-http.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "acp/fixtures");

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

  it("DELETE removes the session directory", async () => {
    const home = await mkdtemp(join(tmpdir(), "grok-api-del-"));
    const prev = process.env.GROK_HOME;
    process.env.GROK_HOME = home;
    try {
      const id = "01jjjjjjjjjjjjjjjjjjjjjjjj";
      const dir = join(home, "sessions", encodeURIComponent("/tmp/p"), id);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "summary.json"), JSON.stringify({
        info: { id, cwd: "/tmp/p" },
        session_summary: "Bye",
        created_at: "2026-08-19T00:00:00.000Z",
        updated_at: "2026-08-19T00:00:00.000Z",
        generated_title: "Bye",
      }));
      const res = await deleteSession(id);
      assert.equal(res.status, 200);
      assert.equal(existsSync(dir), false);
      const missing = await deleteSession(id);
      assert.equal(missing.status, 404);
    } finally {
      if (prev === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = prev;
    }
  });

  it("PATCH writes generated_title and rejects reserved subagent names", async () => {
    const home = await mkdtemp(join(tmpdir(), "grok-api-rename-"));
    const prev = process.env.GROK_HOME;
    process.env.GROK_HOME = home;
    try {
      const id = "01kkkkkkkkkkkkkkkkkkkkkkkk";
      const dir = join(home, "sessions", encodeURIComponent("/tmp/p"), id);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "summary.json"), JSON.stringify({
        info: { id, cwd: "/tmp/p" },
        session_summary: "Old",
        created_at: "2026-08-19T00:00:00.000Z",
        updated_at: "2026-08-19T00:00:00.000Z",
        generated_title: "Old",
      }));
      const reserved = await patchSession(new Request("http://127.0.0.1/api/sessions/" + id, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "subagent-worker-317e1ca0-1" }),
      }), id);
      assert.equal(reserved.status, 409);
      const res = await patchSession(new Request("http://127.0.0.1/api/sessions/" + id, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "New title" }),
      }), id);
      assert.equal(res.status, 200);
      const saved = JSON.parse(await readFile(join(dir, "summary.json"), "utf8"));
      assert.equal(saved.generated_title, "New title");
      const listed = await getSessions(new Request("http://127.0.0.1/api/sessions"));
      assert.equal((await listed.json()).sessions[0].name, "New title");
    } finally {
      if (prev === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = prev;
    }
  });

  it("titles image user prompts from ACP history text, not as empty", () => {
    const { messages } = mapUpdatesJsonl(readFileSync(join(fixtures, "user-image.jsonl"), "utf8"));
    assert.equal(titleFromHistory(messages), "look");
    assert.ok(messages.some((message) => (
      message.role === "user" && historyUserText(message.content).trim().length > 0
    )));
  });

  it("POST auto-name titles the session from the first user message", async () => {
    const home = await mkdtemp(join(tmpdir(), "grok-api-autoname-"));
    const prev = process.env.GROK_HOME;
    process.env.GROK_HOME = home;
    try {
      const id = "01llllllllllllllllllllllll";
      const dir = join(home, "sessions", encodeURIComponent("/tmp/p"), id);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "summary.json"), JSON.stringify({
        info: { id, cwd: "/tmp/p" },
        session_summary: "Old",
        created_at: "2026-08-19T00:00:00.000Z",
        updated_at: "2026-08-19T00:00:00.000Z",
        generated_title: "Old",
      }));
      await writeFile(join(dir, "updates.jsonl"), [
        updateLine({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "  Design\n  grok-web  " } }, { eventId: "e1" }),
        updateLine({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Ok" } }, { eventId: "e2" }),
      ].join("\n"));
      const missing = await autoNameSession("missing");
      assert.equal(missing.status, 404);
      const res = await autoNameSession(id);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.title, "Design grok-web");
      const saved = JSON.parse(await readFile(join(dir, "summary.json"), "utf8"));
      assert.equal(saved.generated_title, "Design grok-web");
    } finally {
      if (prev === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = prev;
    }
  });

  it("POST auto-name rejects empty and subagent sessions", async () => {
    const home = await mkdtemp(join(tmpdir(), "grok-api-autoname-empty-"));
    const prev = process.env.GROK_HOME;
    process.env.GROK_HOME = home;
    try {
      const emptyId = "01mmmmmmmmmmmmmmmmmmmmmmmm";
      const childId = "01nnnnnnnnnnnnnnnnnnnnnnnn";
      const emptyDir = join(home, "sessions", encodeURIComponent("/tmp/p"), emptyId);
      const childDir = join(home, "sessions", encodeURIComponent("/tmp/wt"), childId);
      await mkdir(emptyDir, { recursive: true });
      await mkdir(childDir, { recursive: true });
      await writeFile(join(emptyDir, "summary.json"), JSON.stringify({
        info: { id: emptyId, cwd: "/tmp/p" },
        session_summary: "",
        created_at: "2026-08-19T00:00:00.000Z",
        updated_at: "2026-08-19T00:00:00.000Z",
      }));
      await writeFile(join(childDir, "summary.json"), JSON.stringify({
        info: { id: childId, cwd: "/tmp/wt" },
        session_kind: "subagent",
        session_summary: "Child",
        created_at: "2026-08-19T00:00:00.000Z",
        updated_at: "2026-08-19T00:00:00.000Z",
        generated_title: "Child",
      }));
      await writeFile(join(childDir, "updates.jsonl"), updateLine(
        { sessionUpdate: "user_message_chunk", content: { type: "text", text: "do work" } },
        { eventId: "e1" },
      ));
      const empty = await autoNameSession(emptyId);
      assert.equal(empty.status, 400);
      const child = await autoNameSession(childId);
      assert.equal(child.status, 409);
    } finally {
      if (prev === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = prev;
    }
  });

  it("GET state does not start a Pi SessionManager and returns ACP or idle state", async () => {
    const home = await mkdtemp(join(tmpdir(), "grok-api-state-"));
    const prev = process.env.GROK_HOME;
    process.env.GROK_HOME = home;
    try {
      const id = "01oooooooooooooooooooooooo";
      const dir = join(home, "sessions", encodeURIComponent("/tmp/p"), id);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "summary.json"), JSON.stringify({
        info: { id, cwd: "/tmp/p" },
        session_summary: "Hi",
        created_at: "2026-08-19T00:00:00.000Z",
        updated_at: "2026-08-19T00:00:00.000Z",
        generated_title: "Hi",
      }));
      const missing = await getSessionState(new Request("http://127.0.0.1/api/sessions/missing/state"), "missing");
      assert.equal(missing.status, 404);
      const res = await getSessionState(new Request(`http://127.0.0.1/api/sessions/${id}/state`), id);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.running, false);
      assert.deepEqual(body.state.queuedMessages, { steering: [], followUp: [] });
    } finally {
      if (prev === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = prev;
    }
  });
});

describe("GET /api/sessions/:id/entries/:entryId/thinking", () => {
  it("returns the thinking block from updates.jsonl", async () => {
    const home = await mkdtemp(join(tmpdir(), "grok-api-think-"));
    const prev = process.env.GROK_HOME;
    process.env.GROK_HOME = home;
    try {
      const id = "01rrrrrrrrrrrrrrrrrrrrrrrr";
      const dir = join(home, "sessions", encodeURIComponent("/tmp/p"), id);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "summary.json"), JSON.stringify({
        info: { id, cwd: "/tmp/p" },
        session_summary: "Think",
        created_at: "2026-08-19T00:00:00.000Z",
        updated_at: "2026-08-19T00:00:00.000Z",
        generated_title: "Think",
      }));
      await writeFile(join(dir, "updates.jsonl"), [
        updateLine({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "secret plan" } }, { eventId: "e-think" }),
        updateLine({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } }, { eventId: "e-think" }),
      ].join("\n"));
      const missing = await getThinking(
        new Request("http://127.0.0.1/api/sessions/missing/entries/e-think/thinking?blockIndex=0"),
        "missing",
        "e-think",
      );
      assert.equal(missing.status, 404);
      const badIndex = await getThinking(
        new Request(`http://127.0.0.1/api/sessions/${id}/entries/e-think/thinking`),
        id,
        "e-think",
      );
      assert.equal(badIndex.status, 400);
      const res = await getThinking(
        new Request(`http://127.0.0.1/api/sessions/${id}/entries/e-think/thinking?blockIndex=0`),
        id,
        "e-think",
      );
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { thinking: "secret plan" });
      const textBlock = await getThinking(
        new Request(`http://127.0.0.1/api/sessions/${id}/entries/e-think/thinking?blockIndex=1`),
        id,
        "e-think",
      );
      assert.equal(textBlock.status, 404);
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
