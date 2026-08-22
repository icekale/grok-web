import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import test from "node:test";

function startFixture() {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../e2e/fixtures/stage-b-acp.mjs", import.meta.url))], { stdio: ["pipe", "pipe", "inherit"] });
  let buffer = "";
  const messages = [];
  child.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    for (const line of buffer.split("\n").slice(0, -1)) messages.push(JSON.parse(line));
    buffer = buffer.split("\n").at(-1) ?? "";
  });
  let id = 0;
  const request = (method, params = {}) => {
    const requestId = ++id;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
    return new Promise(async (resolve, reject) => {
      const deadline = Date.now() + 1_000;
      while (Date.now() < deadline) {
        const found = messages.find((message) => message.id === requestId && (message.result || message.error));
        if (found) return found.error ? reject(new Error(found.error.message)) : resolve(found.result);
        await new Promise((r) => setTimeout(r, 5));
      }
      reject(new Error(`fixture timeout: ${method}`));
    });
  };
  return { child, request, messages };
}

test("stage B fixture allocates distinct cwd sessions and fails unknown methods", async () => {
  const { child, request, messages } = startFixture();
  try {
    await request("initialize");
    const a = await request("session/new", { cwd: "/tmp/stage-b-a" });
    const b = await request("session/new", { cwd: "/tmp/stage-b-b" });
    assert.notEqual(a.sessionId, b.sessionId);
    await request("_x.ai/mcp/list", { session_id: a.sessionId });
    assert.deepEqual(messages.find((message) => message.method === undefined && message.result?.servers)?.result.servers, [{ name: `mcp-${a.sessionId}`, source: "stage-b" }]);
    await assert.rejects(request("stage-b/unknown"), /Unknown method/);
  } finally {
    child.kill();
    await once(child, "exit").catch(() => {});
  }
});
