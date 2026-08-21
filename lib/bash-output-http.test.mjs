import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createJiti } from "jiti";

const home = mkdtempSync(join(tmpdir(), "grok-bash-output-"));
const previousHome = process.env.GROK_HOME;
process.env.GROK_HOME = home;
after(() => {
  if (previousHome === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = previousHome;
});

const sessionId = "550e8400-e29b-41d4-a716-446655440001";
const outputPath = join(tmpdir(), "pi-bash-route12.log");
const dir = join(home, "sessions", encodeURIComponent("/tmp/p"), sessionId);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "summary.json"), JSON.stringify({
  info: { id: sessionId, cwd: "/tmp/p" },
  session_summary: "Root",
  created_at: "2026-08-19T00:00:00.000Z",
  updated_at: "2026-08-19T00:00:00.000Z",
}));
writeFileSync(join(dir, "updates.jsonl"), JSON.stringify({
  timestamp: 1,
  method: "session/update",
  params: {
    sessionId,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      title: "bash",
      input: { command: "printf hello" },
      fullOutputPath: outputPath,
      content: { type: "text", text: "hello" },
    },
  },
}));
writeFileSync(outputPath, "hello from disk");

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { GET } = await jiti.import("./bash-output-http.ts");

function getRequest(path = outputPath) {
  const url = new URL("http://127.0.0.1/api/agent/session/bash-output");
  url.searchParams.set("path", path);
  return new Request(url);
}

describe("GET /api/agent/[id]/bash-output", () => {
  it("authorizes a path referenced by the Grok session record", async () => {
    const response = await GET(getRequest(), { params: Promise.resolve({ id: sessionId }) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.success, true);
    assert.equal(body.data.output, "hello from disk");
  });

  it("forbids a path the session never referenced", async () => {
    const other = join(tmpdir(), "pi-bash-other99.log");
    writeFileSync(other, "nope");
    const response = await GET(getRequest(other), { params: Promise.resolve({ id: sessionId }) });
    assert.equal(response.status, 403);
  });
});
