# grok-web Models and Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 顶栏能列出并切换 Grok 模型 / effort；右栏文件读写与 Git / worktree 优先走 ACP `_x.ai/fs/*`、`_x.ai/git/*`，扩展不可用时本机只读、写操作仍给明确错误。

**Architecture:** 浏览器协议不变（`GET /api/models`、`POST /api/agent/:id` 的 `set_model` / `set_thinking_level`、`/api/files`、`/api/git/status`、`/api/worktrees`）。`AcpConnection` 增加已探过的 `_x.ai` / `session/set_model` / `session/set_mode`。测试只扩 `fake-agent.mjs`，不启动真 `grok`、不打真模型。

**Tech Stack:** 现有 Node + Vite + TanStack + `lib/acp/*` 行协议。

**本计划不做：** compact、登录/`x.ai/auth`、MCP 开关、子代理 `_x.ai/subagent/*`、改 Basic 用户名、浏览器视觉改版。

规格：`docs/superpowers/specs/2026-08-18-grok-web-design.md` 第 4 期（顶栏模型 + 右栏文件/Git）。

已对真 `grok agent stdio` 探过（实现必须按这个发）：

| UI | ACP |
| --- | --- |
| `GET /api/models` | `_x.ai/models/list` `{}` → `{ result: { currentModelId, availableModels[] } }`（JSON-RPC `result` 再包一层 `result`） |
| `set_model` | `session/set_model` `{ sessionId, modelId }` |
| `set_thinking_level` | `session/set_mode` `{ sessionId, modeId }`（`xhigh`/`high`/`medium`/`low`） |
| 列目录 / 读文件 | `_x.ai/fs/list` `{ path }` → `{ result: { nodes: [{ name, path, type, modifiedAt }] } }`；`_x.ai/fs/read_file` `{ path }` → `{ result: { content, size, lineCount, type } }` |
| 写文件 | `_x.ai/fs/write_file` `{ path, content }` |
| Git 状态 | `_x.ai/git/status`（相对 **grok 进程 cwd**，不是 params.cwd）。无 ACP 时用本机 `git` |
| worktree 列表 | `_x.ai/git/worktree/list` |
| worktree 创建 | `_x.ai/git/worktree/create` `{ sessionId, sourcePath }` → `{ result: { worktreePath, status } }` |
| worktree 删除 | `_x.ai/git/worktree/remove` `{ worktreePath }` 或 `{ idOrPath }` |

`get_state.model` 改为 `{ provider: "grok", id: <modelId> }`，`thinkingLevel` 为当前 `modeId` 或 `"off"`。

---

## File structure

| 路径 | 职责 |
| --- | --- |
| `lib/acp/connection.ts` | `modelsList` / `sessionSetModel` / `sessionSetMode` / `fsList` / `fsRead` / `fsWrite` / `gitStatus` / `worktreeList` / `worktreeCreate` / `worktreeRemove` |
| `lib/acp/fake-agent.mjs` | 上述方法的假实现 |
| `lib/acp/models.ts` | ACP models → pi-web `ModelsData` |
| `lib/acp/runtime.ts` | `set_model` / `set_thinking_level` / `listModels` / 记住 model+mode |
| `lib/grok-fs/workspace.ts` | 可选 ACP IO；有写通道则写，否则只读错误 |
| `app/api/models/route.ts` | 改走 runtime.listModels |
| `app/api/files/[...path]/route.ts` | 写走 ACP write，否则 501 |
| `app/api/git/status/route.ts` | 优先 ACP git status，否则本机 |
| `app/api/worktrees/route.ts` | 有 session 时 create/remove 走 ACP |

---

### Task 1: ACP 模型列表与 set_model / set_mode

**Files:**
- Modify: `lib/acp/connection.ts`
- Modify: `lib/acp/fake-agent.mjs`
- Modify: `lib/acp/connection.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
it("lists models and sets model and mode", async () => {
  const { child, acp } = spawnFake();
  try {
    await acp.initialize();
    const listed = await acp.modelsList();
    assert.equal(listed.currentModelId, "grok-4.6");
    assert.ok(listed.availableModels.some((m) => m.modelId === "grok-4.6"));
    const { sessionId } = await acp.sessionNew("/tmp/p");
    const set = await acp.sessionSetModel(sessionId, "grok-4.5");
    assert.equal(set.modelId, "grok-4.5");
    await acp.sessionSetMode(sessionId, "high");
  } finally {
    child.kill();
  }
});
```

- [ ] **Step 2:** `node --experimental-strip-types --test lib/acp/connection.test.mjs`  
Expected: FAIL，方法不存在。

- [ ] **Step 3: Implement**

`connection.ts`：

```typescript
function unwrapResult(value: unknown): unknown {
  if (value && typeof value === "object" && "result" in value) {
    return (value as { result: unknown }).result;
  }
  return value;
}

modelsList(): Promise<{ currentModelId: string; availableModels: Array<{ modelId: string; name?: string; _meta?: unknown }> }> {
  return this.rpc.request("_x.ai/models/list", {}).then((raw) => unwrapResult(raw) as never);
}

sessionSetModel(sessionId: string, modelId: string): Promise<{ modelId: string }> {
  return this.rpc.request("session/set_model", { sessionId, modelId }).then((raw) => {
    const meta = raw && typeof raw === "object" && "_meta" in raw
      ? (raw as { _meta?: { model?: { Ok?: string } } })._meta
      : undefined;
    return { modelId: meta?.model?.Ok ?? modelId };
  });
}

sessionSetMode(sessionId: string, modeId: string): Promise<unknown> {
  return this.rpc.request("session/set_mode", { sessionId, modeId });
}
```

`fake-agent.mjs` 增加内存 `currentModel = "grok-4.6"`：

```javascript
if (method === "_x.ai/models/list") {
  result(id, { result: { currentModelId: currentModel, availableModels: [
    { modelId: "grok-4.5", name: "Grok 4.5", _meta: { reasoningEfforts: [{ id: "high" }, { id: "medium" }, { id: "low" }] } },
    { modelId: "grok-4.6", name: "grok", _meta: { reasoningEfforts: [{ id: "xhigh" }, { id: "high" }, { id: "medium" }, { id: "low" }] } },
  ] } });
  return;
}
if (method === "session/set_model") {
  if (!params?.modelId) { error(id, -32602, "missing field modelId"); return; }
  currentModel = params.modelId;
  result(id, { _meta: { model: { Ok: params.modelId } } });
  return;
}
if (method === "session/set_mode") {
  if (!params?.modeId) { error(id, -32602, "missing field modeId"); return; }
  result(id, {});
  return;
}
```

`session/new` 也可带上同样的 `models` 字段（可选）。

- [ ] **Step 4:** connection 测试全绿。

- [ ] **Step 5:**

```bash
git add lib/acp/connection.ts lib/acp/connection.test.mjs lib/acp/fake-agent.mjs
git commit -m "feat: talk ACP models list set_model and set_mode"
```

---

### Task 2: Runtime set_model / set_thinking_level

**Files:**
- Modify: `lib/acp/runtime.ts`
- Modify: `lib/acp/runtime.test.mjs`

- [ ] **Step 1: Failing tests**

```javascript
it("set_model and set_thinking_level update get_state", async () => {
  const runtime = createRuntime();
  const sessionId = await runtime.createSession("/tmp/p");
  await runtime.send(sessionId, { type: "set_model", provider: "grok", modelId: "grok-4.5" });
  await runtime.send(sessionId, { type: "set_thinking_level", level: "high" });
  const state = await runtime.send(sessionId, { type: "get_state" });
  assert.deepEqual(state.model, { provider: "grok", id: "grok-4.5" });
  assert.equal(state.thinkingLevel, "high");
});
```

- [ ] **Step 2:** FAIL（仍 `not implemented in this phase`）。

- [ ] **Step 3:** `SessionState` 增加 `modelId?: string`、`thinkingLevel?: string`。`createSession` 后默认 `grok-4.6` / `"off"`。

```typescript
case "set_model": {
  await this.ensureProcess();
  const modelId = stringField(command.modelId);
  if (!modelId) throw new Error("modelId is required");
  const set = await this.requireAcp().sessionSetModel(sessionId, modelId);
  const session = this.ensureSession(sessionId);
  session.modelId = set.modelId;
  return { provider: "grok", id: session.modelId };
}
case "set_thinking_level": {
  await this.ensureProcess();
  const level = stringField(command.level);
  if (!level) throw new Error("level is required");
  if (level !== "off") await this.requireAcp().sessionSetMode(sessionId, level);
  this.ensureSession(sessionId).thinkingLevel = level;
  return { level };
}
```

`getState` 用 `session.modelId ?? "grok"` 与 `session.thinkingLevel ?? "off"`。

`listModels()`：`ensureProcess` 后 `modelsList()`，交给 Task 3 的 mapper；本任务可先返回 raw。若本任务只做 set_*，`listModels` 放到 Task 3。

- [ ] **Step 4:** `lib/acp/runtime.test.mjs` 全绿。

- [ ] **Step 5:**

```bash
git add lib/acp/runtime.ts lib/acp/runtime.test.mjs
git commit -m "feat: switch Grok model and effort from the agent API"
```

---

### Task 3: 映射模型列表并接 `GET /api/models`

**Files:**
- Create: `lib/acp/models.ts`
- Test: `lib/acp/models.test.mjs`
- Modify: `lib/acp/runtime.ts`（`listModels()`）
- Modify: `app/api/models/route.ts`（失败时走 runtime，不再 `createAgentSessionServices`）
- Test: `lib/acp/models-http.test.mjs` 或扩 `http.test.mjs`

- [ ] **Step 1:**

```javascript
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapGrokModels } from "./models.ts";

describe("mapGrokModels", () => {
  it("maps ACP models into pi-web ModelsData", () => {
    const data = mapGrokModels({
      currentModelId: "grok-4.6",
      availableModels: [
        { modelId: "grok-4.6", name: "grok", _meta: { reasoningEfforts: [{ id: "xhigh" }, { id: "high" }] } },
        { modelId: "grok-4.5", name: "Grok 4.5", _meta: { reasoningEfforts: [{ id: "high" }] } },
      ],
    });
    assert.equal(data.defaultModel.provider, "grok");
    assert.equal(data.defaultModel.modelId, "grok-4.6");
    assert.ok(data.modelList.some((m) => m.provider === "grok" && m.id === "grok-4.5"));
    assert.deepEqual(data.thinkingLevels["grok:grok-4.6"], ["xhigh", "high"]);
    assert.equal(data.models["grok:grok-4.6"], "grok");
  });
});
```

- [ ] **Step 2:** FAIL。

- [ ] **Step 3:**

```typescript
import type { ModelsData } from "../models-cache.ts";

export function mapGrokModels(listed: {
  currentModelId?: string;
  availableModels?: Array<{ modelId?: string; name?: string; _meta?: { reasoningEfforts?: Array<{ id?: string }> } }>;
}): ModelsData {
  const models: Record<string, string> = {};
  const modelList: ModelsData["modelList"] = [];
  const thinkingLevels: Record<string, string[]> = {};
  const thinkingLevelMaps: Record<string, Record<string, string | null>> = {};
  for (const item of listed.availableModels ?? []) {
    if (!item.modelId) continue;
    const key = `grok:${item.modelId}`;
    models[key] = item.name || item.modelId;
    modelList.push({ id: item.modelId, name: item.name || item.modelId, provider: "grok" });
    const efforts = (item._meta?.reasoningEfforts ?? []).map((e) => e.id).filter((id): id is string => Boolean(id));
    if (efforts.length) thinkingLevels[key] = efforts;
  }
  const current = listed.currentModelId && modelList.some((m) => m.id === listed.currentModelId)
    ? listed.currentModelId
    : modelList[0]?.id;
  return {
    models,
    modelList,
    defaultModel: current ? { provider: "grok", modelId: current } : null,
    thinkingLevels,
    thinkingLevelMaps,
    thinkingLevelPins: {},
  };
}
```

`AgentRuntime.listModels()`：`mapGrokModels(await this.requireAcp().modelsList())`。

`app/api/models/route.ts` 的 `loadModels`：try `getAgentRuntime().listModels()`，失败再 `withSafeModelLoadFailure` 空列表（不要再调会抛的 `createAgentSessionServices`）。保留 `cwd` 校验。

HTTP 测试：`createRuntime` + 调 `runtime.listModels()` 或抽 `loadGrokModels()`。

- [ ] **Step 4:** `lib/acp/models.test.mjs` + `lib/acp/*.test.mjs` 全绿。

- [ ] **Step 5:**

```bash
git add lib/acp/models.ts lib/acp/models.test.mjs lib/acp/runtime.ts app/api/models/route.ts
git commit -m "feat: serve Grok models on GET /api/models"
```

---

### Task 4: ACP fs list / read / write

**Files:**
- Modify: `lib/acp/connection.ts`
- Modify: `lib/acp/fake-agent.mjs`
- Modify: `lib/acp/connection.test.mjs`

- [ ] **Step 1:**

```javascript
it("lists reads and writes files over _x.ai/fs", async () => {
  const { child, acp } = spawnFake();
  try {
    await acp.initialize();
    const listed = await acp.fsList("/tmp/p");
    assert.ok(Array.isArray(listed.nodes));
    await acp.fsWrite("/tmp/p/a.txt", "hi");
    const read = await acp.fsRead("/tmp/p/a.txt");
    assert.equal(read.content, "hi");
  } finally {
    child.kill();
  }
});
```

- [ ] **Step 2:** FAIL。

- [ ] **Step 3:**

```typescript
fsList(path: string): Promise<{ nodes: Array<{ name: string; path: string; type: string }> }> {
  return this.rpc.request("_x.ai/fs/list", { path }).then((raw) => unwrapResult(raw) as never);
}
fsRead(path: string): Promise<{ content: string }> {
  return this.rpc.request("_x.ai/fs/read_file", { path }).then((raw) => unwrapResult(raw) as never);
}
fsWrite(path: string, content: string): Promise<void> {
  return this.rpc.request("_x.ai/fs/write_file", { path, content }).then(() => undefined);
}
```

fake-agent 用 `Map` 存文件内容；`fs/list` 对已知前缀返回 nodes（至少写入后能 read 到）。

- [ ] **Step 4:** PASS。

- [ ] **Step 5:**

```bash
git add lib/acp/connection.ts lib/acp/connection.test.mjs lib/acp/fake-agent.mjs
git commit -m "feat: list read and write files over ACP"
```

---

### Task 5: workspace 优先 ACP 写

**Files:**
- Modify: `lib/grok-fs/workspace.ts`
- Modify: `lib/grok-fs/workspace.test.mjs`
- Modify: `app/api/files/[...path]/route.ts`

- [ ] **Step 1:** 在 workspace 测试里加：

```javascript
it("writes through an injected ACP writer", async () => {
  const files = new Map();
  const written = await writeWorkspaceFile("/tmp/p", "a.txt", "hi", {
    write: async (abs, content) => { files.set(abs, content); },
  });
  assert.equal(written, true);
  assert.equal([...files.values()][0], "hi");
});

it("still refuses writes without a writer", () => {
  assert.throws(() => refuseWorkspaceWrite(), /read-only/i);
});
```

- [ ] **Step 2:** FAIL。

- [ ] **Step 3:**

```typescript
export type WorkspaceWriter = {
  write: (absPath: string, content: string) => Promise<void>;
};

export async function writeWorkspaceFile(
  root: string,
  relPath: string,
  content: string,
  io?: WorkspaceWriter,
): Promise<boolean> {
  const abs = assertInsideRoot(root, join(root, relPath));
  if (!io) refuseWorkspaceWrite();
  await io.write(abs, content);
  return true;
}
```

`files` POST：在 `refuseWorkspaceWrite()` 之前，若 `getAgentRuntime()` 有可用 ACP，则对每个上传文件 `writeWorkspaceFile` + `acp.fsWrite`。没有 ACP 再 501。

实现时抽 `getWorkspaceWriter(): WorkspaceWriter | undefined`：`ensureProcess` 失败（grok-missing）返回 undefined。

测试 workspace 层即可；路由保持调用该函数。

- [ ] **Step 4:** workspace 测试 PASS。`lib/acp/*.test.mjs` 仍绿。

- [ ] **Step 5:**

```bash
git add lib/grok-fs/workspace.ts lib/grok-fs/workspace.test.mjs app/api/files/[...path]/route.ts
git commit -m "feat: write project files through ACP when grok is up"
```

---

### Task 6: Git status + worktree 经 ACP

**Files:**
- Modify: `lib/acp/connection.ts`
- Modify: `lib/acp/fake-agent.mjs`
- Modify: `lib/grok-fs/workspace.ts`
- Modify: `lib/grok-fs/workspace.test.mjs`
- Modify: `app/api/git/status/route.ts`
- Modify: `app/api/worktrees/route.ts`

- [ ] **Step 1:**

```javascript
it("returns ACP git status when a client is provided", async () => {
  const status = await readWorkspaceGitStatus("/tmp/p", {
    gitStatus: async () => ({ branch: "main", isGitRepository: true, unstaged: [] }),
  });
  assert.equal(status.isGitRepository, true);
  assert.equal(status.branch, "main");
});

it("creates a worktree through ACP instead of refusing", async () => {
  const created = await createWorkspaceWorktree("/tmp/p", "feat/x", {
    worktreeCreate: async () => ({ worktreePath: "/tmp/p-wt", status: "creating" }),
  });
  assert.equal(created.worktreePath, "/tmp/p-wt");
});
```

- [ ] **Step 2:** FAIL。

- [ ] **Step 3:**

```typescript
gitStatus(): Promise<unknown> {
  return this.rpc.request("_x.ai/git/status", {}).then(unwrapResult);
}
worktreeList(): Promise<unknown> {
  return this.rpc.request("_x.ai/git/worktree/list", {}).then(unwrapResult);
}
worktreeCreate(sessionId: string, sourcePath: string): Promise<{ worktreePath?: string; status?: string }> {
  return this.rpc.request("_x.ai/git/worktree/create", { sessionId, sourcePath }).then((raw) => unwrapResult(raw) as never);
}
worktreeRemove(worktreePath: string): Promise<unknown> {
  return this.rpc.request("_x.ai/git/worktree/remove", { worktreePath }).then(unwrapResult);
}
```

fake-agent：`git/status` 返回 `{ root, branch: "main", staged: [], unstaged: [] }`；`worktree/list` `[]`；`worktree/create` `{ worktreePath: sourcePath + "-wt", status: "creating" }`；`worktree/remove` `{}`。

`readWorkspaceGitStatus(cwd, io?)`：有 `io.gitStatus` 用它，否则现有本机 git。

`createWorkspaceWorktree` / `removeWorkspaceWorktree`：有 IO 走 ACP，否则 `refuseWorktreeWrite()`。

`GET /api/git/status`：尝试 runtime ACP，失败用本机 `getGitStatus`（现有行为）。映射保持现有 JSON 形状时，可在适配器里把 ACP `{ branch, unstaged }` 译成 `GitStatusResponse`；译不了就回落本机。

`POST/DELETE /api/worktrees`：有 writer 则 ACP，否则 501。

- [ ] **Step 4:** workspace + acp 测试 PASS。

- [ ] **Step 5:**

```bash
git add lib/acp/connection.ts lib/acp/fake-agent.mjs lib/grok-fs/workspace.ts lib/grok-fs/workspace.test.mjs app/api/git/status/route.ts app/api/worktrees/route.ts
git commit -m "feat: git status and worktrees over ACP with local fallback"
```

---

## Self-review

**Spec coverage:** 顶栏模型/effort → Task 1–3。右栏文件读写 → Task 4–5。Git / worktree → Task 6。扩展不可用时只读 + 明确写错误仍在 workspace 默认路径。

**Placeholder scan:** 无 TBD。

**Type consistency:** `modelsList` / `unwrapResult`、`WorkspaceWriter`、`worktreeCreate(sessionId, sourcePath)` 前后一致。`get_state.model.id` 为 Grok `modelId`。

**已知限制：** `_x.ai/git/status` 用 grok 进程 cwd，不是请求里的项目路径；HTTP 在 ACP 结果对不上 cwd 时回落本机 git。测试不创建真 worktree。
