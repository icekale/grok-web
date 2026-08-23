import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

function startFixture() {
  const root = mkdtempSync(join(tmpdir(), "grok-web-acp-fixture-test-"));
  const logPath = join(root, "fixture.log");
  const controlPath = join(root, "control");
  const child = spawn(process.execPath, [fileURLToPath(new URL("../e2e/fixtures/acp-agent.mjs", import.meta.url))], {
    env: {
      ...process.env,
      GROK_WEB_ACP_FIXTURE_LOG: logPath,
      GROK_WEB_ACP_FIXTURE_CONTROL: controlPath,
      GROK_WEB_ACP_FIXTURE_TEST_ID: "fixture-contract",
      GROK_WEB_ACP_FIXTURE_ROOTS: JSON.stringify({ "/tmp/project-a": "<project-a>", "/tmp/project-b": "<project-b>" }),
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let buffer = "";
  const messages = [];
  child.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) messages.push(JSON.parse(line));
  });
  let id = 0;
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const waitFor = (predicate, label) => new Promise((resolve, reject) => {
    const deadline = Date.now() + 2_000;
    const timer = setInterval(() => {
      const found = messages.find(predicate);
      if (found) {
        clearInterval(timer);
        resolve(found);
      } else if (Date.now() >= deadline) {
        clearInterval(timer);
        reject(new Error(`fixture timeout: ${label}`));
      }
    }, 5);
  });
  const request = async (method, params = {}) => {
    const requestId = ++id;
    send({ jsonrpc: "2.0", id: requestId, method, params });
    const message = await waitFor((candidate) => candidate.id === requestId && ("result" in candidate || "error" in candidate), method);
    if (message.error) {
      const error = new Error(message.error.message);
      error.code = message.error.code;
      throw error;
    }
    return message.result;
  };
  return { child, controlPath, logPath, messages, request, send, waitFor };
}

test("general ACP fixture is a fail-unknown, controllable JSON-RPC peer with safe logs", async () => {
  const fixture = startFixture();
  try {
    await fixture.request("initialize", { protocolVersion: 1 });
    const a = await fixture.request("session/new", { cwd: "/tmp/project-a", mcpServers: [] });
    const b = await fixture.request("session/new", { cwd: "/tmp/project-b", mcpServers: [] });
    assert.notEqual(a.sessionId, b.sessionId);

    await assert.rejects(fixture.request("unknown/method", {}), (error) => error.code === -32601);

    const pausedPrompt = fixture.request("session/prompt", {
      sessionId: a.sessionId,
      prompt: [{ type: "text", text: "E2E_PAUSE" }],
    });
    await fixture.waitFor((message) => message.method === "session/update" && message.params?.update?.content?.text === "E2E_PAR", "paused output");
    writeFileSync(fixture.controlPath, "release\n");
    assert.equal((await pausedPrompt).stopReason, "end_turn");

    const approvalPrompt = fixture.request("session/prompt", {
      sessionId: b.sessionId,
      prompt: [{ type: "text", text: "E2E_APPROVAL" }],
    });
    const permission = await fixture.waitFor((message) => message.method === "session/request_permission", "permission request");
    assert.equal(permission.params.sessionId, b.sessionId);
    fixture.send({ jsonrpc: "2.0", id: permission.id, result: { outcome: { outcome: "selected", optionId: "allow-once" } } });
    assert.equal((await approvalPrompt).stopReason, "end_turn");

    const entries = readFileSync(fixture.logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(entries.length > 0);
    for (const entry of entries) {
      assert.deepEqual(Object.keys(entry).sort(), ["cwdAlias", "method", "sessionId", "testId", "timestamp"]);
      assert.doesNotMatch(JSON.stringify(entry), /api.?key|password|token|secret/i);
      assert.notEqual(entry.cwdAlias, "/tmp/project-a");
      assert.notEqual(entry.cwdAlias, "/tmp/project-b");
    }
    assert.ok(entries.some((entry) => entry.cwdAlias === "<project-a>"));
    assert.ok(entries.some((entry) => entry.cwdAlias === "<project-b>"));
  } finally {
    fixture.child.kill();
    await once(fixture.child, "exit").catch(() => {});
  }
});
