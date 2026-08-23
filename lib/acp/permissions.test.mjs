import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { AcpConnection } from "./connection.ts";
import { JsonRpcConn } from "./jsonrpc.ts";
import {
  permissionTimedOut,
  resolvePermission,
  translatePermissionRequest,
} from "./permissions.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("translatePermissionRequest", () => {
  it("uses an Execute title and the command body, not Allow tool or JSON", () => {
    assert.deepEqual(translatePermissionRequest({
      toolCall: { title: "bash", rawInput: { cmd: "ls" } },
    }, 9), {
      type: "extension_ui_request",
      id: "9",
      method: "confirm",
      title: "Execute `ls`",
      message: "ls",
    });
  });

  it("translates only safe permission options", () => {
    const ui = translatePermissionRequest({
      toolCall: {
        title: "Allow bash",
        rawInput: { command: "git status", secret: "do-not-display" },
      },
      options: [
        { optionId: "allow-once", label: "Allow once", kind: "allow_once", rawInput: "secret" },
        { id: "reject-once", name: "Reject", kind: "reject_once", token: "secret" },
        { id: 42, label: "bad" },
      ],
    }, 7);
    assert.deepEqual(ui.options, [
      { id: "allow-once", label: "Allow once", kind: "allow_once" },
      { id: "reject-once", label: "Reject", kind: "reject_once" },
    ]);
    assert.doesNotMatch(JSON.stringify(ui), /do-not-display|secret/);
  });

  it("keeps an ACP Execute title and shows the terminal command", () => {
    const request = JSON.parse(readFileSync(join(fixtures, "permission-bash.json"), "utf8"));
    const ui = translatePermissionRequest(request, 1);
    assert.equal(ui.title, "Execute `ls -la ~/.grok`");
    assert.equal(ui.message, "ls -la ~/.grok");
    assert.equal(ui.title.includes("Allow tool"), false);
    assert.equal(ui.message.includes("{"), false);
  });

  it("shows a Read title and path instead of a JSON blob", () => {
    const request = JSON.parse(readFileSync(join(fixtures, "permission-read.json"), "utf8"));
    const ui = translatePermissionRequest(request, 2);
    assert.equal(ui.title, "Read `/tmp/a.ts`");
    assert.equal(ui.message, "/tmp/a.ts");
    assert.equal(ui.message.includes("{"), false);
  });

  it("falls back to a one-line tool name without stringifying input", () => {
    assert.equal(translatePermissionRequest({
      toolCall: { kind: "execute", input: { a: 1 }, rawInput: { b: 2 } },
    }, 1).message, "bash");
    assert.equal(translatePermissionRequest({
      toolCall: { input: { path: "a.ts" } },
    }, 2).title, "Read `a.ts`");
    assert.equal(translatePermissionRequest({
      toolCall: { input: { path: "a.ts" } },
    }, 2).message, "a.ts");
    const empty = translatePermissionRequest({}, 3);
    assert.equal(empty.title, "tool");
    assert.equal(empty.message, "tool");
    assert.equal(empty.message.includes("{"), false);
    assert.equal(translatePermissionRequest(null, 4).message, "tool");
  });

  it("labels exit_plan_mode as an explicit plan approval", () => {
    const ui = translatePermissionRequest({
      toolCall: { title: "exit_plan_mode", rawInput: { content: "Implement the approved plan" } },
    }, 6);
    assert.equal(ui.title, "Approve plan");
    assert.equal(ui.message, "Implement the approved plan");
  });
  it("keeps a human ACP title that already has backticks", () => {
    const ui = translatePermissionRequest({
      toolCall: { title: "Execute `git status`", rawInput: { command: "git status" } },
    }, 5);
    assert.equal(ui.title, "Execute `git status`");
    assert.equal(ui.message, "git status");
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
    const request = { options: [{ optionId: "allow-once" }] };
    assert.deepEqual(
      resolvePermission({ confirmed: true }, request, {
        startedAt,
        now: startedAt + 60_000,
      }),
      rejected,
    );
    assert.deepEqual(
      resolvePermission({ confirmed: true }, request, {
        startedAt,
        now: startedAt + 59_999,
      }),
      { outcome: { outcome: "selected", optionId: "allow-once" } },
    );
    assert.deepEqual(
      resolvePermission({ confirmed: true }, request, {
        startedAt,
        now: startedAt + 10,
        timeoutMs: 10,
      }),
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
        sessionId: "session-42",
        toolCall: { title: "bash", rawInput: { cmd: "ls" } },
        options: [{ optionId: "allow-once" }],
      },
    })}\n`);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(events[0], {
      type: "extension_ui_request",
      id: "42",
      method: "confirm",
      title: "Execute `ls`",
      message: "ls",
      options: [{ id: "allow-once", label: "allow-once", kind: "allow-once" }],
      sessionId: "session-42",
    });
    const chunks = [];
    stdin.on("data", (c) => chunks.push(String(c)));
    acp.completePermission("session-42", "42", { confirmed: true });
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
      params: { sessionId: "session-8", toolCall: { title: "write" } },
    })}\n`);
    await new Promise((r) => setImmediate(r));
    const chunks = [];
    stdin.on("data", (c) => chunks.push(String(c)));
    acp.completePermission("session-8", "8", { confirmed: false });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(JSON.parse(chunks.join("").trim()).result, {
      outcome: { outcome: "rejected" },
    });
  });
});
