# grok-web ACP Live Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 grok-web UI 上接上一个长驻 `grok agent stdio`：能新开/续聊、流式显示正文/思考/工具，并在浏览器里批准或拒绝工具。

**Architecture:** 浏览器协议不变（`POST /api/agent/new`、`POST /api/agent/:id` `{ type: "prompt" }`、SSE `/api/agent/:id/events`）。Node 里一个 ACP 进程多路复用多个 `sessionId`。适配器把 ACP `session/update` 译成现有 `message_update` / `agent_start` / `agent_end` / `prompt_done` / `extension_ui_request`。测试用假 stdio 进程，不启动真 `grok`、不打真模型。

**Tech Stack:** 现有 Node + Vite + TanStack。ACP 用本仓库的 JSON-RPC 行协议（`child_process` + 换行 JSON），不引入 `@agentclientprotocol/sdk`。权限默认询问，不传 `--always-approve`。

**本计划不做：** 排队/插话/分叉/从此处编辑、右栏文件/Git/worktree、设置登录/MCP、子代理。这些命令若 UI 仍会发出，返回明确错误，不静默吞。

规格：`docs/superpowers/specs/2026-08-18-grok-web-design.md` 第 2 期。

---

## File structure

| 路径 | 职责 |
| --- | --- |
| `lib/acp/jsonrpc.ts` | 一行一条 JSON-RPC 2.0 |
| `lib/acp/process.ts` | 解析 `grok` 路径、spawn/respawn 一个 `grok agent stdio` |
| `lib/acp/connection.ts` | initialize、request、notification、session 映射 |
| `lib/acp/map-events.ts` | ACP `sessionUpdate` → pi-web SSE 事件 |
| `lib/acp/permissions.ts` | `session/request_permission` ↔ `extension_ui_request` / `confirm` |
| `lib/acp/runtime.ts` | 取代 `startRpcSession` 的 prompt/get_state/events |
| `lib/acp/fake-agent.mjs` | 测试用假 ACP 子进程 |
| `app/api/agent/new/route.ts` | 改走 runtime |
| `app/api/agent/[id]/route.ts` | prompt / get_state / permission 回复 |
| `app/api/agent/[id]/events/route.ts` | SSE 转发 runtime 事件 |

---

### Task 1: JSON-RPC 行帧

**Files:**
- Create: `lib/acp/jsonrpc.ts`
- Test: `lib/acp/jsonrpc.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test lib/acp/jsonrpc.test.mjs`

Expected: FAIL，`JsonRpcConn` 不存在。

- [ ] **Step 3: Implement `lib/acp/jsonrpc.ts`**

```typescript
import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { createInterface } from "node:readline";

export class JsonRpcConn {
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private readonly notes = new EventEmitter();

  constructor(io: { stdin: Writable; stdout: Readable }) {
    createInterface({ input: io.stdout }).on("line", (line) => this.onLine(line));
    this.stdin = io.stdin;
  }

  private readonly stdin: Writable;

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    this.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  notify(method: string, params?: unknown): void {
    this.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  onNotification(handler: (method: string, params: unknown) => void): () => void {
    this.notes.on("n", handler);
    return () => this.notes.off("n", handler);
  }

  private onLine(line: string): void {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      const pending = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error && typeof msg.error === "object") {
        const err = msg.error as { message?: string };
        pending.reject(new Error(err.message ?? "ACP error"));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    if (typeof msg.method === "string") this.notes.emit("n", msg.method, msg.params);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test lib/acp/jsonrpc.test.mjs`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/acp/jsonrpc.ts lib/acp/jsonrpc.test.mjs
git commit -m "feat: add ACP JSON-RPC line connection"
```

---

### Task 2: 解析 grok 命令并启动进程

**Files:**
- Create: `lib/acp/process.ts`
- Test: `lib/acp/process.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resolveGrokBin, grokAgentArgs } from "./process.ts";

describe("resolveGrokBin", () => {
  it("prefers GROK_BIN when the file exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grok-bin-"));
    const bin = join(dir, "grok");
    await writeFile(bin, "#!/bin/sh\n");
    await chmod(bin, 0o755);
    const prev = process.env.GROK_BIN;
    process.env.GROK_BIN = bin;
    try {
      assert.equal(resolveGrokBin(), bin);
    } finally {
      if (prev === undefined) delete process.env.GROK_BIN;
      else process.env.GROK_BIN = prev;
    }
  });

  it("falls back to GROK_HOME/bin/grok", async () => {
    const home = await mkdtemp(join(tmpdir(), "grok-home-"));
    await mkdir(join(home, "bin"), { recursive: true });
    const bin = join(home, "bin", "grok");
    await writeFile(bin, "#!/bin/sh\n");
    await chmod(bin, 0o755);
    const prevHome = process.env.GROK_HOME;
    const prevBin = process.env.GROK_BIN;
    delete process.env.GROK_BIN;
    process.env.GROK_HOME = home;
    try {
      assert.equal(resolveGrokBin(), bin);
    } finally {
      if (prevHome === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = prevHome;
      if (prevBin === undefined) delete process.env.GROK_BIN;
      else process.env.GROK_BIN = prevBin;
    }
  });

  it("throws grok-missing when neither exists", () => {
    const prevHome = process.env.GROK_HOME;
    const prevBin = process.env.GROK_BIN;
    process.env.GROK_HOME = "/tmp/grok-home-does-not-exist";
    process.env.GROK_BIN = "/tmp/grok-bin-does-not-exist";
    try {
      assert.throws(() => resolveGrokBin(), /grok-missing|not found/i);
    } finally {
      if (prevHome === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = prevHome;
      if (prevBin === undefined) delete process.env.GROK_BIN;
      else process.env.GROK_BIN = prevBin;
    }
  });
});

describe("grokAgentArgs", () => {
  it("starts stdio without always-approve", () => {
    assert.deepEqual(grokAgentArgs(), ["agent", "stdio"]);
    assert.ok(!grokAgentArgs().includes("--always-approve"));
    assert.ok(!grokAgentArgs().includes("--yolo"));
  });
});
```

- [ ] **Step 2:** `node --experimental-strip-types --test lib/acp/process.test.mjs` — FAIL

- [ ] **Step 3: Implement `lib/acp/process.ts`**

```typescript
import { existsSync } from "node:fs";
import { join } from "node:path";
import { grokHome } from "../grok-home.ts";

export function resolveGrokBin(): string {
  const override = process.env.GROK_BIN?.trim();
  if (override && existsSync(override)) return override;
  const fallback = join(grokHome(), "bin", "grok");
  if (existsSync(fallback)) return fallback;
  throw new Error("grok-missing: install grok or set GROK_BIN");
}

export function grokAgentArgs(): string[] {
  return ["agent", "stdio"];
}
```

不要在本任务 spawn 真进程。spawn 放进 Task 3。

- [ ] **Step 4:** 测试 PASS

- [ ] **Step 5:**

```bash
git add lib/acp/process.ts lib/acp/process.test.mjs
git commit -m "feat: resolve grok binary without always-approve"
```

---

### Task 3: 连接 initialize / session/new / session/prompt

**Files:**
- Create: `lib/acp/connection.ts`
- Create: `lib/acp/fake-agent.mjs`
- Test: `lib/acp/connection.test.mjs`

假 ACP（`lib/acp/fake-agent.mjs`）从 stdin 读 JSON-RPC 行：

- `initialize` → `{ protocolVersion: 1, agentCapabilities: {} }`
- `session/new` → `{ sessionId: "sess-new-1" }`
- `session/load` → 若 `params.sessionId === "missing"` 则 error `session not found`，否则 `{ sessionId: params.sessionId }`
- `session/prompt` → 先写 notification `session/update`（一条 `agent_thought_chunk`「think」、一条 `agent_message_chunk`「hello」），再回 `{ stopReason: "end_turn" }`
- `session/request_permission` 由本任务的 connection **不**主动发；Task 5 再扩 fake-agent

- [ ] **Step 1: Write the failing test**

```javascript
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { JsonRpcConn } from "./jsonrpc.ts";
import { AcpConnection } from "./connection.ts";

function spawnFake() {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./fake-agent.mjs", import.meta.url))], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const rpc = new JsonRpcConn({ stdin: child.stdin, stdout: child.stdout });
  return { child, acp: new AcpConnection(rpc) };
}

describe("AcpConnection", () => {
  it("creates a session, streams prompt updates, and rejects a missing load", async () => {
    const { child, acp } = spawnFake();
    try {
      await acp.initialize();
      const { sessionId } = await acp.sessionNew("/tmp/p");
      assert.equal(typeof sessionId, "string");
      const updates = [];
      const stop = acp.onSessionUpdate((_id, update) => updates.push(update));
      const result = await acp.sessionPrompt(sessionId, "Hi");
      stop();
      assert.equal(result.stopReason, "end_turn");
      assert.ok(updates.some((u) => u.sessionUpdate === "agent_thought_chunk"));
      assert.ok(updates.some((u) => u.sessionUpdate === "agent_message_chunk"));
      await assert.rejects(acp.sessionLoad("missing"), /session not found/);
    } finally {
      child.kill();
    }
  });
});
```

- [ ] **Step 2:** 跑测试 FAIL（`AcpConnection` 不存在）

- [ ] **Step 3: Implement**

```typescript
export class AcpConnection {
  constructor(private rpc: JsonRpcConn) {}
  initialize(): Promise<unknown>
  sessionNew(cwd: string): Promise<{ sessionId: string }>
  sessionLoad(sessionId: string, cwd?: string): Promise<{ sessionId: string }>
  sessionPrompt(sessionId: string, text: string): Promise<unknown>
  onSessionUpdate(handler: (sessionId: string, update: unknown) => void): () => void
}
```

`session/new` params：`{ cwd, mcpServers: [], _meta: {} }`（不要 `yoloMode`）。  
`session/prompt` params：`{ sessionId, prompt: [{ type: "text", text }] }`。  
`session/load` params：`{ sessionId, cwd }`（cwd 可选）。

提供 `attachProcess(child)` 把 `child.stdin/stdout` 交给 `JsonRpcConn`。

- [ ] **Step 4:** 测试 PASS

- [ ] **Step 5:**

```bash
git add lib/acp/connection.ts lib/acp/connection.test.mjs lib/acp/fake-agent.mjs
git commit -m "feat: talk ACP initialize new load and prompt"
```

---

### Task 4: ACP 更新 → 现有 SSE 事件

**Files:**
- Create: `lib/acp/map-events.ts`
- Test: `lib/acp/map-events.test.mjs`

现有 UI（`hooks/useAgentSession.ts` + `lib/streaming-message.ts`）认这些事件。本任务只译事件，不改 hooks。

规则：

| ACP `sessionUpdate` | 发出的 SSE `type` |
| --- | --- |
| 该回合第一条 agent/tool/thought | 先发一次 `{ type: "agent_start" }` |
| `agent_message_chunk` text | `{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta, contentIndex: 0 } }` |
| `agent_thought_chunk` text | `{ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta, contentIndex: 1 } }`（thought 用 index 1，正文 index 0；若先 thought 再 text，按出现顺序分配递增 `contentIndex`） |
| `tool_call` | `{ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex, id, toolName } }` 且 `partial.content[contentIndex] = { type: "toolCall", toolCallId, toolName, input }` |
| `tool_call_update` | `{ type: "tool_execution_update", toolCallId, toolName, partialResult }` |
| prompt 结束（由调用方传入 `endTurn()`） | `{ type: "agent_end" }`、`{ type: "prompt_done" }`、`{ type: "agent_settled" }` |

`contentIndex`：每个新块（text / thinking / tool）分配下一个整数，同一块的后续 chunk 复用该 index。

- [ ] **Step 1: Write the failing test**

```javascript
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AcpTurnMapper } from "./map-events.ts";

describe("AcpTurnMapper", () => {
  it("emits agent_start then text/thinking deltas then end sequence", () => {
    const mapper = new AcpTurnMapper();
    const events = [
      ...mapper.push({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "th" } }),
      ...mapper.push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }),
      ...mapper.endTurn(),
    ];
    assert.equal(events[0].type, "agent_start");
    assert.equal(events[1].type, "message_update");
    assert.equal(events[1].assistantMessageEvent.type, "thinking_delta");
    assert.equal(events[1].assistantMessageEvent.delta, "th");
    assert.equal(events[2].assistantMessageEvent.type, "text_delta");
    assert.equal(events[2].assistantMessageEvent.delta, "hi");
    assert.deepEqual(events.slice(-3).map((e) => e.type), ["agent_end", "prompt_done", "agent_settled"]);
  });

  it("maps tool_call and tool_call_update", () => {
    const mapper = new AcpTurnMapper();
    const start = mapper.push({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "read_file",
      input: { path: "a.ts" },
    });
    const update = mapper.push({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      title: "read_file",
      status: "completed",
    });
    assert.equal(start[1].assistantMessageEvent.type, "toolcall_start");
    assert.equal(start[1].assistantMessageEvent.toolName, "read_file");
    assert.equal(update[0].type, "tool_execution_update");
    assert.equal(update[0].toolCallId, "t1");
  });
});
```

- [ ] **Step 2:** FAIL

- [ ] **Step 3:** 实现 `AcpTurnMapper`（每回合一个实例，或 `begin()` 重置 `started` 与 contentIndex 表）

- [ ] **Step 4:** PASS

- [ ] **Step 5:**

```bash
git add lib/acp/map-events.ts lib/acp/map-events.test.mjs
git commit -m "feat: map ACP session updates to pi-web SSE events"
```

---

### Task 5: 权限请求

**Files:**
- Create: `lib/acp/permissions.ts`
- Test: `lib/acp/permissions.test.mjs`
- Modify: `lib/acp/fake-agent.mjs`（prompt 时可发 `session/request_permission`）
- Modify: `lib/acp/connection.ts`（处理该 notification，回 `session/request_permission` 的 JSON-RPC **response** 如果它是 request 而不是 notification）

ACP 里权限是 **request**（有 id）：agent → client `session/request_permission`，client 必须回 result。

映射到现有 UI：

```javascript
{
  type: "extension_ui_request",
  id: String(rpcId),
  method: "confirm",
  title: "Allow tool",
  message: toolName + " " + JSON.stringify(input ?? {}),
}
```

UI 回复 `{ type: "extension_ui_response", id, confirmed: true|false }` 或 `{ cancelled: true }`。

- 允许 → ACP result `{ outcome: { outcome: "selected", optionId: "allow-once" } }`（若 request 的 `options` 里有 `allow-once` 就用那个 id，否则用第一个非拒绝 option 的 id）
- 拒绝或超时（60s）→ `{ outcome: { outcome: "rejected" } }` 或选 `reject` option id

- [ ] **Step 1: Write the failing test** for `translatePermissionRequest(params, rpcId)` 与 `resolvePermission(uiResponse, request)`。覆盖允许、拒绝、超时（把 clock 注入：`now` / `timeoutMs`）。

- [ ] **Step 2:** FAIL

- [ ] **Step 3:** 实现 `lib/acp/permissions.ts`。`connection.ts` 在收到 `session/request_permission` **request** 时：发出 UI 事件，把 `{ resolve }` 存入 map，等 `completePermission(id, response)`。

- [ ] **Step 4:** PASS

- [ ] **Step 5:**

```bash
git add lib/acp/permissions.ts lib/acp/permissions.test.mjs lib/acp/connection.ts lib/acp/fake-agent.mjs
git commit -m "feat: map ACP permission requests to confirm dialogs"
```

---

### Task 6: Runtime 取代 startRpcSession 的发送路径

**Files:**
- Create: `lib/acp/runtime.ts`
- Test: `lib/acp/runtime.test.mjs`

`AgentRuntime` 单例：

```typescript
export type AgentCommand =
  | { type: "prompt"; message: string; images?: unknown[] }
  | { type: "get_state" }
  | { type: "extension_ui_response"; id: string; confirmed?: boolean; cancelled?: boolean; value?: string }
  | { type: string; [key: string]: unknown };

export function getAgentRuntime(): AgentRuntime
```

行为：

- `ensureProcess(connFactory?)`：测试注入 `AcpConnection`；生产里 spawn `resolveGrokBin()` + `grokAgentArgs()`，stdio pipe，`initialize` 一次。进程退出则清连接，下次再拉起。
- `createSession(cwd)`：`session/new`，登记 mapper，返回 ACP `sessionId`
- `loadSession(sessionId, cwd)`：`session/load`；失败抛错，调用方保持只读历史
- `send(sessionId, command)`：
  - `prompt`：`session/prompt`，把 `onSessionUpdate` 推到该 session 的 listener；结束后 `mapper.endTurn()`
  - `get_state`：返回 `{ isStreaming, isPromptRunning, model: { provider: "grok", id }, thinkingLevel }`，不打 ACP
  - `extension_ui_response`：交给 `completePermission`
  - `abort`：若 connection 有 `session/cancel` 就发；没有则抛 `ACP cancel is not available`
  - 其它 type（`queue_*`、`fork`、`set_model` 等）：抛 `Error("not implemented in this phase: " + type)`
- `subscribe(sessionId, listener)` / `isBusy(sessionId)` / `listBusyIds()`

测试用 fake-agent 子进程，不要真 grok。

- [ ] **Step 1:** 测试 create + prompt 收到 `agent_start` 与 `text_delta`/`thinking_delta`，`get_state` 在 prompt 期间 `isPromptRunning: true`，结束后 false。未知 command 抛 `not implemented in this phase`。

- [ ] **Step 2:** FAIL

- [ ] **Step 3:** 实现 runtime。生产 spawn 失败（`grok-missing`）把错误留给路由。

- [ ] **Step 4:** PASS，且 `lib/acp/*.test.mjs` 全绿

- [ ] **Step 5:**

```bash
git add lib/acp/runtime.ts lib/acp/runtime.test.mjs
git commit -m "feat: ACP runtime for prompt and session state"
```

---

### Task 7: 接上 `/api/agent` 路由

**Files:**
- Modify: `app/api/agent/new/route.ts`
- Modify: `app/api/agent/[id]/route.ts`
- Modify: `app/api/agent/[id]/events/route.ts`
- Modify: `app/api/agent/running/route.ts`
- Modify: `app/api/agent/running/events/route.ts`
- Create: `lib/acp/http.ts`（handler，便于测）
- Test: `lib/acp/http.test.mjs`

- [ ] **Step 1: Write failing HTTP tests** using `getAgentRuntime` 的测试注入（在 `http.ts` 导出 `createAgentHandlers(runtime)`）：

1. `POST /api/agent/new` `{ cwd, type: "prompt", message: "Hi" }` → 200，`sessionId` 非空
2. `POST /api/agent/:id` `{ type: "prompt", message: "Hi" }` 在已 load 的 id 上 → 200，`data.promptGeneration` 为数字
3. `GET /api/agent/:id` → `{ running, state }`
4. 订阅 events：prompt 后至少看到 `agent_start`
5. `cwd` 缺失 → 400
6. `grok-missing` → 503，body.error 含安装说明（`Install grok or set GROK_BIN`）

- [ ] **Step 2:** FAIL

- [ ] **Step 3: Wire routes**

`POST /api/agent/new`：`existsSync(cwd)` 校验保留；`createSession` + 可选立刻 `prompt`；`allowFileRoot(cwd)`；返回 `{ success, sessionId, data, model, thinkingLevel }`。`type: "ensure_session"` 只 create。

`POST /api/agent/:id`：`loadSession`（若尚未在 runtime 里），再 `send`。prompt 成功返回 `{ success, data: { promptGeneration } }`，沿用 `nextPromptGeneration(id)`。

`GET /api/agent/:id`：`{ running: isBusy(id), state: get_state }`。

`GET /api/agent/:id/events`：用现有 `createAgentEventStream`，把 runtime session 包成 `{ isStreaming, streamingMessage: null, onEvent }`。

`GET /api/agent/running` 与 `.../events`：`listBusyIds()`，不要再 import `rpc-manager` 的 Pi 路径。

找不到 grok：HTTP 503。

- [ ] **Step 4:** PASS + 现有 `lib/session-http.test.mjs` 仍绿

- [ ] **Step 5:**

```bash
git add app/api/agent lib/acp/http.ts lib/acp/http.test.mjs
git commit -m "feat: serve live Grok turns over existing agent routes"
```

---

### Task 8: 缺 grok 时的界面与冒烟

**Files:**
- Modify: `components/AppShell.tsx` 或侧栏错误展示（只加一条：当 `/api/agent/new` 或 prompt 返回 503 `grok-missing` 时，`useAgentSession` 已有 `addNotice` 会显示错误——确认文案可读）
- Test: `lib/acp/http.test.mjs` 已覆盖 503
- 可选：`lib/acp/missing-grok.test.mjs` 断言错误字符串包含 `curl` 或 `GROK_BIN`

不要新做启动页。Chat 里一条 error notice 即可。

- [ ] **Step 1:** 断言 `formatGrokMissingError()` 返回含 `GROK_BIN` 与 `https://x.ai/cli/install.sh` 或规格里的安装提示。

- [ ] **Step 2:** FAIL

- [ ] **Step 3:**

```typescript
export function formatGrokMissingError(): string {
  return "grok-missing: install grok (curl -fsSL https://x.ai/cli/install.sh | bash) or set GROK_BIN";
}
```

`resolveGrokBin` 与 HTTP 503 都用它。

- [ ] **Step 4:** PASS

- [ ] **Step 5:**

```bash
git add lib/acp
git commit -m "feat: explain how to install grok when the binary is missing"
```

手工冒烟（有本机 `grok` 时）：`npm run dev`，打开已有会话，发一条短消息，应看到流式回复；工具弹出确认框。没有 `grok` 时发消息应看到安装说明，侧栏历史仍可读。

---

## Self-review

| 规格第 2 期 | 任务 |
| --- | --- |
| 一个长驻 `grok agent stdio` | 2, 3, 6 |
| 不默认 always-approve | 2 |
| `session/new` / load / prompt | 3, 6, 7 |
| 流式正文/思考/工具 | 4, 6, 7 |
| 权限在浏览器 | 5, 7 |
| 找不到 grok 有说明 | 8 |
| ACP 退出再拉起 | 6 |
| 测适配器不测真 grok | 全部用 fake-agent |
| 不改前端协议 | 7 只换后端 |
| 排队/分叉/文件/登录 | 明确不做；未知 command 报错 |

类型名前后一致：`JsonRpcConn`、`AcpConnection`、`AcpTurnMapper`、`getAgentRuntime`、`resolveGrokBin`。
