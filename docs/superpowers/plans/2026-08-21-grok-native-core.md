# Grok-native core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 壳不动，把内部模型和测试改成以 Grok ACP 为真相，并删掉 Pi 会话引擎、pi-stubs、双 HTTP 树这些兼容层。

**Architecture:** ACP `session/update` 与 `~/.grok/sessions/**/updates.jsonl` 是唯一对话真相。`history-map` / `map-events` / `permissions` 把 ACP 译成 grok-web 的 `AgentMessage` 与 SSE wire。UI 只渲染该模型。`rpc-manager` 不再出现在任何运行路径。HTTP 仍是 `/api/agent` `/api/sessions` `/api/files` `/api/git`，但 `src/routes` 直接调 `lib/`，不再经 `app/api`。

**Tech Stack:** 现有 Node 22 + Vite + TanStack Start + 本仓库 ACP JSON-RPC。测试：`node --experimental-strip-types --test`。假进程：`lib/acp/fake-agent.mjs`。真 `grok` 不进单测。

规格：`docs/superpowers/specs/2026-08-21-grok-native-core-design.md`

**本计划不做：** 新视觉、换框架、重写 `AppShell`/`CodexSidebar`/`FileViewer`、把 URL 改成另一套 REST、为 Pi 兼容保留 SSE 事件名以外的行为。SSE 事件名可沿用，当作 grok-web wire，不承诺兼容 pi-web。

---

## File structure

| 路径 | 职责 |
| --- | --- |
| `lib/acp/fixtures/` | 从真实 ACP 裁剪的 jsonl/json 金样例 |
| `lib/acp/map-events.ts` | 实时：ACP update → grok-web SSE |
| `lib/history-map.ts` | 历史：updates.jsonl → `AgentMessage[]` |
| `lib/acp/permissions.ts` | `session/request_permission` → 权限对话框模型 |
| `lib/grok-tool-input.ts` | 稳定工具名 + 去掉 Grok schema 填充 |
| `lib/acp/runtime.ts` | 唯一会话引擎（已存在；吃掉 rpc-manager 的剩余调用） |
| `lib/acp/http.ts` | `/api/agent` 命令入口（已存在） |
| `src/routes/api/**` | 唯一 HTTP 适配器，直接 import `lib/` |
| `hooks/useAgentSession.ts` | 消费 grok-web SSE；不再假设 Pi 工具名 |
| `components/MessageView.tsx` | 展示规范化后的 toolName/command/result |
| `app/api/**` | **删除**（Task 4 之后） |
| `lib/rpc-manager.ts` | **删除**（Task 5 之后） |
| `lib/pi-stubs/**` | **删除**（Task 6 之后） |

运行时热路径（目标）：

```
浏览器 ChatWindow
  → POST /api/agent/:id  { type: "prompt" }
  → lib/acp/http.ts → AgentRuntime.send
  → grok agent stdio session/prompt
  → session/update → AcpTurnMapper.push → SSE
  → useAgentSession → MessageView
磁盘历史：updates.jsonl → mapUpdatesJsonl → 同一套 AgentMessage
```

---

### Task 1: ACP 金样例夹具

没有这批夹具，后面每一刀都是盲拆。先把真实 Grok 载荷变成可重放测试。

**Files:**
- Create: `lib/acp/fixtures/tool-bash.jsonl`
- Create: `lib/acp/fixtures/tool-read.jsonl`
- Create: `lib/acp/fixtures/permission-bash.json`
- Create: `lib/acp/fixtures/README.md`
- Modify: `lib/history-map.test.mjs`
- Modify: `lib/acp/map-events.test.mjs`
- Modify: `lib/acp/permissions.test.mjs`

夹具必须从真实 ACP 形状裁剪（可手工缩短 command/stdout），禁止改回 `title: "bash"` 当终端工具的主用例。

- [ ] **Step 1: 写入 bash 夹具**

`lib/acp/fixtures/tool-bash.jsonl`（每行一条 `session/update` 记录，与磁盘 `updates.jsonl` 同构）：

```json
{"timestamp":1,"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"help"}},"_meta":{"eventId":"u1"}}}
{"timestamp":1,"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"tool_call","toolCallId":"call-aaaa-1","title":"run_terminal_command","rawInput":{"command":"ls","description":"List files"}},"_meta":{"eventId":"a1"}}}
{"timestamp":1,"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"tool_call_update","toolCallId":"call-aaaa-1","title":"Execute `ls`","kind":"execute","rawInput":{"variant":"Bash","command":"ls","description":"List files","is_background":false},"content":[{"type":"content","content":{"type":"text","text":"List files"}}]}}}
{"timestamp":1,"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"tool_call_update","toolCallId":"call-aaaa-1","status":"completed","content":[{"type":"content","content":{"type":"text","text":"a.ts\n"}}]}}}
```

`lib/acp/fixtures/tool-read.jsonl`：先 `title: read_file`，再 `title: Read \`/tmp/a.ts\``、`kind: read`，completed content 为嵌套 text。

`lib/acp/fixtures/permission-bash.json`：

```json
{
  "sessionId": "s",
  "toolCall": {
    "title": "run_terminal_command",
    "kind": "execute",
    "rawInput": {
      "variant": "Bash",
      "command": "ls -la ~/.grok",
      "description": "Inspect grok home",
      "is_background": false
    }
  },
  "options": [
    { "optionId": "allow-once", "name": "Allow once", "kind": "allow_once" },
    { "optionId": "allow-always", "name": "Allow always", "kind": "allow_always" },
    { "optionId": "reject", "name": "Reject", "kind": "reject" }
  ]
}
```

- [ ] **Step 2: 把现有 mapper 测试改成读夹具（先跑，确认已绿或暴露缺口）**

在 `lib/history-map.test.mjs` 增加（若 Task 已有同类断言，改为 `readFileSync` 夹具，不要两套真相）：

```javascript
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "acp/fixtures");

it("replays the Grok bash fixture without the description prefix", () => {
  const { messages } = mapUpdatesJsonl(readFileSync(join(fixtures, "tool-bash.jsonl"), "utf8"));
  const tool = messages[1].content[0];
  assert.equal(tool.toolName, "bash");
  assert.equal(tool.input.command, "ls");
  assert.equal(messages[2].role, "toolResult");
  assert.equal(messages[2].content[0].text, "a.ts\n");
});
```

`map-events.test.mjs`：对同一 bash 序列，`toolcall_end.toolCall.name === "bash"`，后续 update 的 `toolName` 仍是 `bash`，不得变成 `Execute \`ls\``。

`permissions.test.mjs`：`translatePermissionRequest(JSON.parse(permission-bash.json), 1).message === "bash\nls -la ~/.grok"`。

- [ ] **Step 3: 跑测试**

```bash
在仓库根目录运行后续命令
node --experimental-strip-types --test lib/history-map.test.mjs lib/acp/map-events.test.mjs lib/acp/permissions.test.mjs
```

Expected: PASS（bash 规范化已在 2026-08-21 落地；本 Task 是把真相搬进夹具，防止回潮）。若 FAIL，先修 mapper，不要改夹具去迁就 Pi。

- [ ] **Step 4: 补齐规格最低集里尚未单独成文件的夹具**

同目录再加三个小文件（仍从真实 ACP 裁剪，可缩短）：

- `prompt-image.json`：`session/prompt` 的 `prompt` 数组含 `{ type: "image", mimeType, data }`（不要 `resource`/`path`）
- `chunked-tool-ids.jsonl`：同一 uuid 的 `call-<uuid>-1` 与 `call-<uuid>-2` 两次 tool_call
- `signals-overlay.json`：`signals.json` 的 lifetime 计数 + 一段 `chat_history.jsonl` 当前窗口（用于 `lib/session-signals.test.mjs`）

对应测试：

- `lib/acp/prompt-images.test.mjs` 读 `prompt-image.json`，断言发出的 ACP 块是 `type: "image"`
- `lib/session-signals.test.mjs` 读 chunked ids / overlay，断言 `toolCalls` 按 uuid 折叠，不按 chunk 行数

规格第 5 节最低集必须都能 `readFileSync` 到 `lib/acp/fixtures/`。

- [ ] **Step 5: 夹具 README 写明规则**

`lib/acp/fixtures/README.md`：

- 新 mapper 测试优先加夹具文件，再 assert
- 终端工具夹具必须含 `run_terminal_command`，不能只用 `title: "bash"`
- 不要提交完整私人会话；命令与路径可缩短

- [ ] **Step 6: Commit**

```bash
git add lib/acp/fixtures lib/history-map.test.mjs lib/acp/map-events.test.mjs lib/acp/permissions.test.mjs lib/acp/prompt-images.test.mjs lib/session-signals.test.mjs
git commit -m "test: pin Grok ACP fixtures as mapper source of truth"
```

---

### Task 2: 展示层只消费规范化 Grok 消息

把还留在 UI / 实时路径上的 Pi 假设清掉。壳组件不重写，只改数据怎么到卡片上。

**Files:**
- Modify: `hooks/useAgentSession.ts`（`tool_execution_update` 要把结果挂到正在流的 tool 卡上）
- Modify: `components/ChatWindow.tsx`（streaming `MessageView` 传入 `toolResults`）
- Modify: `lib/acp/fake-agent.mjs`（发出 Grok 形状的 tool_call，而不是 `title: "bash"` 独苗）
- Test: `hooks/useAgentSession.test.mjs`
- Test: `components/MessageView.test.mjs`（已有 run_terminal_command 用例，保持）

- [ ] **Step 1: 写失败测试 — 实时 bash 结果要出现在卡片上，且不含 description**

在 `hooks/useAgentSession.test.mjs`（或更小的 `lib/acp/map-events` + ChatWindow 源码契约测试）断言：

1. `tool_execution_update` 的 `partialResult.content` 为 Grok 嵌套块时，进度/结果文本能解析
2. ChatWindow 给 streaming `MessageView` 传了 `toolResults`

最小契约测试（ChatWindow 源码，与现有 `ChatWindow.dialogs.test.mjs` 同风格）：

```javascript
test("streaming tool cards receive toolResults", () => {
  assert.match(source, /streamState\.streamingMessage/);
  assert.match(source, /toolResults=\{/);
});
```

更完整的行为测试放 mapper：completed update 之后，`toolResultText(partialResult)` 为 stdout，不等于 description。

- [ ] **Step 2: 跑测试确认失败**

```bash
node --experimental-strip-types --test components/ChatWindow.dialogs.test.mjs hooks/useAgentSession.test.mjs
```

Expected: FAIL，因为 streaming `MessageView` 目前不传 `toolResults`。

- [ ] **Step 3: 最小实现**

`ChatWindow.tsx` 里 streaming 那行补上与历史消息相同的 `toolResults={toolResultsMap}`。

`useAgentSession.ts` 的 `tool_execution_update`：用 `toolResultText` + `applyToolOutputUpdate` 维护一份 `liveToolResults: Map<string, ToolResultMessage>`，在 `agent_start` 清空，在 `message_end` / `agent_end` 与持久化 messages 合并后清空。ChatWindow 把 `liveToolResults` 与历史 map 合成后再传。

不要在 MessageView 里解析 ACP 嵌套 content；解析只发生在 `history-map.ts` / `tool-execution-progress.ts`。

历史重载用户图：`mapUpdatesJsonl` / session-reader 必须把用户消息里的 ACP image 块还原成 `UserMessage` 的 image content（规格第 4 节）。加一条夹具测试：user_message 含 image 时，重载后 `MessageView` 仍能看到图，而不是只剩文字。

- [ ] **Step 4: fake-agent 终端工具改成 Grok 形状**

`lib/acp/fake-agent.mjs` 里若测试发 bash，改成：

```javascript
notify("session/update", {
  sessionId,
  update: {
    sessionUpdate: "tool_call",
    toolCallId: "call-fake-1",
    title: "run_terminal_command",
    rawInput: { command: "ls", description: "List files" },
  },
});
```

补一条 runtime/http 测试：假进程这条更新映射后 `toolName === "bash"`。

- [ ] **Step 5: 跑测试**

```bash
node --experimental-strip-types --test components/MessageView.test.mjs components/ChatWindow.dialogs.test.mjs hooks/useAgentSession.test.mjs lib/acp/map-events.test.mjs lib/acp/runtime.test.mjs
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add hooks/useAgentSession.ts components/ChatWindow.tsx lib/acp/fake-agent.mjs hooks/useAgentSession.test.mjs
git commit -m "fix: stream Grok tool results into chat cards"
```

---

### Task 3: 内部类型脱离 pi-stubs

把「Pi 事件类型」从编译图里摘掉。行为不变，import 变。

**Files:**
- Create: `lib/agent-events.ts`（grok-web SSE 事件联合类型，取代 `JsonAgentSessionEvent`）
- Modify: `lib/agent-event-wire.ts`（改为从 `agent-events.ts` import，删除 `pi-stubs/coding-agent`）
- Modify: `lib/types.ts`（去掉文件头 “mirrored from pi-mono”；BashExecutionMessage 标为 composer-only，agent 终端工具走 toolCall）
- Modify: `lib/pi-types.ts`（只留 UI 仍用的 SessionStatsInfo / ContextUsage，或把这些搬到 `lib/types.ts` 后删除本文件的 stub import）
- Modify: 所有 `from "@/lib/pi-stubs/agent-core"` / `coding-agent` 的类型-only import
- Test: `lib/agent-event-wire.test.mjs`
- Test: `lib/pi-stub-api-guard.test.mjs`（扩大：禁止 `hooks/` `components/` `lib/` 除 `pi-stubs` 自身外再 import stub）

- [ ] **Step 1: 写失败测试 — 生产代码不得 import pi-stubs（先允许 getAgentDir 白名单，Task 6 再删）**

扩展 `lib/pi-stub-api-guard.test.mjs`：

```javascript
test("lib and hooks do not import pi-stubs except grokHome wrappers", () => {
  const allowed = new Set([
    "lib/pi-stubs/coding-agent.ts", // 本 Task 后只剩 getAgentDir，Task 6 删除
  ]);
  const hits = [];
  for (const file of walk(join(process.cwd(), "lib")).concat(walk(join(process.cwd(), "hooks")))) {
    if (file.includes("/pi-stubs/")) continue;
    const source = readFileSync(file, "utf8");
    if (source.includes("lib/pi-stubs") || source.includes("pi-stubs/")) {
      hits.push(relative(process.cwd(), file));
    }
  }
  assert.deepEqual(hits.filter((h) => !h.endsWith(".test.mjs")), []);
});
```

先跑：Expected FAIL，命中 `agent-event-wire.ts`、`pi-types.ts`、`startup-preferences.ts`、`model-scope.ts`、`session-title.ts`、若干 `app/api`。

- [ ] **Step 2: 抽出 grok-web 事件类型**

`lib/agent-events.ts` 只描述 wire 上真实出现的字段（对照 `useAgentSession.ts` 的 `switch (event.type)`）：

```typescript
export type GrokWireEvent =
  | { type: "connected"; sessionId: string; isStreaming?: boolean }
  | { type: "context_usage"; contextUsage: unknown }
  | { type: "agent_start" }
  | { type: "agent_end" }
  | { type: "agent_settled" }
  | { type: "prompt_done" }
  | { type: "prompt_error"; errorMessage?: string }
  | { type: "message_start"; message?: unknown }
  | { type: "message_update"; assistantMessageEvent: unknown; message?: unknown }
  | { type: "message_end"; message?: unknown }
  | { type: "tool_execution_update"; toolCallId: string; toolName?: string; partialResult?: unknown }
  | { type: "queue_update"; steering?: string[]; followUp?: string[] }
  | { type: "extension_ui_request"; id: string; method: string; [k: string]: unknown }
  | { type: string; [k: string]: unknown };
```

`toClientAgentEvent` 的输入输出改用这个类型。不要从 `JsonAgentSessionEvent` 做 Extract。

`getAgentDir()` 的调用点本 Task 先改成 `grokHome()`（`lib/grok-home.ts` 已存在），这样 API 路由不再需要 stub。

- [ ] **Step 3: 跑测试**

```bash
node --experimental-strip-types --test lib/pi-stub-api-guard.test.mjs lib/agent-event-wire.test.mjs lib/acp/runtime.test.mjs
```

Expected: PASS，guard 的 hits 为空（或只剩计划在 Task 6 删除的文件，把白名单写进断言注释）。

- [ ] **Step 4: Commit**

```bash
git add lib/agent-events.ts lib/agent-event-wire.ts lib/types.ts lib/pi-types.ts lib/pi-stub-api-guard.test.mjs
git commit -m "refactor: drop pi-stub types from grok-web wire"
```

---

### Task 4: 单 HTTP 树

现在 `src/routes/api/foo.ts` 再 export `app/api/foo/route.ts`，改一处漏一处。目标：handler 只住 `lib/`，TanStack route 是唯一 HTTP 入口。

**Files:**
- Modify: `src/routes/api/**/*.ts`（改为 `import { GET } from "@/lib/..."` 或现有 `lib/acp/http.ts` / `lib/session-http.ts`）
- Modify: `lib/tanstack-route-inventory.test.mjs`（`EXPECTED_ROUTES` 不再要求 `app/api`）
- Delete: `app/api/**`（在 inventory 与所有 src/routes 切换完成后）
- Test: `scripts/tanstack-route-smoke.mjs` 仍能探到同样的 method/status

- [ ] **Step 1: 写失败测试 — inventory 只认 src/routes**

把 `lib/tanstack-route-inventory.test.mjs` 的 `EXPECTED_ROUTES`（`app/api/...`）改成断言：不存在 `app/api` 文件，或 `app/api` 目录不存在。

先改测试再删目录：Expected FAIL because `app/api` still exists.

- [ ] **Step 2: 逐个把薄 `app/api/*/route.ts` 的函数挪到已有 lib http 模块**

已在 lib 的不要再包一层，例如：

```typescript
// src/routes/api/agent/$id.ts
import { createFileRoute } from "@tanstack/react-router";
import { createAgentHandlers } from "@/lib/acp/http";
import { getAgentRuntime } from "@/lib/acp/runtime";

export const Route = createFileRoute("/api/agent/$id")({
  server: {
    handlers: {
      GET: ({ request, params }) => createAgentHandlers(getAgentRuntime()).getSession(request, params.id),
      POST: ({ request, params }) => createAgentHandlers(getAgentRuntime()).postSession(request, params.id),
    },
  },
});
```

仍有业务代码的 `app/api` 文件（如 `project-trust`、`subagents`）把 handler 函数搬到 `lib/project-trust-http.ts` / `lib/subagent-http.ts`，src/routes 只接这些函数。

一次可搬一组（agent / sessions / git / settings），每组跑：

```bash
node --experimental-strip-types --test lib/tanstack-route-inventory.test.mjs lib/acp/http.test.mjs lib/session-http.test.mjs
```

- [ ] **Step 3: 删除 `app/api` 后跑 inventory + route smoke**

```bash
node --experimental-strip-types --test lib/tanstack-route-inventory.test.mjs
node scripts/tanstack-route-smoke.mjs
```

Expected: PASS；仓库里不再有 `app/api/**/route.ts`。

- [ ] **Step 4: Commit**

```bash
git add src/routes/api lib app/api lib/tanstack-route-inventory.test.mjs
git commit -m "refactor: serve HTTP only from TanStack routes to lib handlers"
```

---

### Task 5: 删除 rpc-manager

主对话早已走 `AgentRuntime`。残留调用点：

- `app/api/agent/[id]/subagents/route.ts`（Task 4 后是 `lib/subagent-http.ts`）的 `getRpcSession` / `startRpcSession`
- `app/api/project-trust/route.ts` 的 `hasBusyRpcSessionForCwd` / `destroyRpcSessionsForCwd`

ACP 侧已有：`getAgentRuntime()`、`controlGrokSubagent`、`hasBusySessionForCwd`、`dropSessionsForCwd`。

**Files:**
- Modify: `lib/subagent-http.ts`（或当前 subagents handler）— `defaultDeps` 不再碰 rpc-manager
- Modify: project-trust handler — 只问 `getAgentRuntime()`
- Delete: `lib/rpc-manager.ts`
- Delete: `lib/rpc-manager.test.mjs` `lib/rpc-manager-shutdown.test.mjs` `lib/rpc-manager-widgets.test.mjs` `lib/rpc-session-info.test.mjs`
- Modify: 所有 `assert.doesNotMatch(..., /startRpcSession/)` 测试，改为断言文件不存在或不再出现该符号
- Test: `lib/acp/subagents.test.mjs` `app/api/agent/[id]/subagents` 现有测试 `lib/project-trust.test.mjs`

- [ ] **Step 1: 写失败测试 — 生产代码没有 rpc-manager 符号**

```javascript
test("runtime paths do not import rpc-manager", () => {
  const source = [
    readFileSync(new URL("./acp/runtime.ts", import.meta.url), "utf8"),
    readFileSync(new URL("./acp/http.ts", import.meta.url), "utf8"),
  ].join("\n");
  assert.doesNotMatch(source, /rpc-manager/);
});
```

再加一条 walk：`lib/` `src/` `hooks/` `components/` 不含 `startRpcSession`。先跑：Expected FAIL（subagents/trust 仍引用）。

- [ ] **Step 2: 切 subagents / trust 到 AgentRuntime**

`createSubagentHandlers` 的 deps 改为：

```typescript
{
  listSessions: () => listAllSessions(),
  runtime: getAgentRuntime(),
  resolveSessionPath,
}
```

树与控制只走 `grokSubagentTree` / `controlGrokSubagent` / `runtime.send`。`rpcAvailable` 表示 ACP runtime 是否已有该 session，不再表示 Pi RPC wrapper。

project-trust POST：

```typescript
if (getAgentRuntime().hasBusySessionForCwd(result.cwd)) {
  return Response.json({ error: "Wait for the active session to finish before trusting this project" }, { status: 409 });
}
await getAgentRuntime().dropSessionsForCwd(result.cwd);
```

删除 `hasBusyRpcSessionForCwd` / `destroyRpcSessionsForCwd`。

- [ ] **Step 3: 删除 rpc-manager 文件并跑测试**

```bash
node --experimental-strip-types --test lib/acp/subagents.test.mjs lib/acp/runtime.test.mjs lib/project-trust.test.mjs
```

Expected: PASS；`lib/rpc-manager.ts` 不存在。若还有测试读该文件做源码契约，一并改掉或删除。

- [ ] **Step 4: Commit**

```bash
git add lib src hooks components
git commit -m "refactor: remove Pi rpc-manager session engine"
```

---

### Task 6: 删除 pi-stubs

Task 3 之后 stub 应只剩空壳或 `getAgentDir`。本 Task 删目录。

**Files:**
- Delete: `lib/pi-stubs/**`
- Delete: `lib/pi-stub-api-guard.test.mjs`（改为更简单的 “no pi-stubs directory” 断言，可放 `lib/grok-home.test.mjs`）
- Modify: `eslint.config.mjs` 里 `lib/pi-stubs/**` override
- Modify: 任何剩余 `getAgentDir` import → `grokHome`

- [ ] **Step 1: 写失败测试**

```javascript
test("pi-stubs directory is gone", () => {
  assert.equal(existsSync(join(process.cwd(), "lib/pi-stubs")), false);
});
```

Expected: FAIL

- [ ] **Step 2: 删除目录，修 import，跑全量相关测试**

```bash
node --experimental-strip-types --test lib/grok-home.test.mjs lib/project-trust.test.mjs lib/acp/runtime.test.mjs
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add lib eslint.config.mjs
git commit -m "refactor: delete pi-stubs compatibility layer"
```

---

### Task 7: 删掉产品面上的 Pi 专有能力

壳保留；这些能力不是 Grok TUI 用户的合同，留着会继续制造「看起来有、实际是 Pi 残骸」的 bug。

**Files:**
- Modify: `hooks/useAgentSession.ts`（composer `!` bash 分支）
- Modify: `components/ChatInput.tsx` / `ChatWindow.tsx`（pendingBash UI）
- Delete or gut: `lib/bash-output.ts`、`src/routes/api/agent/$id/bash-output.ts`（若无 Grok 输出文件可读）
- Modify: `lib/tool-presets.ts` — 只作为 ACP `configOptions` 的 id 映射（`none|read-only|default|full`），删除 Pi 工具名列表若 ACP 不认这些名字
- Modify: `src/routes/__root.tsx` — `localStorage pi-theme` 改为 `grok-theme`，读取时兼容旧 key 一次
- Modify: `PRODUCT.md` — 明确：内部协议是 ACP，不再兼容 pi-web SSE；composer `!` 若删除需写进 Undecided 或 Confirmed
- Test: 现有 ChatInput / bash-output 测试改为「Grok web 不提供 Pi bash log」或接到 `_x.ai/terminal`（仅当 runtime 已实现且有测试）。默认删除路径：断言 `!` 当作普通 prompt 发送，不再 `isBashCommand`。

- [ ] **Step 1: 写失败测试 — `!ls` 不再走 bashExecution**

```javascript
test("composer bang is not a local bash escape", () => {
  assert.doesNotMatch(sessionSource, /isBashCommand/);
  assert.doesNotMatch(sessionSource, /trimmedMessage\.startsWith\("!"\)/);
});
```

Expected: FAIL

- [ ] **Step 2: 删分支、删 bash-output 路由（若 inventory 仍列出则同步删 EXPECTED_ADAPTERS）**

用户要跑命令：走 agent 的 `run_terminal_command`，与 TUI 一致。

tool preset：UI 仍可有只读/默认/全部，但下发必须是 ACP `session/set_config_option`（`lib/acp/config-options.ts` 已有）。删除 `getToolNamesForPreset` 对 Pi `bash`/`read` 字符串表的依赖，除非 fake-agent 的 configOptions 仍用这些 id（那是 Grok ACP 的 id，可留）。

- [ ] **Step 3: 跑测试 + 更新 PRODUCT.md**

```bash
node --experimental-strip-types --test hooks/useAgentSession.test.mjs lib/tanstack-route-inventory.test.mjs lib/acp/config-options.test.mjs
```

`PRODUCT.md` Capabilities 增加一句：对话协议以 Grok ACP 为准；浏览器不实现 Pi coding-agent RPC。删掉任何「对齐 pi-web SSE」的承诺。

- [ ] **Step 4: Commit**

```bash
git add hooks components lib src PRODUCT.md
git commit -m "fix: drop Pi-only composer bash and document ACP as the contract"
```

---

### Task 8: 拆 useAgentSession（可选，合同稳定之后）

只在 Task 1–7 完成后做。本 Task **不是**本计划成功标准。

若文件仍 >1500 行，按职责拆，不改行为：

| 新文件 | 从 useAgentSession 搬出 |
| --- | --- |
| `hooks/agent-event-reducer.ts` | `handleAgentEvent` 的 switch |
| `hooks/agent-send.ts` | `handleSend` / abort / queue |
| `hooks/agent-session-load.ts` | `loadSession` / leaf 切换 |

每拆一块：先把现有 `hooks/useAgentSession.test.mjs` 跑绿，再搬，再跑。禁止顺手改 SSE 事件名。

`AppShell.tsx` / `ChatWindow.tsx` 同样：不为拆而拆。

---

## 验收清单（整计划结束时）

```bash
在仓库根目录运行后续命令
node --experimental-strip-types --test
```

Expected: PASS

再人工 grep：

```bash
rg -n "pi-stubs|rpc-manager|startRpcSession|pi-bash|from \"@/app/api" --glob '!docs/**' --glob '!node_modules/**' --glob '!.output/**'
```

Expected: 无命中（`pi-theme` 旧 key 读取除外，应带注释说明一次性兼容）。

产品验收（不改壳）：

- 侧栏项目/会话仍按 `~/.grok/sessions`
- 打开旧会话，bash 卡标题为 `bash`，结果不是 description+stdout
- 新权限框显示命令文本
- 文件/Git 右栏仍工作
- 只有一个 `grok agent stdio`

---

## 执行顺序与停下来的理由

| 顺序 | 为什么必须先做 |
| --- | --- |
| 1 夹具 | 后面每刀都靠它发现回潮 |
| 2 实时展示 | 用户可感知的合同，且验证夹具能护住 UI |
| 3 类型 | 编译图不再把 Pi 当真相 |
| 4 单 HTTP 树 | 机械但高脚枪；越晚越痛 |
| 5 删 rpc-manager | 此时子代理已有 ACP 路径 |
| 6 删 pi-stubs | 引用已清 |
| 7 删 Pi 产品面 | 避免空壳功能继续骗人 |
| 8 拆大文件 | 可选；协议稳定后再动 |

中途必须保持 `npm test` 绿、LAN 上现有会话可打开。不允许「先红一周再一起绿」。
