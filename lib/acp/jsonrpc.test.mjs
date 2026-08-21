import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { JsonRpcConn, JsonRpcConnectionClosedError } from "./jsonrpc.ts";

describe("JsonRpcConn", () => {
  it("sends a request and resolves the matching response", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const conn = new JsonRpcConn({ stdin, stdout });
    const chunks = [];
    stdin.on("data", (c) => chunks.push(String(c)));
    const pending = conn.request("initialize", { protocolVersion: 1 });
    await new Promise((r) => setImmediate(r));
    const sent = JSON.parse(chunks.join("").trim());
    assert.equal(sent.method, "initialize");
    assert.equal(sent.jsonrpc, "2.0");
    assert.ok(typeof sent.id === "number");
    stdout.write(JSON.stringify({ jsonrpc: "2.0", id: sent.id, result: { ok: true } }) + "\n");
    assert.deepEqual(await pending, { ok: true });
  });

  it("emits notifications without an id", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const conn = new JsonRpcConn({ stdin, stdout });
    const notes = [];
    conn.onNotification((method, params) => notes.push({ method, params }));
    stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk" } },
    }) + "\n");
    await new Promise((r) => setImmediate(r));
    assert.equal(notes[0].method, "session/update");
    assert.equal(notes[0].params.sessionId, "s1");
  });

  it("rejects when the peer returns an error", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const conn = new JsonRpcConn({ stdin, stdout });
    const pending = conn.request("session/load", { sessionId: "missing" });
    await new Promise((r) => setImmediate(r));
    const sent = JSON.parse(String(await new Promise((r) => stdin.once("data", r))));
    stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: sent.id,
      error: { code: -32000, message: "session not found" },
    }) + "\n");
    await assert.rejects(pending, /session not found/);
  });

  it("keeps inbound request ids and writes a matching response", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const conn = new JsonRpcConn({ stdin, stdout });
    const notes = [];
    conn.onNotification((method, params, id) => notes.push({ method, params, id }));
    stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "session/request_permission",
      params: { x: 1 },
    }) + "\n");
    await new Promise((r) => setImmediate(r));
    assert.equal(notes[0].method, "session/request_permission");
    assert.deepEqual(notes[0].params, { x: 1 });
    assert.equal(notes[0].id, 7);
    const chunks = [];
    stdin.on("data", (c) => chunks.push(String(c)));
    conn.respond(7, { ok: true });
    await new Promise((r) => setImmediate(r));
    const sent = JSON.parse(chunks.join("").trim());
    assert.equal(sent.jsonrpc, "2.0");
    assert.equal(sent.id, 7);
    assert.deepEqual(sent.result, { ok: true });
  });

  it("keeps inbound string request ids so the client can answer them", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const conn = new JsonRpcConn({ stdin, stdout });
    const notes = [];
    conn.onNotification((method, params, id) => notes.push({ method, params, id }));
    stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: "fs-1",
      method: "fs/read_text_file",
      params: { path: "/tmp/a.txt" },
    })}\n`);
    await new Promise((r) => setImmediate(r));
    assert.equal(notes[0].method, "fs/read_text_file");
    assert.equal(notes[0].id, "fs-1");
    const chunks = [];
    stdin.on("data", (c) => chunks.push(String(c)));
    conn.respond("fs-1", { content: "hi" });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(JSON.parse(chunks.join("").trim()), {
      jsonrpc: "2.0",
      id: "fs-1",
      result: { content: "hi" },
    });
  });

  it("dispatches inbound requests even when the id matches a pending outbound request", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const conn = new JsonRpcConn({ stdin, stdout });
    const notes = [];
    conn.onNotification((method, params, id) => notes.push({ method, params, id }));
    const pending = conn.request("session/prompt");
    await new Promise((r) => setImmediate(r));
    const sent = JSON.parse(String(await new Promise((r) => stdin.once("data", r))));
    stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: sent.id,
      method: "session/request_permission",
      params: {},
    }) + "\n");
    await new Promise((r) => setImmediate(r));
    assert.equal(notes[0].method, "session/request_permission");
    assert.equal(notes[0].id, sent.id);
    stdout.write(JSON.stringify({ jsonrpc: "2.0", id: sent.id, result: { done: true } }) + "\n");
    assert.deepEqual(await pending, { done: true });
  });

  it("rejects every pending request and future request on stdout EOF", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const conn = new JsonRpcConn({ stdin, stdout });
    const first = conn.request("one");
    const second = conn.request("two");
    stdout.end();

    const errors = await Promise.all([
      first.catch((error) => error),
      second.catch((error) => error),
      conn.request("three").catch((error) => error),
    ]);
    assert.ok(errors.every((error) => error instanceof JsonRpcConnectionClosedError));
    assert.ok(errors.every((error) => error.message === "ACP JSON-RPC connection closed"));
    assert.strictEqual(errors[0], errors[1]);
    assert.strictEqual(errors[1], errors[2]);
  });

  it("closes on stdin EPIPE and prevents later writes", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const conn = new JsonRpcConn({ stdin, stdout });
    const pending = conn.request("waiting");
    const epipe = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
    stdin.emit("error", epipe);

    await assert.rejects(pending, JsonRpcConnectionClosedError);
    assert.throws(() => conn.notify("later"), JsonRpcConnectionClosedError);
    assert.throws(() => conn.respond(1, {}), JsonRpcConnectionClosedError);
  });

  it("closes and cleans listeners on standalone stdout close", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const conn = new JsonRpcConn({ stdin, stdout });
    const pending = conn.request("waiting");
    try {
      stdout.emit("close");
      await assert.rejects(pending, JsonRpcConnectionClosedError);
      assert.equal(stdin.destroyed, true);
      assert.equal(stdout.destroyed, true);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(stdin.listenerCount("error"), 0);
      assert.equal(stdout.listenerCount("error"), 0);
      assert.equal(stdin.listenerCount("close"), 0);
      assert.equal(stdout.listenerCount("close"), 0);
    } finally {
      stdin.destroy();
      stdout.destroy();
    }
  });

  it("closes and cleans listeners on standalone stdout error", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const conn = new JsonRpcConn({ stdin, stdout });
    const pending = conn.request("waiting");
    try {
      stdout.emit("error", new Error("stdout failed"));
      await assert.rejects(pending, JsonRpcConnectionClosedError);
      assert.equal(stdin.destroyed, true);
      assert.equal(stdout.destroyed, true);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(stdin.listenerCount("error"), 0);
      assert.equal(stdout.listenerCount("error"), 0);
      assert.equal(stdin.listenerCount("close"), 0);
      assert.equal(stdout.listenerCount("close"), 0);
    } finally {
      stdin.destroy();
      stdout.destroy();
    }
  });

  it("explicit and duplicate close reject each pending request exactly once", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const conn = new JsonRpcConn({ stdin, stdout });
    let rejectionCount = 0;
    const pending = conn.request("waiting").catch((error) => {
      rejectionCount += 1;
      throw error;
    });

    conn.close();
    conn.close();
    stdout.emit("close");
    await assert.rejects(pending, JsonRpcConnectionClosedError);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(rejectionCount, 1);
  });

  it("absorbs a child-process EPIPE that arrives after explicit close", async () => {
    const moduleUrl = new URL("./jsonrpc.ts", import.meta.url).href;
    const script = `
      import { spawn } from "node:child_process";
      import { JsonRpcConn } from ${JSON.stringify(moduleUrl)};
      const peer = spawn(process.execPath, ["-e", "process.exit(0)"], {
        stdio: ["pipe", "pipe", "ignore"],
      });
      const conn = new JsonRpcConn({ stdin: peer.stdin, stdout: peer.stdout });
      const pending = conn.request("large", { payload: "x".repeat(16 * 1024 * 1024) });
      conn.close();
      await pending.catch(() => {});
      await new Promise((resolve) => peer.once("close", resolve));
      await new Promise((resolve) => setTimeout(resolve, 20));
    `;
    const child = spawn(process.execPath, [
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      script,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const code = await new Promise((resolve) => child.once("close", resolve));
    assert.equal(code, 0, stderr);
  });
});
