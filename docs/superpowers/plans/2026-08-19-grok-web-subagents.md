# grok-web Subagent Tree Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 设置页/对话里的子代理树能列出 Grok 子会话的真实状态，停止走 `_x.ai/subagent/cancel`；引导仍打根会话。

**Architecture:** 浏览器协议不变（`GET/POST /api/agent/:id/subagents`）。耐用树来自父会话目录 `subagents/*/meta.json`，直播状态来自 `_x.ai/subagent/list_running`。没有 `_x.ai/subagent/steer|resume`。测试只扩 `fake-agent.mjs` 与 GROK_HOME 夹具。

**Tech Stack:** 现有 Node + `lib/acp/*` + `lib/grok-fs/*`。

**本计划不做：** 从 web 里 spawn 子代理、插件市场、改树 UI、Pi `createSubagentHandlers` 那套 RPC。

规格：`docs/superpowers/specs/2026-08-18-grok-web-design.md` 第 6 期。

已对真 `grok agent stdio` 探过（必须按这个发；方法带 `_x.ai/`）：

| UI | ACP / 磁盘 |
| --- | --- |
| 列直播子代理 | `_x.ai/subagent/list_running` `{ sessionId }` → `{ result: { subagents: [...] } }`（只含仍在跑的） |
| 停止 | `_x.ai/subagent/cancel` `{ subagentId }` → `{ result: { subagentId, cancelled, outcome: { kind } } }`；未知 id 的 `kind` 是 `"not_found"` |
| 引导 | 没有 `_x.ai/subagent/steer`。继续对**根** `runtime.send(..., { type: "prompt", streamingBehavior: "steer" })` |
| 恢复 | 没有 resume RPC。返回明确错误，不要假装成功 |
| 耐用树 | `~/.grok/sessions/<cwd>/<rootId>/subagents/<id>/meta.json` |

`meta.json` 字段：`subagent_id`、`parent_session_id`、`child_session_id`、`subagent_type`、`description`、`status`（`completed` / `failed` / `cancelled`）、`started_at`、`completed_at`。子会话自己的 `summary.json` 有 `session_kind: "subagent"`，**常常没有** `parent_session_id`，所以不能只靠现有 session 索引。

`list_running` 的条目形状以 fake-agent 为准（探到的空列表）：`{ subagentId, childSessionId?, description?, status?, subagentType? }`。映射时也接受 `id` / `agentType`。

状态映射：直播 → `running`；磁盘 `completed` → `complete`；`failed` → `failed`；`cancelled` → `stopped`；其余 → `inactive`。直播覆盖同 id 的磁盘节点。

`rpcAvailable: true` 当 `list_running` 成功。`canInterrupt` / `canSteer` 仅直播为 true。`canResume` 恒 false。

---

## File structure

| 路径 | 职责 |
| --- | --- |
| `lib/acp/connection.ts` | `subagentListRunning` / `subagentCancel` |
| `lib/acp/fake-agent.mjs` | 上述方法 |
| `lib/grok-fs/subagent-meta.ts` | 读 `subagents/*/meta.json` |
| `lib/acp/subagents.ts` | 合并磁盘 + 直播；interrupt → cancel |
| `lib/acp/runtime.ts` | 把 list/cancel 暴露给 HTTP |
| `app/api/agent/[id]/subagents/route.ts` | 导出的 GET/POST 走合并后的树 |

---

### Task 1: ACP list_running 与 cancel

**Files:**
- Modify: `lib/acp/connection.ts`
- Modify: `lib/acp/fake-agent.mjs`
- Modify: `lib/acp/connection.test.mjs`

- [ ] **Step 1: Write the failing test**

在 `describe("AcpConnection")` 末尾加：

```javascript
it("lists running subagents and cancels by subagentId", async () => {
  const { child, acp } = spawnFake();
  try {
    await acp.initialize();
    const { sessionId } = await acp.sessionNew("/tmp/p");
    const empty = await acp.subagentListRunning(sessionId);
    assert.deepEqual(empty.subagents, []);
    const started = await acp.sessionPrompt(sessionId, "SPAWN_SUB");
    assert.equal(started.stopReason, "end_turn");
    const listed = await acp.subagentListRunning(sessionId);
    assert.equal(listed.subagents.length, 1);
    assert.equal(listed.subagents[0].subagentId, "sub-1");
    assert.equal(listed.subagents[0].status, "running");
    const cancelled = await acp.subagentCancel("sub-1");
    assert.equal(cancelled.cancelled, true);
    assert.equal((await acp.subagentListRunning(sessionId)).subagents.length, 0);
    const missing = await acp.subagentCancel("nope");
    assert.equal(missing.cancelled, false);
    assert.equal(missing.outcome?.kind, "not_found");
  } finally {
    child.kill();
  }
});
```

- [ ] **Step 2:** `cd /Users/kale/grok-web && node --experimental-strip-types --test lib/acp/connection.test.mjs`

Expected: FAIL，`subagentListRunning` 不存在。

- [ ] **Step 3: Implement**

```typescript
subagentListRunning(sessionId: string): Promise<{
  subagents: Array<{
    subagentId: string;
    childSessionId?: string;
    description?: string;
    status?: string;
    subagentType?: string;
  }>;
}> {
  return this.rpc.request("_x.ai/subagent/list_running", { sessionId }).then((raw) => unwrapResult(raw) as never);
}

subagentCancel(subagentId: string): Promise<{
  subagentId?: string;
  cancelled?: boolean;
  outcome?: { kind?: string };
}> {
  return this.rpc.request("_x.ai/subagent/cancel", { subagentId }).then((raw) => unwrapResult(raw) as never);
}
```

fake-agent：模块级 `const runningSubs = new Map()`（key = 父 sessionId）。

- `_x.ai/subagent/list_running`：缺 `sessionId` 则 `-32602`。返回 `{ result: { subagents: [...(runningSubs.get(sessionId) ?? [])] } }`。
- `_x.ai/subagent/cancel`：缺 `subagentId` 则 `-32602`。在所有 value 数组里删掉该 id；找到则 `{ result: { subagentId, cancelled: true, outcome: { kind: "cancelled" } } }`，否则 `{ result: { subagentId, cancelled: false, outcome: { kind: "not_found" } } }`。
- `session/prompt` 文本为 `"SPAWN_SUB"` 时：把 `{ subagentId: "sub-1", childSessionId: "sub-1", description: "explore task", status: "running", subagentType: "explore" }` 推进该 session 的数组，然后照常发 update + `end_turn`。

- [ ] **Step 4:** 同一测试 PASS。再跑 `lib/acp/*.test.mjs`。

- [ ] **Step 5: Commit**

```bash
git add lib/acp/connection.ts lib/acp/fake-agent.mjs lib/acp/connection.test.mjs
git commit -m "$(cat <<'EOF'
feat: list and cancel running Grok subagents over ACP

EOF
)"
```

---

### Task 2: 读磁盘 meta.json

**Files:**
- Create: `lib/grok-fs/subagent-meta.ts`
- Create: `lib/grok-fs/subagent-meta.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { listSubagentMetas } from "./subagent-meta.ts";

describe("listSubagentMetas", () => {
  it("reads meta.json under a parent session subagents directory", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-sub-meta-"));
    const dir = join(root, "subagents", "child-1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "meta.json"), JSON.stringify({
      subagent_id: "child-1",
      parent_session_id: "root-1",
      child_session_id: "child-1",
      subagent_type: "explore",
      description: "look around",
      status: "completed",
      started_at: "2026-08-19T00:00:00Z",
      completed_at: "2026-08-19T00:01:00Z",
    }));
    const metas = listSubagentMetas(root);
    assert.equal(metas.length, 1);
    assert.equal(metas[0].subagentId, "child-1");
    assert.equal(metas[0].parentSessionId, "root-1");
    assert.equal(metas[0].childSessionId, "child-1");
    assert.equal(metas[0].agent, "explore");
    assert.equal(metas[0].task, "look around");
    assert.equal(metas[0].status, "completed");
  });

  it("returns an empty list when the subagents folder is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-sub-empty-"));
    assert.deepEqual(listSubagentMetas(root), []);
  });
});
```

- [ ] **Step 2:** `node --experimental-strip-types --test lib/grok-fs/subagent-meta.test.mjs`

Expected: FAIL，模块不存在。

- [ ] **Step 3: Implement**

```typescript
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type GrokSubagentMeta = {
  subagentId: string;
  parentSessionId: string;
  childSessionId: string;
  agent: string;
  task: string;
  status: string;
  startedAt?: string;
  completedAt?: string;
};

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function listSubagentMetas(parentSessionDir: string): GrokSubagentMeta[] {
  const root = join(parentSessionDir, "subagents");
  if (!existsSync(root)) return [];
  const out: GrokSubagentMeta[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(root, entry.name, "meta.json");
    if (!existsSync(file)) continue;
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const rec = parsed as Record<string, unknown>;
      const subagentId = asString(rec.subagent_id) || entry.name;
      out.push({
        subagentId,
        parentSessionId: asString(rec.parent_session_id),
        childSessionId: asString(rec.child_session_id) || subagentId,
        agent: asString(rec.subagent_type) || "grok",
        task: asString(rec.description) || asString(rec.prompt),
        status: asString(rec.status) || "inactive",
        ...(asString(rec.started_at) ? { startedAt: asString(rec.started_at) } : {}),
        ...(asString(rec.completed_at) ? { completedAt: asString(rec.completed_at) } : {}),
      });
    } catch {
      // skip a damaged meta
    }
  }
  return out;
}
```

- [ ] **Step 4:** 测试 PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/grok-fs/subagent-meta.ts lib/grok-fs/subagent-meta.test.mjs
git commit -m "$(cat <<'EOF'
feat: read Grok subagent meta.json from the parent session

EOF
)"
```

---

### Task 3: 合并树 + interrupt 走 cancel

**Files:**
- Modify: `lib/acp/subagents.ts`
- Modify: `lib/acp/subagents.test.mjs`
- Modify: `lib/acp/runtime.ts`
- Modify: `lib/acp/runtime.test.mjs`

- [ ] **Step 1: Write failing tests**

`lib/acp/subagents.test.mjs` 增加（保留现有 parentSessionId 回退测试）：

```javascript
it("merges disk metas with live running rows", () => {
  const sessions = [session("root"), session("child-1", undefined, { name: "look around" })];
  const tree = grokSubagentTree("root", sessions, 10, {
    metas: [{
      subagentId: "child-1",
      parentSessionId: "root",
      childSessionId: "child-1",
      agent: "explore",
      task: "look around",
      status: "completed",
    }],
    live: [{ subagentId: "child-1", status: "running", description: "look around", subagentType: "explore" }],
    rpcAvailable: true,
  });
  assert.equal(tree.rpcAvailable, true);
  assert.equal(tree.nodes.length, 1);
  assert.equal(tree.nodes[0].state, "running");
  assert.equal(tree.nodes[0].canInterrupt, true);
  assert.equal(tree.nodes[0].canSteer, true);
  assert.equal(tree.nodes[0].canResume, false);
});

it("cancels the child subagentId on interrupt instead of aborting the root", async () => {
  const sent = [];
  const cancelled = [];
  const runtime = {
    send: async (sessionId, command) => {
      sent.push({ sessionId, command });
      return { ok: true };
    },
    cancelSubagent: async (subagentId) => {
      cancelled.push(subagentId);
      return { cancelled: true };
    },
  };
  await controlGrokSubagent(runtime, "root", "child-1", "interrupt");
  assert.deepEqual(cancelled, ["child-1"]);
  assert.equal(sent.length, 0);
});

it("returns a clear error when resume has no ACP method", async () => {
  await assert.rejects(
    () => controlGrokSubagent({ send: async () => ({}) }, "root", "child-1", "resume", "go"),
    /not supported/i,
  );
});
```

`runtime.test.mjs`（用现有 `createRuntime()`）：

```javascript
it("lists running subagents and cancels them", async () => {
  const runtime = createRuntime();
  const sessionId = await runtime.createSession("/tmp/p");
  await runtime.send(sessionId, { type: "prompt", message: "SPAWN_SUB" });
  const listed = await runtime.listRunningSubagents(sessionId);
  assert.equal(listed.subagents[0].subagentId, "sub-1");
  const cancelled = await runtime.cancelSubagent("sub-1");
  assert.equal(cancelled.cancelled, true);
});
```

- [ ] **Step 2:** 跑这些测试。Expected: FAIL。

- [ ] **Step 3: Implement**

扩展 `grokSubagentTree` 第四参：

```typescript
export function mapDiskStatus(status: string): SubagentLifecycleState {
  if (status === "completed") return "complete";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "stopped";
  if (status === "running" || status === "starting") return "running";
  return "inactive";
}

export function grokSubagentTree(
  rootId: string,
  sessions: SessionInfo[],
  now = Date.now(),
  extras: {
    metas?: GrokSubagentMeta[];
    live?: Array<{ subagentId?: string; id?: string; childSessionId?: string; description?: string; status?: string; subagentType?: string; agentType?: string }>;
    rpcAvailable?: boolean;
  } = {},
): SubagentTreeResponse {
  const liveById = new Map<string, (typeof extras.live)[number]>();
  for (const row of extras.live ?? []) {
    const id = row.subagentId || row.id || row.childSessionId;
    if (id) liveById.set(id, row);
  }
  const fromMeta = (extras.metas ?? []).map((meta) => {
    const live = liveById.get(meta.subagentId) ?? liveById.get(meta.childSessionId);
    const liveId = live ? (live.subagentId || live.id || live.childSessionId) : undefined;
    if (liveId) liveById.delete(liveId);
    const running = Boolean(live);
    return {
      sessionId: meta.childSessionId,
      parentSessionId: meta.parentSessionId || rootId,
      runId: meta.subagentId,
      agent: live?.subagentType || live?.agentType || meta.agent,
      task: live?.description || meta.task,
      state: running ? "running" as const : mapDiskStatus(meta.status),
      canSteer: running,
      canInterrupt: running,
      canResume: false,
      children: [],
    };
  });
  const leftovers = [...liveById.values()].map((live) => {
    const id = live.subagentId || live.id || live.childSessionId || "live";
    return {
      sessionId: live.childSessionId || id,
      parentSessionId: rootId,
      runId: id,
      agent: live.subagentType || live.agentType || "grok",
      task: live.description || "",
      state: "running" as const,
      canSteer: true,
      canInterrupt: true,
      canResume: false,
      children: [],
    };
  });
  const nodes = [...fromMeta, ...leftovers];
  if (nodes.length === 0) {
    // 没有 meta 时保留旧的 parentSessionId 回退，避免空树
    return grokSubagentTreeFromSessions(rootId, sessions, now, extras.rpcAvailable === true);
  }
  return {
    rootSessionId: rootId,
    rpcAvailable: extras.rpcAvailable === true,
    nodes,
    polledAt: now,
  };
}
```

把原来的 session 过滤逻辑抽成 `grokSubagentTreeFromSessions`；`rpcAvailable` 为 true 时不要带 `unavailableReason`，false 时 `unavailableReason: "offline"`。

`controlGrokSubagent` 的 runtime 类型加上可选 `cancelSubagent?(id: string)`：

- `interrupt`：有 `cancelSubagent` 就调它，**不要**再 `send(root, abort)`。没有该方法则 throw `"Subagent cancel is not available"`。
- `steer`：保持对根 `prompt` + `streamingBehavior: "steer"`。
- `resume`：`throw new Error("Subagent resume is not supported")`。

`AgentRuntime`：

```typescript
async listRunningSubagents(sessionId: string) {
  await this.ensureProcess();
  return this.requireAcp().subagentListRunning(sessionId);
}
async cancelSubagent(subagentId: string) {
  await this.ensureProcess();
  return this.requireAcp().subagentCancel(subagentId);
}
```

- [ ] **Step 4:** PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/acp/subagents.ts lib/acp/subagents.test.mjs lib/acp/runtime.ts lib/acp/runtime.test.mjs
git commit -m "$(cat <<'EOF'
feat: merge disk and live Grok subagent trees

EOF
)"
```

---

### Task 4: HTTP GET/POST 接到合并树

**Files:**
- Modify: `app/api/agent/[id]/subagents/route.ts`
- Create: `app/api/agent/[id]/subagents/grok-route.test.mjs`

不要改 `createSubagentHandlers`（那是 Pi 测试夹具）。只改文件底部导出的 `GET` / `POST`。

- [ ] **Step 1: Write failing tests**

用 temp `GROK_HOME`：建 `sessions/proj/root-1/summary.json` 和 `sessions/proj/root-1/subagents/child-1/meta.json`（status completed）。`findGrokSession` / `listAllSessions` 走 GROK_HOME。

1. GET `/api/agent/root-1/subagents`：200，`nodes[0].sessionId === "child-1"`，`state === "complete"`（ACP list_running 失败时仍列出磁盘，`rpcAvailable` false）。
2. 注入 `setAgentRuntime`：`listRunningSubagents` 返回 running 的 child-1 → GET `state === "running"`，`rpcAvailable` true。
3. POST interrupt：调用 `cancelSubagent("child-1")`，不要 `send` abort。
4. POST resume → 500/400，正文含 `not supported`。
5. POST steer 仍 `send` 根会话 steer prompt。

GET 需要允许的 session 列表：设 `GROK_HOME` 后 `listAllSessions` 必须能看到 `root-1`。`summary.json` 最小字段与现有 `session-http.test.mjs` 夹具一致，并带 `info.id`。

- [ ] **Step 2:** FAIL（GET 仍只靠 parentSessionId，没有 meta）。

- [ ] **Step 3: Implement**

导出 GET：

1. `listAllSessions()`，找不到 root → 404。
2. `findGrokSession(rootId)` 取 `path`，`listSubagentMetas(path)`。
3. 试 `getAgentRuntime().listRunningSubagents(rootId)`；失败则 `live = []`，`rpcAvailable = false`。
4. `return grokSubagentTree(rootId, sessions, Date.now(), { metas, live: live.subagents, rpcAvailable })`。

导出 POST：校验 action / childSessionId 同现在。`findGrokChild` 之外，若 metas 里 `childSessionId` 或 `subagentId` 匹配也算属于该根。interrupt 走 `controlGrokSubagent`（已 cancel）。resume 把错误变成 400。返回的 `tree` 用与 GET 相同的合并函数。

`findGrokChild` 可扩成同时看 metas；或在 route 里：`findGrokChild(...) || metas.some(...)`。

- [ ] **Step 4:**

```bash
node --experimental-strip-types --test \
  lib/acp/connection.test.mjs \
  lib/acp/runtime.test.mjs \
  lib/acp/subagents.test.mjs \
  lib/grok-fs/subagent-meta.test.mjs \
  app/api/agent/\[id\]/subagents/grok-route.test.mjs \
  app/api/agent/\[id\]/subagents/route.test.mjs
```

Expected: 全部 PASS。Pi 的 `route.test.mjs` 仍只测 `createSubagentHandlers`，不要改红。

- [ ] **Step 5: Commit**

```bash
git add app/api/agent/\[id\]/subagents/route.ts app/api/agent/\[id\]/subagents/grok-route.test.mjs lib/acp/subagents.ts
git commit -m "$(cat <<'EOF'
feat: serve the Grok subagent tree over the agent API

EOF
)"
```

---

## 自检

1. **规格：** 树 + 只读子会话 + 引导/暂停走根（暂停=对子代理 cancel，引导=根 steer）。
2. **无占位：** 方法名与字段已按探测写死。
3. **类型：** `subagentListRunning(sessionId)` / `subagentCancel(subagentId)` 前后一致。
4. **不做：** web spawn、Pi RPC 重写、视觉改版。
