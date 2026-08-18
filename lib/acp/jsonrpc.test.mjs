import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { JsonRpcConn } from "./jsonrpc.ts";

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
});
