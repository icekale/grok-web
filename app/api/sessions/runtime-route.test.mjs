import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const listRoute = await readFile(new URL("./route.ts", import.meta.url), "utf8");
const detailRoute = await readFile(new URL("./[id]/route.ts", import.meta.url), "utf8");
const contextRoute = await readFile(new URL("./[id]/context/route.ts", import.meta.url), "utf8");
const stateRoute = await readFile(new URL("./[id]/state/route.ts", import.meta.url), "utf8");
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET: getSessionDetail, DELETE: deleteSession, PATCH: patchSession } = await jiti.import("./[id]/route.ts");
const { GET: getSessionState } = await jiti.import("./[id]/state/route.ts");

test("session listing delegates to getSessions", () => {
  assert.match(listRoute, /getSessions/);
  assert.match(listRoute, /export async function GET/);
});

test("session context delegates to getSessionContext", () => {
  assert.match(contextRoute, /getSessionContext/);
});

test("session detail and delete go through session-http, not Pi SessionManager", () => {
  assert.match(detailRoute, /getSessionDetail/);
  assert.match(detailRoute, /deleteSession/);
  assert.match(detailRoute, /patchSession/);
  assert.doesNotMatch(detailRoute, /SessionManager/);
  assert.doesNotMatch(detailRoute, /getRpcSession/);
});

test("session state uses getSessionState and does not start Pi", () => {
  assert.match(stateRoute, /getSessionState/);
  assert.doesNotMatch(stateRoute, /startRpcSession/);
  assert.doesNotMatch(stateRoute, /getRpcSession/);
});

test("GET detail and state 404 when the Grok session is missing", async () => {
  const home = await mkdtemp(join(tmpdir(), "grok-runtime-missing-"));
  const prev = process.env.GROK_HOME;
  process.env.GROK_HOME = home;
  try {
    const id = "missing-session";
    const detail = await getSessionDetail(new Request(`http://localhost/api/sessions/${id}`), {
      params: Promise.resolve({ id }),
    });
    const state = await getSessionState(new Request(`http://localhost/api/sessions/${id}/state`), {
      params: Promise.resolve({ id }),
    });
    assert.equal(detail.status, 404);
    assert.equal(state.status, 404);
  } finally {
    if (prev === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = prev;
  }
});

test("delete of an unknown session still returns 404", async () => {
  const response = await deleteSession(
    new Request("http://localhost/api/sessions/00000000-0000-0000-0000-000000000000", { method: "DELETE" }),
    { params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }) },
  );
  assert.equal(response.status, 404);
});

test("PATCH rename writes generated_title and rejects reserved names", async () => {
  const home = await mkdtemp(join(tmpdir(), "grok-runtime-rename-"));
  const prev = process.env.GROK_HOME;
  process.env.GROK_HOME = home;
  try {
    const id = "01pppppppppppppppppppppppp";
    const dir = join(home, "sessions", encodeURIComponent("/tmp/p"), id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "summary.json"), JSON.stringify({
      info: { id, cwd: "/tmp/p" },
      session_summary: "Old",
      created_at: "2026-08-19T00:00:00.000Z",
      updated_at: "2026-08-19T00:00:00.000Z",
      generated_title: "Old",
    }));
    const reserved = await patchSession(new Request(`http://localhost/api/sessions/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "subagent-worker-317e1ca0-1" }),
    }), { params: Promise.resolve({ id }) });
    assert.equal(reserved.status, 409);
    const renamed = await patchSession(new Request(`http://localhost/api/sessions/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Renamed" }),
    }), { params: Promise.resolve({ id }) });
    assert.equal(renamed.status, 200);
  } finally {
    if (prev === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = prev;
  }
});

test("session listing caps firstMessage without mutating the source", async () => {
  const { compactSessionForList } = await jiti.import("./route.ts");
  const source = {
    id: "long",
    path: "/tmp/long.jsonl",
    cwd: "/tmp",
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 1,
    firstMessage: "x".repeat(2_000),
  };

  const compact = compactSessionForList(source);
  assert.equal(compact.firstMessage.length, 512);
  assert.equal(source.firstMessage.length, 2_000);
  assert.equal(compactSessionForList({ ...source, firstMessage: "short" }).firstMessage, "short");
});
