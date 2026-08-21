# grok-web Turn Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 ACP 实时对话上接上停止、排队、插话、分叉、从此处编辑，UI 命令形状保持 pi-web 不变。

**Architecture:** 浏览器仍打 `POST /api/agent/:id`。网关把命令译成 Grok ACP：`session/cancel` 通知、`_x.ai/interject`、`_x.ai/session/fork`、`_x.ai/rewind/execute`。Follow-up 队列由网关内存维护（Grok 没有可写的 `x.ai/queue/*` 请求）。测试只用 `lib/acp/fake-agent.mjs`，不启动真 `grok`、不打真模型。

**Tech Stack:** 现有 Node + Vite + TanStack + `lib/acp/*` JSON-RPC 行协议。

**本计划不做：** 模型切换、compact、右栏文件/Git/worktree、设置/登录/MCP、子代理。这些命令继续抛 `not implemented in this phase: <type>`。

规格：`docs/superpowers/specs/2026-08-18-grok-web-design.md` 第 3 期。

已对真 `grok agent stdio`（1.0.5）探过的方法形状（实现必须按这个发，不要猜成无下划线的 `x.ai/...` 请求）：

| UI 命令 | ACP |
| --- | --- |
| `abort` | **通知** `session/cancel` `{ sessionId }`（当 request 会 `-32601`） |
| 忙碌时 `prompt` + `streamingBehavior: "steer"` | 请求 `_x.ai/interject` `{ sessionId, text }` |
| 忙碌时 `prompt` + `streamingBehavior: "followUp"` | 网关队列；回合 **正常结束** 后再 `session/prompt` |
| `clear_queue` / `queue_*` | 只改网关队列；`queue_steer_*` 忙碌时再 `_x.ai/interject` |
| `fork` | `_x.ai/session/fork` `{ sourceSessionId, sourceCwd, newCwd }` → `{ newSessionId }`；若带 `entryId`，对**新**会话 `_x.ai/rewind/execute` |
| `navigate_tree` | `_x.ai/rewind/execute` `{ sessionId, targetPromptIndex }` |

停止后**不要**自动把 follow-up 发出去。只有 `session/prompt` 以非 `cancelled` 结束才排空下一条 follow-up。

---

## File structure

| 路径 | 职责 |
| --- | --- |
| `lib/acp/connection.ts` | 增加 `sessionCancel` / `sessionInterject` / `sessionFork` / `rewindExecute` |
| `lib/acp/fake-agent.mjs` | 假进程支持 WAIT 取消、interject、fork、rewind |
| `lib/acp/queue.ts` | 每个会话的 steering / followUp 内存队列 |
| `lib/acp/rewind-map.ts` | `entryId` → `targetPromptIndex`（用户消息序号） |
| `lib/acp/runtime.ts` | 接上上述命令；记住 `cwd`；发出 `queue_update` |
| `lib/acp/http.ts` | fork / abort / queue / navigate 也要 `loadSessionIfNeeded` |
| 现有 `*.test.mjs` | 补命令测试 |

---

### Task 1: session/cancel 与可取消的假 agent

**Files:**
- Modify: `lib/acp/connection.ts`
- Modify: `lib/acp/fake-agent.mjs`
- Modify: `lib/acp/connection.test.mjs`

- [ ] **Step 1: Write the failing test**

在 `lib/acp/connection.test.mjs` 追加：

```javascript
it("cancels a waiting prompt via session/cancel notification", async () => {
  const { child, acp } = spawnFake();
  try {
    await acp.initialize();
    const { sessionId } = await acp.sessionNew("/tmp/p");
    const pending = acp.sessionPrompt(sessionId, "WAIT");
    await new Promise((r) => setTimeout(r, 20));
    acp.sessionCancel(sessionId);
    const result = await pending;
    assert.equal(result.stopReason, "cancelled");
  } finally {
    child.kill();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test lib/acp/connection.test.mjs`

Expected: FAIL，`sessionCancel` 不存在，或 `WAIT` 立刻 `end_turn`。

- [ ] **Step 3: Implement**

`AcpConnection` 增加：

```typescript
sessionCancel(sessionId: string): void {
  this.rpc.notify("session/cancel", { sessionId });
}
```

`fake-agent.mjs` 把 prompt 改成可挂起：

```javascript
let waiting = null;

// inside session/prompt:
if (params?.prompt?.[0]?.text === "WAIT") {
  waiting = { id, sessionId: params.sessionId };
  return;
}
// existing thought + hello + result(id, { stopReason: "end_turn" })

// new method handler (notification has no id):
if (method === "session/cancel") {
  if (waiting && waiting.sessionId === params?.sessionId) {
    result(waiting.id, { stopReason: "cancelled" });
    waiting = null;
  }
  return;
}
```

不要把 `session/cancel` 写成 `request`。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test lib/acp/connection.test.mjs`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/acp/connection.ts lib/acp/connection.test.mjs lib/acp/fake-agent.mjs
git commit -m "feat: cancel in-flight ACP prompts"
```

---

### Task 2: Runtime abort

**Files:**
- Modify: `lib/acp/runtime.ts`
- Modify: `lib/acp/runtime.test.mjs`

`sendAbort` 已经调用 `sessionCancel`（若存在）。本任务确认它走 `notify`，并且取消后 `busy === false`。

- [ ] **Step 1: Write the failing test**

在 `lib/acp/runtime.test.mjs` 追加：

```javascript
it("abort cancels a WAIT prompt and clears busy", async () => {
  const runtime = createRuntime();
  const sessionId = await runtime.createSession("/tmp/p");
  const pending = runtime.send(sessionId, { type: "prompt", message: "WAIT" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(runtime.isBusy(sessionId), true);
  await runtime.send(sessionId, { type: "abort" });
  const result = await pending;
  assert.equal(result.stopReason, "cancelled");
  assert.equal(runtime.isBusy(sessionId), false);
  assert.deepEqual(runtime.listBusyIds(), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test lib/acp/runtime.test.mjs`

Expected: FAIL（`sessionCancel` 若已接上，可能只是 `busy` 没清，或 abort 仍抛 `ACP cancel is not available`）。

- [ ] **Step 3: Implement**

删掉 `AcpWithCancel` 鸭子类型。`sendAbort`：

```typescript
private async sendAbort(sessionId: string): Promise<unknown> {
  await this.ensureProcess();
  this.requireAcp().sessionCancel(sessionId);
  return null;
}
```

`sendPrompt` 的 `finally` 必须把 `session.busy = false`。`sessionPrompt` 以 `cancelled` 结束时仍走 `mapper.endTurn()`（现有 `try` 已调用）。不要在 abort 后排空 follow-up。

- [ ] **Step 4: PASS**

Run: `node --experimental-strip-types --test lib/acp/runtime.test.mjs`

- [ ] **Step 5: Commit**

```bash
git add lib/acp/runtime.ts lib/acp/runtime.test.mjs
git commit -m "feat: stop a running Grok turn from the browser"
```

---

### Task 3: 网关队列

**Files:**
- Create: `lib/acp/queue.ts`
- Test: `lib/acp/queue.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SessionQueue } from "./queue.ts";

describe("SessionQueue", () => {
  it("enqueues, edits, removes, and clears follow-ups", () => {
    const q = new SessionQueue();
    q.enqueue("followUp", "a");
    q.enqueue("followUp", "b");
    q.enqueue("steering", "s");
    assert.deepEqual(q.snapshot(), { steering: ["s"], followUp: ["a", "b"] });
    assert.deepEqual(q.edit("followUp", "a", "A"), { steering: ["s"], followUp: ["A", "b"] });
    assert.deepEqual(q.remove("followUp", "b"), { steering: ["s"], followUp: ["A"] });
    const cleared = q.clear();
    assert.deepEqual(cleared, { steering: ["s"], followUp: ["A"] });
    assert.deepEqual(q.snapshot(), { steering: [], followUp: [] });
  });

  it("takeSteerItem pulls one follow-up and leaves the rest", () => {
    const q = new SessionQueue();
    q.enqueue("followUp", "a");
    q.enqueue("followUp", "b");
    assert.equal(q.take("followUp", "a"), "a");
    assert.deepEqual(q.snapshot(), { steering: [], followUp: ["b"] });
  });

  it("rejects empty edit replacement", () => {
    const q = new SessionQueue();
    q.enqueue("followUp", "a");
    assert.throws(() => q.edit("followUp", "a", "  "), /empty/i);
  });
});
```

- [ ] **Step 2: FAIL**

Run: `node --experimental-strip-types --test lib/acp/queue.test.mjs`

Expected: FAIL，`SessionQueue` 不存在。

- [ ] **Step 3: Implement `lib/acp/queue.ts`**

```typescript
export type QueueKind = "steering" | "followUp";
export type QueueSnapshot = { steering: string[]; followUp: string[] };

export class SessionQueue {
  private steering: string[] = [];
  private followUp: string[] = [];

  snapshot(): QueueSnapshot {
    return { steering: [...this.steering], followUp: [...this.followUp] };
  }

  enqueue(kind: QueueKind, text: string): QueueSnapshot {
    this.list(kind).push(text);
    return this.snapshot();
  }

  remove(kind: QueueKind, text: string): QueueSnapshot {
    this.take(kind, text);
    return this.snapshot();
  }

  edit(kind: QueueKind, text: string, replacement: string): QueueSnapshot {
    const next = replacement.trim();
    if (!next) throw new Error("Replacement text cannot be empty");
    const list = this.list(kind);
    const index = list.indexOf(text);
    if (index !== -1) list[index] = next;
    return this.snapshot();
  }

  take(kind: QueueKind, text: string): string | undefined {
    const list = this.list(kind);
    const index = list.indexOf(text);
    if (index === -1) return undefined;
    return list.splice(index, 1)[0];
  }

  takeNext(kind: QueueKind): string | undefined {
    return this.list(kind).shift();
  }

  clear(): QueueSnapshot {
    const prev = this.snapshot();
    this.steering = [];
    this.followUp = [];
    return prev;
  }

  private list(kind: QueueKind): string[] {
    return kind === "steering" ? this.steering : this.followUp;
  }
}
```

- [ ] **Step 4: PASS**

Run: `node --experimental-strip-types --test lib/acp/queue.test.mjs`

- [ ] **Step 5: Commit**

```bash
git add lib/acp/queue.ts lib/acp/queue.test.mjs
git commit -m "feat: keep follow-up and steering queues in the gateway"
```

---

### Task 4: 忙碌时排队 / 插话

**Files:**
- Modify: `lib/acp/connection.ts`
- Modify: `lib/acp/fake-agent.mjs`
- Modify: `lib/acp/runtime.ts`
- Modify: `lib/acp/runtime.test.mjs`

协议：

- 空闲 `prompt`：仍 `session/prompt`（现有路径）。
- 忙碌 + `streamingBehavior: "steer"` 或 `type === "steer"`：`_x.ai/interject` `{ sessionId, text }`，**不**进 follow-up 队列。
- 忙碌 + `streamingBehavior: "followUp"` / `type === "follow_up"` / 忙碌时普通 `prompt`：`queue.enqueue("followUp", message)`，SSE `queue_update`，立刻返回。
- `get_state` 增加 `queuedMessages: { steering, followUp }`。
- `session/prompt` 正常结束（`stopReason !== "cancelled"`）后，若有 follow-up，自动再发一条 `session/prompt`（同一 `sendPrompt` 末尾循环或 `drainFollowUps`）。取消结束不 drain。

把 `runtime.test.mjs` 里「`queue_remove` 抛 not implemented」改成下面的队列测试。本任务先接 follow-up 入队、`clear_queue`、steer→interject、成功后 drain；`queue_remove` 等条目命令留到 Task 5。

- [ ] **Step 1: Write the failing tests**

```javascript
it("follow-up while WAIT stays queued until WAIT completes, not until abort", async () => {
  const runtime = createRuntime();
  const sessionId = await runtime.createSession("/tmp/p");
  const events = [];
  runtime.subscribe(sessionId, (e) => events.push(e));
  const waiting = runtime.send(sessionId, { type: "prompt", message: "WAIT" });
  await new Promise((r) => setTimeout(r, 20));
  await runtime.send(sessionId, {
    type: "prompt",
    message: "later",
    streamingBehavior: "followUp",
  });
  assert.deepEqual(
    (await runtime.send(sessionId, { type: "get_state" })).queuedMessages,
    { steering: [], followUp: ["later"] },
  );
  await runtime.send(sessionId, { type: "abort" });
  await waiting;
  assert.deepEqual(
    (await runtime.send(sessionId, { type: "get_state" })).queuedMessages,
    { steering: [], followUp: ["later"] },
  );
});

it("steer while busy calls interject and does not queue follow-up", async () => {
  const runtime = createRuntime();
  const sessionId = await runtime.createSession("/tmp/p");
  const waiting = runtime.send(sessionId, { type: "prompt", message: "WAIT" });
  await new Promise((r) => setTimeout(r, 20));
  await runtime.send(sessionId, {
    type: "prompt",
    message: "nudge",
    streamingBehavior: "steer",
  });
  const state = await runtime.send(sessionId, { type: "get_state" });
  assert.deepEqual(state.queuedMessages.followUp, []);
  await runtime.send(sessionId, { type: "abort" });
  await waiting;
});

it("clear_queue returns the previous items and empties state", async () => {
  const runtime = createRuntime();
  const sessionId = await runtime.createSession("/tmp/p");
  const waiting = runtime.send(sessionId, { type: "prompt", message: "WAIT" });
  await new Promise((r) => setTimeout(r, 20));
  await runtime.send(sessionId, {
    type: "prompt",
    message: "later",
    streamingBehavior: "followUp",
  });
  const cleared = await runtime.send(sessionId, { type: "clear_queue" });
  assert.deepEqual(cleared, { steering: [], followUp: ["later"] });
  assert.deepEqual(
    (await runtime.send(sessionId, { type: "get_state" })).queuedMessages,
    { steering: [], followUp: [] },
  );
  await runtime.send(sessionId, { type: "abort" });
  await waiting;
});

it("drains the next follow-up after a successful prompt", async () => {
  const prompts = [];
  let releaseFirst;
  const firstPrompt = new Promise((r) => { releaseFirst = r; });
  const runtime = new AgentRuntime({
    connect: async () => ({
      initialize: async () => ({}),
      sessionNew: async () => ({ sessionId: "s1" }),
      sessionPrompt: async (sessionId, text) => {
        prompts.push(text);
        if (prompts.length === 1) await firstPrompt;
        return { stopReason: "end_turn" };
      },
      sessionCancel() {},
      sessionInterject: async () => ({ result: { status: "queued" } }),
      onSessionUpdate: () => () => {},
      onPermission: () => () => {},
      completePermission() {},
    }),
  });
  const sessionId = await runtime.createSession("/tmp/p");
  const first = runtime.send(sessionId, { type: "prompt", message: "one" });
  await new Promise((r) => setTimeout(r, 10));
  await runtime.send(sessionId, {
    type: "prompt",
    message: "two",
    streamingBehavior: "followUp",
  });
  assert.deepEqual(prompts, ["one"]);
  releaseFirst();
  await first;
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(prompts, ["one", "two"]);
});
```

- [ ] **Step 2: FAIL**

Run: `node --experimental-strip-types --test lib/acp/runtime.test.mjs`

- [ ] **Step 3: Implement**

`connection.ts`：

```typescript
sessionInterject(sessionId: string, text: string): Promise<unknown> {
  return this.rpc.request("_x.ai/interject", { sessionId, text });
}
```

`fake-agent.mjs`：

```javascript
if (method === "_x.ai/interject") {
  result(id, { result: { status: "queued" } });
  return;
}
```

`runtime.ts`：

- `SessionState` 增加 `queue: SessionQueue` 与 `cwd?: string`。
- `ensureSession` 创建 `new SessionQueue()`。
- `createSession(cwd)` / `loadSession(sessionId, cwd?)` 写入 `session.cwd`。
- `getState` 加上 `queuedMessages: session.queue.snapshot()`。
- `send()`：
  - `abort` / `prompt` / `steer` / `follow_up` / `clear_queue` / `queue_remove` / `queue_edit` / `queue_steer_item` / `queue_steer_all` 按本任务与 Task 5。
- `sendPrompt`：

```typescript
private async sendPrompt(
  sessionId: string,
  message: string,
  streamingBehavior?: "steer" | "followUp",
): Promise<unknown> {
  await this.ensureProcess();
  const session = this.ensureSession(sessionId);
  if (session.busy) {
    if (streamingBehavior === "steer") {
      return this.requireAcp().sessionInterject(sessionId, message);
    }
    const snap = session.queue.enqueue("followUp", message);
    this.emit(sessionId, [{ type: "queue_update", ...snap }]);
    return snap;
  }
  return this.runPrompt(sessionId, message);
}

private async runPrompt(sessionId: string, message: string): Promise<unknown> {
  const session = this.ensureSession(sessionId);
  session.busy = true;
  session.mapper.begin();
  try {
    const result = await this.requireAcp().sessionPrompt(sessionId, message);
    this.emit(sessionId, session.mapper.endTurn());
    const stopReason = isRecord(result) && typeof result.stopReason === "string"
      ? result.stopReason
      : "";
    if (stopReason !== "cancelled") {
      const next = session.queue.takeNext("followUp");
      if (next !== undefined) {
        this.emit(sessionId, [{ type: "queue_update", ...session.queue.snapshot() }]);
        session.busy = false;
        return this.runPrompt(sessionId, next);
      }
    }
    return result;
  } finally {
    session.busy = false;
  }
}
```

注意：`runPrompt` 递归前必须先 `busy = false`，否则子调用会走入队分支。`finally` 也会再清一次。

`steer` / `follow_up` 命令复用 `sendPrompt(sessionId, message, "steer"|"followUp")`。

`clear_queue`：

```typescript
const snap = this.ensureSession(sessionId).queue.clear();
this.emit(sessionId, [{ type: "queue_update", ...this.ensureSession(sessionId).queue.snapshot() }]);
return snap;
```

- [ ] **Step 4: PASS**

Run: `node --experimental-strip-types --test lib/acp/*.test.mjs`

删掉或改写旧的 `queue_remove throws not implemented`。`queue_*` 在 Task 5 接完前，若本任务只实现 `clear_queue`，`queue_remove` 仍可先抛 not implemented。本任务至少实现 follow-up 入队、`get_state.queuedMessages`、`clear_queue`、steer→interject、成功后 drain。

- [ ] **Step 5: Commit**

```bash
git add lib/acp/connection.ts lib/acp/fake-agent.mjs lib/acp/runtime.ts lib/acp/runtime.test.mjs
git commit -m "feat: queue follow-ups and interject mid-turn"
```

---

### Task 5: 队列条目命令

**Files:**
- Modify: `lib/acp/runtime.ts`
- Modify: `lib/acp/runtime.test.mjs`

UI 已发出：`queue_remove` / `queue_edit` / `queue_steer_item` / `queue_steer_all`，载荷与 pi-web 相同：`{ kind, text, replacement? }`。

- [ ] **Step 1: Write the failing tests**

```javascript
it("queue_remove and queue_edit change follow-ups", async () => {
  const runtime = createRuntime();
  const sessionId = await runtime.createSession("/tmp/p");
  const waiting = runtime.send(sessionId, { type: "prompt", message: "WAIT" });
  await new Promise((r) => setTimeout(r, 20));
  await runtime.send(sessionId, { type: "prompt", message: "a", streamingBehavior: "followUp" });
  await runtime.send(sessionId, { type: "prompt", message: "b", streamingBehavior: "followUp" });
  await runtime.send(sessionId, { type: "queue_edit", kind: "followUp", text: "a", replacement: "A" });
  const after = await runtime.send(sessionId, { type: "queue_remove", kind: "followUp", text: "b" });
  assert.deepEqual(after, { steering: [], followUp: ["A"] });
  await runtime.send(sessionId, { type: "abort" });
  await waiting;
});

it("queue_steer_item interjects that text while busy", async () => {
  const interjects = [];
  const runtime = new AgentRuntime({
    connect: async () => ({
      initialize: async () => ({}),
      sessionNew: async () => ({ sessionId: "s1" }),
      sessionPrompt: async () => {
        await new Promise((r) => setTimeout(r, 50));
        return { stopReason: "end_turn" };
      },
      sessionCancel() {},
      sessionInterject: async (_id, text) => {
        interjects.push(text);
        return { result: { status: "queued" } };
      },
      onSessionUpdate: () => () => {},
      onPermission: () => () => {},
      completePermission() {},
    }),
  });
  const sessionId = await runtime.createSession("/tmp/p");
  const first = runtime.send(sessionId, { type: "prompt", message: "one" });
  await new Promise((r) => setTimeout(r, 10));
  await runtime.send(sessionId, { type: "prompt", message: "nudge", streamingBehavior: "followUp" });
  await runtime.send(sessionId, { type: "queue_steer_item", kind: "followUp", text: "nudge" });
  assert.deepEqual(interjects, ["nudge"]);
  assert.deepEqual(
    (await runtime.send(sessionId, { type: "get_state" })).queuedMessages,
    { steering: [], followUp: [] },
  );
  await first;
});
```

- [ ] **Step 2: FAIL**

- [ ] **Step 3: Implement in `send()`**

```typescript
case "queue_remove":
  return this.mutateQueue(sessionId, () =>
    this.ensureSession(sessionId).queue.remove(kindField(command), stringField(command.text)));
case "queue_edit":
  return this.mutateQueue(sessionId, () =>
    this.ensureSession(sessionId).queue.edit(kindField(command), stringField(command.text), stringField(command.replacement)));
case "queue_steer_item": {
  const text = this.ensureSession(sessionId).queue.take(kindField(command), stringField(command.text));
  this.emitQueue(sessionId);
  if (text && this.isBusy(sessionId)) {
    await this.ensureProcess();
    await this.requireAcp().sessionInterject(sessionId, text);
  } else if (text) {
    return this.sendPrompt(sessionId, text);
  }
  return this.ensureSession(sessionId).queue.snapshot();
}
case "queue_steer_all": {
  const session = this.ensureSession(sessionId);
  const items = [...session.queue.snapshot().steering, ...session.queue.snapshot().followUp];
  session.queue.clear();
  this.emitQueue(sessionId);
  if (this.isBusy(sessionId)) {
    await this.ensureProcess();
    for (const text of items) await this.requireAcp().sessionInterject(sessionId, text);
  }
  return session.queue.snapshot();
}
```

`kindField`：仅接受 `"steering" | "followUp"`，否则当 `"followUp"`。每次变更 `emitQueue` → `{ type: "queue_update", ...snapshot }`。

- [ ] **Step 4: PASS** 全量 `lib/acp/*.test.mjs`

- [ ] **Step 5: Commit**

```bash
git add lib/acp/runtime.ts lib/acp/runtime.test.mjs
git commit -m "feat: edit and steer queued follow-ups"
```

---

### Task 6: 分叉

**Files:**
- Modify: `lib/acp/connection.ts`
- Modify: `lib/acp/fake-agent.mjs`
- Modify: `lib/acp/runtime.ts`
- Modify: `lib/acp/runtime.test.mjs`
- Modify: `lib/acp/http.ts`（fork 后 `invalidateSessionListCache()`；`postSession` 对非 get_state 命令 `loadSessionIfNeeded`）

已探形状：

```ts
// request
{ sourceSessionId, sourceCwd, newCwd }  // 同项目分叉时 newCwd === sourceCwd
// result
{ newSessionId, chatMessagesCopied, updatesCopied, planStateCopied, newCwd, parentSessionId }
```

UI：`{ type: "fork", entryId }` → `{ cancelled: false, newSessionId }`。Grok 的 fork 复制**整段**会话；若有 `entryId`，在**新**会话上 rewind（Task 7 接 rewind；本任务无 `entryId` 或 rewind 未就绪时只 fork）。

本任务：无 `entryId` 或 rewind 尚未实现时，只 fork。Task 7 补上「fork 后 rewind 新会话」。

- [ ] **Step 1: Write the failing test**

```javascript
it("fork returns a newSessionId from _x.ai/session/fork", async () => {
  const runtime = createRuntime();
  const sessionId = await runtime.createSession("/tmp/p");
  const result = await runtime.send(sessionId, { type: "fork", entryId: "ignored-for-now" });
  assert.equal(result.cancelled, false);
  assert.ok(typeof result.newSessionId === "string" && result.newSessionId.length > 0);
  assert.notEqual(result.newSessionId, sessionId);
});
```

`connection.test.mjs`：

```javascript
it("forks a session and returns newSessionId", async () => {
  const { child, acp } = spawnFake();
  try {
    await acp.initialize();
    const { sessionId } = await acp.sessionNew("/tmp/p");
    const forked = await acp.sessionFork({
      sourceSessionId: sessionId,
      sourceCwd: "/tmp/p",
      newCwd: "/tmp/p",
    });
    assert.ok(forked.newSessionId);
    assert.notEqual(forked.newSessionId, sessionId);
  } finally {
    child.kill();
  }
});
```

- [ ] **Step 2: FAIL**

- [ ] **Step 3: Implement**

```typescript
// connection.ts
sessionFork(params: {
  sourceSessionId: string;
  sourceCwd: string;
  newCwd: string;
}): Promise<{ newSessionId: string }> {
  return this.rpc.request("_x.ai/session/fork", params) as Promise<{ newSessionId: string }>;
}
```

`fake-agent.mjs`：

```javascript
if (method === "_x.ai/session/fork") {
  result(id, { newSessionId: "sess-fork-1" });
  return;
}
```

`runtime` 必须记住 `cwd`。`fork` 时：

```typescript
const cwd = session.cwd ?? (await findGrokSession(sessionId))?.cwd;
if (!cwd) throw new Error("Cannot fork without a session cwd");
const forked = await this.requireAcp().sessionFork({
  sourceSessionId: sessionId,
  sourceCwd: cwd,
  newCwd: cwd,
});
this.ensureSession(forked.newSessionId).cwd = cwd;
invalidateSessionListCache();
return { cancelled: false, newSessionId: forked.newSessionId };
```

`http.ts` `postSession`：对 `fork` / `abort` / `navigate_tree` / `queue_*` / `clear_queue` / `steer` / `follow_up` 也 `await loadSessionIfNeeded(runtime, id)`。`loadSession` 用 `findGrokSession(id)?.cwd` 填 cwd。

- [ ] **Step 4: PASS**

- [ ] **Step 5: Commit**

```bash
git add lib/acp/connection.ts lib/acp/connection.test.mjs lib/acp/fake-agent.mjs lib/acp/runtime.ts lib/acp/runtime.test.mjs lib/acp/http.ts
git commit -m "feat: fork a Grok session over ACP"
```

---

### Task 7: 从此处编辑（rewind）

**Files:**
- Create: `lib/acp/rewind-map.ts`
- Test: `lib/acp/rewind-map.test.mjs`
- Modify: `lib/acp/connection.ts`
- Modify: `lib/acp/fake-agent.mjs`
- Modify: `lib/acp/runtime.ts`
- Modify: `lib/acp/runtime.test.mjs`

Grok 没有 Pi 那种会话内树。`navigate_tree` /「从此处编辑」= 把**当前**会话 rewind 到该用户回合。`fork` + `entryId` = 先 fork，再 rewind **新**会话。

`targetPromptIndex` = 到该 `entryId` 为止（含）的 user 消息数 − 1。点在 assistant 条目上则用它之前最近一条 user。

已探：`_x.ai/rewind/execute` `{ sessionId, targetPromptIndex }` → `{ success, error, ... }`。`success: false` 时抛 `error` 文本。

- [ ] **Step 1: Write the failing tests**

```javascript
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { promptIndexForEntry } from "./rewind-map.ts";

describe("promptIndexForEntry", () => {
  const messages = [
    { role: "user", content: "u0" },
    { role: "assistant", content: [], model: "g", provider: "grok" },
    { role: "user", content: "u1" },
    { role: "assistant", content: [], model: "g", provider: "grok" },
  ];
  const entryIds = ["e0", "e1", "e2", "e3"];

  it("maps a user entry to its prompt index", () => {
    assert.equal(promptIndexForEntry("e0", messages, entryIds), 0);
    assert.equal(promptIndexForEntry("e2", messages, entryIds), 1);
  });

  it("maps an assistant entry to the preceding user prompt", () => {
    assert.equal(promptIndexForEntry("e1", messages, entryIds), 0);
    assert.equal(promptIndexForEntry("e3", messages, entryIds), 1);
  });

  it("throws on unknown entryId", () => {
    assert.throws(() => promptIndexForEntry("missing", messages, entryIds), /entry/i);
  });
});
```

runtime：

```javascript
it("navigate_tree rewinds the current session", async () => {
  const rewinds = [];
  const runtime = new AgentRuntime({
    connect: async () => ({
      initialize: async () => ({}),
      sessionNew: async () => ({ sessionId: "s1" }),
      sessionLoad: async () => ({ sessionId: "s1" }),
      sessionPrompt: async () => ({ stopReason: "end_turn" }),
      sessionCancel() {},
      sessionInterject: async () => ({}),
      sessionFork: async () => ({ newSessionId: "s2" }),
      rewindExecute: async (sessionId, targetPromptIndex) => {
        rewinds.push({ sessionId, targetPromptIndex });
        return { success: true };
      },
      onSessionUpdate: () => () => {},
      onPermission: () => () => {},
      completePermission() {},
    }),
    resolveEntries: async () => ({
      messages: [
        { role: "user", content: "u0" },
        { role: "assistant", content: [], model: "g", provider: "grok" },
      ],
      entryIds: ["e0", "e1"],
    }),
  });
  const sessionId = await runtime.createSession("/tmp/p");
  const result = await runtime.send(sessionId, { type: "navigate_tree", targetId: "e1" });
  assert.equal(result.cancelled, false);
  assert.deepEqual(rewinds, [{ sessionId: "s1", targetPromptIndex: 0 }]);
});

it("fork with entryId rewinds the new session only", async () => {
  const rewinds = [];
  const runtime = new AgentRuntime({
    connect: async () => ({
      initialize: async () => ({}),
      sessionNew: async () => ({ sessionId: "s1" }),
      sessionPrompt: async () => ({ stopReason: "end_turn" }),
      sessionCancel() {},
      sessionInterject: async () => ({}),
      sessionFork: async () => ({ newSessionId: "s2" }),
      rewindExecute: async (sessionId, targetPromptIndex) => {
        rewinds.push({ sessionId, targetPromptIndex });
        return { success: true };
      },
      onSessionUpdate: () => () => {},
      onPermission: () => () => {},
      completePermission() {},
    }),
    resolveEntries: async () => ({
      messages: [
        { role: "user", content: "u0" },
        { role: "assistant", content: [], model: "g", provider: "grok" },
        { role: "user", content: "u1" },
      ],
      entryIds: ["e0", "e1", "e2"],
    }),
  });
  await runtime.createSession("/tmp/p");
  const result = await runtime.send("s1", { type: "fork", entryId: "e2" });
  assert.equal(result.newSessionId, "s2");
  assert.deepEqual(rewinds, [{ sessionId: "s2", targetPromptIndex: 1 }]);
});
```

- [ ] **Step 2: FAIL**

- [ ] **Step 3: Implement**

`rewind-map.ts`：

```typescript
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { mapUpdatesJsonl, type HistoryMessage } from "../history-map.ts";
import { findGrokSession } from "../session-index.ts";

export function promptIndexForEntry(
  entryId: string,
  messages: HistoryMessage[],
  entryIds: string[],
): number {
  const at = entryIds.indexOf(entryId);
  if (at === -1) throw new Error("Invalid entry ID for rewind");
  let index = -1;
  for (let i = 0; i <= at; i++) {
    if (messages[i]?.role === "user") index += 1;
  }
  if (index < 0) throw new Error("Invalid entry ID for rewind");
  return index;
}

export async function resolveSessionEntries(sessionId: string): Promise<{
  messages: HistoryMessage[];
  entryIds: string[];
}> {
  const session = await findGrokSession(sessionId);
  if (!session) throw new Error("Session not found");
  let text = "";
  try {
    text = await readFile(join(session.path, "updates.jsonl"), "utf8");
  } catch {
    text = "";
  }
  return mapUpdatesJsonl(text);
}
```

`connection.ts`：

```typescript
rewindExecute(sessionId: string, targetPromptIndex: number): Promise<{ success?: boolean; error?: string }> {
  return this.rpc.request("_x.ai/rewind/execute", {
    sessionId,
    targetPromptIndex,
  }) as Promise<{ success?: boolean; error?: string }>;
}
```

`fake-agent.mjs`：

```javascript
if (method === "_x.ai/rewind/execute") {
  result(id, { success: true, target_prompt_index: params?.targetPromptIndex ?? 0, mode: "all" });
  return;
}
```

`AgentRuntime` 构造函数增加可选 `resolveEntries`。`navigate_tree` 读 `command.targetId`。`rewindExecute` 若 `success === false`，抛 `error || "Rewind failed"`。

fork：有 `entryId` 时对 `newSessionId` rewind。

- [ ] **Step 4: PASS**

Run: `node --experimental-strip-types --test lib/acp/*.test.mjs`

- [ ] **Step 5: Commit**

```bash
git add lib/acp/rewind-map.ts lib/acp/rewind-map.test.mjs lib/acp/connection.ts lib/acp/fake-agent.mjs lib/acp/runtime.ts lib/acp/runtime.test.mjs
git commit -m "feat: rewind or fork from a transcript entry"
```

---

### Task 8: HTTP 与回归

**Files:**
- Modify: `lib/acp/http.ts`
- Modify: `lib/acp/http.test.mjs`

- [ ] **Step 1: Write the failing tests**

```javascript
it("POST abort on a WAIT prompt returns 200", async () => {
  const runtime = createRuntime();
  const handlers = createAgentHandlers(runtime);
  const created = await handlers.postNew(jsonRequest("http://127.0.0.1/api/agent/new", {
    cwd: tmpdir(),
    type: "ensure_session",
  }));
  const { sessionId } = await created.json();
  const waiting = handlers.postSession(jsonRequest(`http://127.0.0.1/api/agent/${sessionId}`, {
    type: "prompt",
    message: "WAIT",
  }), sessionId);
  await new Promise((r) => setTimeout(r, 20));
  const res = await handlers.postSession(jsonRequest(`http://127.0.0.1/api/agent/${sessionId}`, {
    type: "abort",
  }), sessionId);
  assert.equal(res.status, 200);
  await waiting;
});

it("POST fork returns newSessionId", async () => {
  const runtime = createRuntime();
  const handlers = createAgentHandlers(runtime);
  const created = await handlers.postNew(jsonRequest("http://127.0.0.1/api/agent/new", {
    cwd: tmpdir(),
    type: "ensure_session",
  }));
  const { sessionId } = await created.json();
  const res = await handlers.postSession(jsonRequest(`http://127.0.0.1/api/agent/${sessionId}`, {
    type: "fork",
    entryId: "none",
  }), sessionId);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.success, true);
  assert.ok(body.data.newSessionId);
});
```

`postSession` 对 `prompt` 仍返回 `promptGeneration`；`abort`/`fork`/`queue_*` 返回 `data: result`。`fork` 的无效 `entryId`：若 Task 7 已接 rewind，fake-agent 的 `entryId: "none"` 会在 `resolveEntries` 真实磁盘上找不到。HTTP 测试的 fork 不要带会触发 rewind 失败的 entryId——用 `type: "fork"` 且 `entryId` 省略，runtime 只 fork。

- [ ] **Step 2: FAIL**（若 Task 6 已改 http，此步可能已绿；仍须跑全套）

- [ ] **Step 3:** 确认 `postSession` 在 `prompt` 之外也会 `loadSessionIfNeeded`。不要把 abort/fork 标成 `prompt_rejected`。

- [ ] **Step 4: PASS**

Run: `node --experimental-strip-types --test lib/acp/*.test.mjs lib/session-http.test.mjs`

Expected: 全部 PASS，0 fail。

- [ ] **Step 5: Commit**

```bash
git add lib/acp/http.ts lib/acp/http.test.mjs
git commit -m "feat: expose stop, queue, and fork on agent routes"
```

---

## Self-review

**Spec coverage**

| 规格 | 任务 |
| --- | --- |
| 停止 → ACP 取消 | 1–2 |
| 排队 / 插话 → 已有取消、追加、转向 | 3–5（follow-up 网关队列 + `_x.ai/interject`） |
| 能力缺失不静默吞 | 未做的命令仍抛 `not implemented in this phase` |
| 分叉 → `x.ai/session/fork` | 6（实际方法名 `_x.ai/session/fork`） |
| 从此处编辑 | 7 |
| 不测真 grok / 真模型 | 全程 fake-agent |
| 文件/设置/子代理 | 不做 |

**Placeholder scan:** 无 TBD。

**Type consistency:** `queuedMessages`、`SessionQueue.snapshot`、`queue_update` 的 `steering` / `followUp` 与 UI 一致。fork 返回 `newSessionId`。navigate 用 `targetId`。

**已知限制（写进实现注释，不要另开范围）：** Grok rewind 截断历史，不是 Pi 的会话内树；fork 先整段复制再 rewind 新会话。图片仍忽略。
