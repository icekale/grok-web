import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { AcpConnection } from "./connection.ts";
import { JsonRpcConn } from "./jsonrpc.ts";
import {
  permissionTimedOut,
  resolvePermission,
  translatePermissionRequest,
} from "./permissions.ts";

describe("translatePermissionRequest", () => {
  it("maps a tool title and rawInput into a confirm dialog", () => {
    assert.deepEqual(translatePermissionRequest({
      toolCall: { title: "bash", rawInput: { cmd: "ls" } },
    }, 9), {
      type: "extension_ui_request",
      id: "9",
      method: "confirm",
      title: "Allow tool",
      message: "bash {\"cmd\":\"ls\"}",
    });
  });

  it("falls back to kind, then tool, and prefers rawInput over input", () => {
    assert.equal(translatePermissionRequest({
      toolCall: { kind: "execute", input: { a: 1 }, rawInput: { b: 2 } },
    }, 1).message, "execute {\"b\":2}");
    assert.equal(translatePermissionRequest({
      toolCall: { input: { path: "a.ts" } },
    }, 2).message, "tool {\"path\":\"a.ts\"}");
    assert.equal(translatePermissionRequest({}, 3).message, "tool {}");
    assert.equal(translatePermissionRequest(null, 4).message, "tool {}");
  });
});

describe("resolvePermission", () => {
  const rejected = { outcome: { outcome: "rejected" } };

  it("selects allow-once or allow_once when confirming", () => {
    assert.deepEqual(resolvePermission({ confirmed: true }, {
      options: [
        { optionId: "always", kind: "allow_always" },
        { optionId: "allow-once", name: "Once" },
      ],
    }), { outcome: { outcome: "selected", optionId: "allow-once" } });
    assert.deepEqual(resolvePermission({ confirmed: true }, {
      options: [{ id: "allow_once" }],
    }), { outcome: { outcome: "selected", optionId: "allow_once" } });
  });

  it("selects an option whose name or kind includes allow", () => {
    assert.deepEqual(resolvePermission({ confirmed: true }, {
      options: [{ optionId: "yes-please", name: "Allow once" }],
    }), { outcome: { outcome: "selected", optionId: "yes-please" } });
    assert.deepEqual(resolvePermission({ confirmed: true }, {
      options: [{ optionId: "go", kind: "allow_always" }],
    }), { outcome: { outcome: "selected", optionId: "go" } });
  });

  it("defaults to allow-once when no matching option exists", () => {
    assert.deepEqual(resolvePermission({ confirmed: true }, {
      options: [{ optionId: "reject" }],
    }), { outcome: { outcome: "selected", optionId: "allow-once" } });
    assert.deepEqual(resolvePermission({ confirmed: true }, {}), {
      outcome: { outcome: "selected", optionId: "allow-once" },
    });
  });

  it("rejects when denied or cancelled", () => {
    assert.deepEqual(resolvePermission({ confirmed: false }, {
      options: [{ optionId: "allow-once" }],
    }), rejected);
    assert.deepEqual(resolvePermission({ cancelled: true }, {
      options: [{ optionId: "allow-once" }],
    }), rejected);
  });

  it("treats a timed-out permission as rejected", () => {
    const startedAt = 1_000;
    assert.equal(permissionTimedOut(startedAt, startedAt + 60_000), true);
    assert.deepEqual(
      permissionTimedOut(startedAt, startedAt + 60_000)
        ? resolvePermission({ cancelled: true }, { options: [{ optionId: "allow-once" }] })
        : resolvePermission({ confirmed: true }, { options: [{ optionId: "allow-once" }] }),
      rejected,
    );
  });
});

describe("permissionTimedOut", () => {
  it("uses an injected clock and default 60s timeout", () => {
    assert.equal(permissionTimedOut(0, 59_999), false);
    assert.equal(permissionTimedOut(0, 60_000), true);
    assert.equal(permissionTimedOut(1000, 1499, 500), false);
    assert.equal(permissionTimedOut(1000, 1500, 500), true);
  });
});

describe("AcpConnection permissions", () => {
  it("emits a confirm request and responds when completed", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const acp = new AcpConnection(new JsonRpcConn({ stdin, stdout }));
    const events = [];
    acp.onPermission((event) => events.push(event));
    stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 42,
      method: "session/request_permission",
      params: {
        toolCall: { title: "bash", rawInput: { cmd: "ls" } },
        options: [{ optionId: "allow-once" }],
      },
    })}\n`);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(events[0], {
      type: "extension_ui_request",
      id: "42",
      method: "confirm",
      title: "Allow tool",
      message: "bash {\"cmd\":\"ls\"}",
    });
    const chunks = [];
    stdin.on("data", (c) => chunks.push(String(c)));
    acp.completePermission("42", { confirmed: true });
    await new Promise((r) => setImmediate(r));
    const sent = JSON.parse(chunks.join("").trim());
    assert.equal(sent.jsonrpc, "2.0");
    assert.equal(sent.id, 42);
    assert.deepEqual(sent.result, { outcome: { outcome: "selected", optionId: "allow-once" } });
  });

  it("responds with rejected when the confirm is denied", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const acp = new AcpConnection(new JsonRpcConn({ stdin, stdout }));
    acp.onPermission(() => {});
    stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 8,
      method: "session/request_permission",
      params: { toolCall: { title: "write" } },
    })}\n`);
    await new Promise((r) => setImmediate(r));
    const chunks = [];
    stdin.on("data", (c) => chunks.push(String(c)));
    acp.completePermission("8", { confirmed: false });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(JSON.parse(chunks.join("").trim()).result, {
      outcome: { outcome: "rejected" },
    });
  });
});
