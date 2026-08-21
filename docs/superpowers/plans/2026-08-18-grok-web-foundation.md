# grok-web Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `本仓库` 做出可启动的本机应用：复刻 icekale/pi-web 的工作区壳，侧栏列出真实 `~/.grok` 会话，点开后只读展示 `updates.jsonl` 历史。

**Architecture:** 先写与 UI 无关的适配器（Grok 家目录、会话索引、历史翻译、置顶/归档元数据、绑定保护）。再按文件移植 pi-web 的 `components/`、`hooks/`、`src/` 壳。`lib/session-reader.ts` 与会话 API 改走适配器。本计划不启动 `grok agent`；发送/设置等按钮可以存在，后端返回明确错误。

**Tech Stack:** Node `>= 22.19.0`，Vite + TanStack Start + React 19（版本对齐 icekale/pi-web 的 package.json），测试用 `node --test`。不引入 `@earendil-works/pi-*`。

**后续计划（本文件不实现）：** ACP 实时对话与权限；排队/插话/分叉；文件/Git/worktree；设置/登录/MCP/远程访问；子代理树。

规格：`docs/superpowers/specs/2026-08-18-grok-web-design.md`

---

## File structure

| 路径 | 职责 |
| --- | --- |
| `lib/grok-home.ts` | 解析 `GROK_HOME` / `~/.grok` |
| `lib/session-index.ts` | 扫 `sessions/<cwd-group>/<id>/summary.json` → `SessionInfo[]` |
| `lib/history-map.ts` | `updates.jsonl` → `{ messages, entryIds }` |
| `lib/app-meta.ts` | `~/.grok/grok-web/meta.json` 置顶/归档 |
| `lib/bind-guard.ts` | 非回环且无密码则拒绝 |
| `lib/session-reader.ts` | UI 仍 import 此文件；内部改调上面三个模块 |
| `lib/types.ts` | 从 pi-web 原样复制 `SessionInfo` / `AgentMessage` 等 |
| `app/api/sessions/route.ts` | `GET` 列表 |
| `app/api/sessions/[id]/context/route.ts` | `GET` 只读历史 |
| `src/` `components/` `hooks/` | 从 pi-web 移植，改标题为 Grok Web |
| `bin/grok-web.js` | 启动，默认 `127.0.0.1:30142` |
| `test/fixtures/sessions/` | 会话夹具 |

---

### Task 1: Grok 家目录

**Files:**
- Create: `lib/grok-home.ts`
- Test: `lib/grok-home.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { grokHome, grokWebMetaDir, grokSessionsDir } from "./grok-home.ts";

describe("grok-home", () => {
  it("defaults to ~/.grok", () => {
    const prev = process.env.GROK_HOME;
    delete process.env.GROK_HOME;
    try {
      assert.equal(grokHome(), join(homedir(), ".grok"));
      assert.equal(grokSessionsDir(), join(homedir(), ".grok", "sessions"));
      assert.equal(grokWebMetaDir(), join(homedir(), ".grok", "grok-web"));
    } finally {
      if (prev === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = prev;
    }
  });

  it("honors GROK_HOME and trims it", () => {
    const prev = process.env.GROK_HOME;
    process.env.GROK_HOME = " /tmp/grok-home-test ";
    try {
      assert.equal(grokHome(), "/tmp/grok-home-test");
      assert.equal(grokSessionsDir(), "/tmp/grok-home-test/sessions");
    } finally {
      if (prev === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = prev;
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test lib/grok-home.test.mjs`

Expected: FAIL，模块不存在。

- [ ] **Step 3: Write minimal implementation**

```typescript
import { homedir } from "node:os";
import { join } from "node:path";

export function grokHome(): string {
  const override = process.env.GROK_HOME?.trim();
  return override || join(homedir(), ".grok");
}

export function grokSessionsDir(): string {
  return join(grokHome(), "sessions");
}

export function grokWebMetaDir(): string {
  return join(grokHome(), "grok-web");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test lib/grok-home.test.mjs`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/grok-home.ts lib/grok-home.test.mjs
git commit -m "feat: resolve GROK_HOME and session paths"
```

---

### Task 2: 会话索引

**Files:**
- Create: `lib/session-index.ts`
- Test: `lib/session-index.test.mjs`

夹具目录（测试里用 `mkdtemp` 写，不要依赖开发者本机 `~/.grok`）：

```
<GROK_HOME>/sessions/%2Ftmp%2Fdemo/<id>/summary.json
<GROK_HOME>/sessions/too-long-slug/.cwd          # 内容为一行绝对路径
<GROK_HOME>/sessions/too-long-slug/<id2>/summary.json
<GROK_HOME>/sessions/%2Ftmp%2Fbad/<id3>/          # 无 summary 或坏 JSON
```

`summary.json` 形状以真实 Grok 为准：

```json
{
  "info": { "id": "01aaaaaaaaaaaaaaaaaaaaaaaa", "cwd": "/tmp/demo" },
  "session_summary": "Fix login",
  "created_at": "2026-08-18T13:11:03.296959Z",
  "updated_at": "2026-08-18T13:36:32.852131Z",
  "num_messages": 10,
  "num_chat_messages": 4,
  "generated_title": "Fix login bug",
  "last_active_at": "2026-08-18T13:36:32.852131Z"
}
```

映射到 `SessionInfo`（字段与 `pi-web/lib/types.ts` 的 `SessionInfo` 一致）：

| SessionInfo | 来源 |
| --- | --- |
| `id` | `info.id`，否则用目录名 |
| `cwd` | `info.cwd`；组目录有 `.cwd` 时用其 trim 后的一行 |
| `path` | 会话目录绝对路径 |
| `name` | `generated_title`，否则 `session_summary` |
| `created` | `created_at` |
| `modified` | `last_active_at` 或 `updated_at` |
| `messageCount` | `num_chat_messages`，否则 `num_messages` |
| `firstMessage` | `session_summary` 或 `"(no messages)"` |
| `parentSessionId` | `info.parent_session_id` 或 `parent_session_id`，没有则省略 |

- [ ] **Step 1: Write the failing test**

```javascript
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { listGrokSessions } from "./session-index.ts";

async function writeSummary(dir, body) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "summary.json"), JSON.stringify(body));
}

describe("listGrokSessions", () => {
  it("groups encoded cwd and .cwd fallback, skips corrupt sessions", async () => {
    const home = await mkdtemp(join(tmpdir(), "grok-idx-"));
    const prev = process.env.GROK_HOME;
    process.env.GROK_HOME = home;
    try {
      const id1 = "01aaaaaaaaaaaaaaaaaaaaaaaa";
      const id2 = "01bbbbbbbbbbbbbbbbbbbbbbbb";
      const id3 = "01cccccccccccccccccccccccc";
      await writeSummary(join(home, "sessions", encodeURIComponent("/tmp/demo"), id1), {
        info: { id: id1, cwd: "/tmp/demo" },
        session_summary: "Fix login",
        created_at: "2026-08-18T13:00:00.000Z",
        updated_at: "2026-08-18T13:10:00.000Z",
        last_active_at: "2026-08-18T13:20:00.000Z",
        num_chat_messages: 4,
        generated_title: "Fix login bug",
      });
      const slug = join(home, "sessions", "too-long-slug");
      await mkdir(slug, { recursive: true });
      await writeFile(join(slug, ".cwd"), "/very/long/project\n");
      await writeSummary(join(slug, id2), {
        info: { id: id2, cwd: "/ignored" },
        session_summary: "Other",
        created_at: "2026-08-18T12:00:00.000Z",
        updated_at: "2026-08-18T12:00:00.000Z",
        num_messages: 2,
      });
      await mkdir(join(home, "sessions", encodeURIComponent("/tmp/bad"), id3), { recursive: true });
      await writeFile(join(home, "sessions", encodeURIComponent("/tmp/bad"), id3, "summary.json"), "{");

      const sessions = await listGrokSessions();
      assert.equal(sessions.length, 2);
      assert.equal(sessions[0].id, id1);
      assert.equal(sessions[0].cwd, "/tmp/demo");
      assert.equal(sessions[0].name, "Fix login bug");
      assert.equal(sessions[0].modified, "2026-08-18T13:20:00.000Z");
      assert.equal(sessions[0].messageCount, 4);
      assert.equal(sessions[0].firstMessage, "Fix login");
      assert.equal(sessions[0].path, join(home, "sessions", encodeURIComponent("/tmp/demo"), id1));
      assert.equal(sessions[1].id, id2);
      assert.equal(sessions[1].cwd, "/very/long/project");
      assert.equal(sessions[1].name, "Other");
    } finally {
      if (prev === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = prev;
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test lib/session-index.test.mjs`

Expected: FAIL，`listGrokSessions` 未定义。

- [ ] **Step 3: Write minimal implementation**

`lib/session-index.ts`：读 `grokSessionsDir()`；每个一级子目录是 cwd 组；若存在 `.cwd` 则整组 cwd 用该文件第一行；否则 `decodeURIComponent(组名)`，失败则用组名。每个二级目录若有可解析的 `summary.json` 则产出一条 `SessionInfo`，按 `modified` 降序。坏 JSON 跳过。

导出：

```typescript
export async function listGrokSessions(): Promise<SessionInfo[]>
export async function findGrokSession(id: string): Promise<SessionInfo | null>
```

`findGrokSession` 在列表里按 `id` 精确匹配。`SessionInfo` 从将在 Task 6 复制的 `lib/types.ts` 引用；本任务先在 `session-index.ts` 内声明同名字段的最小 interface，Task 6 再改成 `import type { SessionInfo } from "./types"`。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test lib/session-index.test.mjs`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/session-index.ts lib/session-index.test.mjs
git commit -m "feat: index Grok sessions from disk"
```

---

### Task 3: updates.jsonl → 消息树

**Files:**
- Create: `lib/history-map.ts`
- Test: `lib/history-map.test.mjs`

记录形状（真实 Grok）：

```json
{
  "timestamp": 1787058703,
  "method": "session/update",
  "params": {
    "sessionId": "01a",
    "update": {
      "sessionUpdate": "user_message_chunk",
      "content": { "type": "text", "text": "Hello" }
    }
  }
}
```

`sessionUpdate` 要处理：`user_message_chunk`、`agent_thought_chunk`、`agent_message_chunk`、`tool_call`、`tool_call_update`。其它类型跳过。

输出：

```typescript
export type HistoryMessage =
  | { role: "user"; content: string; timestamp?: number }
  | {
      role: "assistant";
      content: Array<
        | { type: "text"; text: string }
        | { type: "thinking"; thinking: string }
        | {
            type: "toolCall";
            toolCallId: string;
            toolName: string;
            input: Record<string, unknown>;
          }
      >;
      model: string;
      provider: "grok";
      timestamp?: number;
    };

export function mapUpdatesJsonl(text: string): {
  messages: HistoryMessage[];
  entryIds: string[];
}
```

规则：

- 连续同角色 chunk 合并进同一条 message。
- 用户 chunk 在已有 assistant 之后出现 → 先推入 assistant 再开新 user。
- `tool_call`：`update` 上的 `toolCallId`/`id`、`title`/`kind`/`toolName`、`input`/`rawInput`。
- `tool_call_update`：按 id 合并 input/status，不新开 message。
- `entryIds` 与 `messages` 等长；用 `_meta.eventId`，没有则用 `msg-0` 递增。
- 坏行跳过。
- `model` 取 `_meta.modelId` 或 `"grok"`。

- [ ] **Step 1: Write the failing test**

```javascript
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapUpdatesJsonl } from "./history-map.ts";

function line(update, meta = {}) {
  return JSON.stringify({
    timestamp: 1,
    method: "session/update",
    params: { sessionId: "s", update, _meta: meta },
  });
}

describe("mapUpdatesJsonl", () => {
  it("merges chunks and tools into user/assistant messages", () => {
    const text = [
      line({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Hi" } }, { eventId: "e1", modelId: "grok-4.6" }),
      line({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "think" } }, { eventId: "e2" }),
      line({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Yo" } }, { eventId: "e3" }),
      line({ sessionUpdate: "tool_call", toolCallId: "t1", title: "read_file", input: { path: "a.ts" } }, { eventId: "e4" }),
      "{not json",
      line({ sessionUpdate: "unknown_thing" }),
    ].join("\n");
    const { messages, entryIds } = mapUpdatesJsonl(text);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, "user");
    assert.equal(messages[0].content, "Hi");
    assert.equal(messages[1].role, "assistant");
    assert.deepEqual(messages[1].content, [
      { type: "thinking", thinking: "think" },
      { type: "text", text: "Yo" },
      { type: "toolCall", toolCallId: "t1", toolName: "read_file", input: { path: "a.ts" } },
    ]);
    assert.equal(messages[1].provider, "grok");
    assert.equal(entryIds.length, 2);
    assert.equal(entryIds[0], "e1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test lib/history-map.test.mjs`

Expected: FAIL

- [ ] **Step 3: Write minimal implementation** in `lib/history-map.ts`，按上面规则实现 `mapUpdatesJsonl`。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test lib/history-map.test.mjs`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/history-map.ts lib/history-map.test.mjs
git commit -m "feat: map Grok updates.jsonl to chat messages"
```

---

### Task 4: 置顶 / 归档元数据

**Files:**
- Create: `lib/app-meta.ts`
- Test: `lib/app-meta.test.mjs`

文件：`join(grokWebMetaDir(), "meta.json")`

```json
{
  "pinnedIds": ["01aaa"],
  "archivedIds": ["01bbb"]
}
```

规则：读失败 → 空列表。`pin`/`archive` 只改这个文件，禁止改会话目录名。同一 id 可以同时不存在于两个列表；pin 一个已归档的 id 时从 archived 移除，反之亦然。

导出：

```typescript
export type AppMeta = { pinnedIds: string[]; archivedIds: string[] };
export async function readAppMeta(): Promise<AppMeta>
export async function pinSession(id: string, pinned: boolean): Promise<AppMeta>
export async function archiveSession(id: string, archived: boolean): Promise<AppMeta>
```

- [ ] **Step 1: Write the failing test**

```javascript
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { archiveSession, pinSession, readAppMeta } from "./app-meta.ts";

describe("app-meta", () => {
  it("pins and archives without touching session dirs", async () => {
    const home = await mkdtemp(join(tmpdir(), "grok-meta-"));
    const prev = process.env.GROK_HOME;
    process.env.GROK_HOME = home;
    try {
      assert.deepEqual(await readAppMeta(), { pinnedIds: [], archivedIds: [] });
      await pinSession("a", true);
      await archiveSession("b", true);
      const meta = await readAppMeta();
      assert.deepEqual(meta.pinnedIds, ["a"]);
      assert.deepEqual(meta.archivedIds, ["b"]);
      await archiveSession("a", true);
      const after = await readAppMeta();
      assert.ok(!after.pinnedIds.includes("a"));
      assert.ok(after.archivedIds.includes("a"));
    } finally {
      if (prev === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = prev;
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test lib/app-meta.test.mjs`

Expected: FAIL

- [ ] **Step 3: Write `lib/app-meta.ts`** — `mkdir` 元数据目录，读写 JSON，原子写（先写 `meta.json.tmp` 再 `rename`）。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test lib/app-meta.test.mjs`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/app-meta.ts lib/app-meta.test.mjs
git commit -m "feat: store pin and archive metadata beside Grok home"
```

---

### Task 5: 绑定保护

**Files:**
- Create: `lib/bind-guard.ts`
- Test: `lib/bind-guard.test.mjs`

```typescript
export function isLoopbackHost(hostname: string): boolean
export function assertBindAllowed(hostname: string, password: string | undefined): void
```

回环：`127.0.0.1`、`localhost`、`::1`、`[::1]`。  
非回环且 `password` 为空/未设 → `throw new Error`，消息包含 `refuses` 和 `GROK_WEB_PASSWORD`。

- [ ] **Step 1: Write the failing test**

```javascript
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertBindAllowed, isLoopbackHost } from "./bind-guard.ts";

describe("bind-guard", () => {
  it("allows loopback without a password", () => {
    assert.equal(isLoopbackHost("127.0.0.1"), true);
    assert.doesNotThrow(() => assertBindAllowed("127.0.0.1", undefined));
  });

  it("rejects 0.0.0.0 without a password", () => {
    assert.throws(() => assertBindAllowed("0.0.0.0", undefined), /refuses|GROK_WEB_PASSWORD/);
  });

  it("allows 0.0.0.0 with a password", () => {
    assert.doesNotThrow(() => assertBindAllowed("0.0.0.0", "long-enough-secret"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test lib/bind-guard.test.mjs`

Expected: FAIL

- [ ] **Step 3: Implement `lib/bind-guard.ts`**

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test lib/bind-guard.test.mjs`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/bind-guard.ts lib/bind-guard.test.mjs
git commit -m "feat: refuse non-loopback bind without password"
```

---

### Task 6: 从 pi-web 移植壳，去掉 Pi 包

**Files:**
- Create/copy from `https://github.com/icekale/pi-web`（不要复制 `node_modules`、`.git`、`.next`、`.output`、`.superpowers`）
- Modify: `package.json`、`vite.tanstack.config.ts`、`src/routes/__root.tsx`

- [ ] **Step 1: 复制 UI 与工程文件**

```bash
在仓库根目录运行后续命令
rsync -a --exclude node_modules --exclude .git --exclude .next --exclude .output \
  --exclude .superpowers --exclude docs/superpowers \
  https://github.com/icekale/pi-web/components https://github.com/icekale/pi-web/hooks https://github.com/icekale/pi-web/public \
  https://github.com/icekale/pi-web/src https://github.com/icekale/pi-web/app https://github.com/icekale/pi-web/lib \
  https://github.com/icekale/pi-web/bin https://github.com/icekale/pi-web/scripts \
  https://github.com/icekale/pi-web/package.json https://github.com/icekale/pi-web/tsconfig.json \
  https://github.com/icekale/pi-web/vite.tanstack.config.ts https://github.com/icekale/pi-web/eslint.config.mjs \
  https://github.com/icekale/pi-web/next-env.d.ts .
```

然后立刻：

1. `package.json`：`name` 改为 `grok-web`，`bin` 改为 `"grok-web": "bin/grok-web.js"`，删掉所有 `@earendil-works/*` 依赖，`dev`/`start` 端口改为 `30142`，环境变量前缀 `PI_WEB_` 全局替换为 `GROK_WEB_`（本文件与 `bin/`、`lib/request-security.ts`、`lib/web-auth.ts`）。
2. 删除 `lib` 里 import `@earendil-works/*` 的实现文件中的 Pi 调用，改为本地 stub（返回空列表 / 抛 `Error("not implemented in foundation")`），保证 `tsc`/Vite 能解析。**不要**重新实现 Pi SDK。本计划真正要工作的只有会话列表与历史。
3. `lib/session-reader.ts` 整文件换成对 `listGrokSessions` / `findGrokSession` 的包装，保持导出名字：`listAllSessions`、`attachSessionProjectInfo`（cwd 原样当作 `projectRoot`）、`mergeSessionLists`（按 id 合并，disk 覆盖 runtime）。
4. `__root.tsx` 里 title/description/application-name 改为 `Grok Web`。

- [ ] **Step 2: 改 session-index 使用复制来的 `SessionInfo`**

`lib/session-index.ts`：`import type { SessionInfo } from "./types"`，删掉任务 2 的临时 interface。跑：

```bash
node --experimental-strip-types --test lib/grok-home.test.mjs lib/session-index.test.mjs lib/history-map.test.mjs lib/app-meta.test.mjs lib/bind-guard.test.mjs
```

Expected: PASS

- [ ] **Step 3: 安装依赖**

```bash
npm install
```

Expected: lockfile 生成，且 `package-lock.json` 里没有 `@earendil-works/`。

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: vendor pi-web UI shell without Pi packages"
```

---

### Task 7: 会话列表与历史 API

**Files:**
- Create: `lib/session-http.ts`（handler 抽在这里测，路由文件只转调）
- Modify: `app/api/sessions/route.ts`
- Modify: `app/api/sessions/[id]/context/route.ts`
- Modify: `lib/archived-sessions.ts`（pi-web 原本地 `localStorage`；改为读 GET `/api/sessions` 带回的 `meta`，写 POST `/api/meta`）
- Test: `lib/session-http.test.mjs`

- [ ] **Step 1: Write the failing API test**

```javascript
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { getSessions } from "./session-http.ts";

describe("GET /api/sessions", () => {
  it("lists fixture sessions from GROK_HOME", async () => {
    const home = await mkdtemp(join(tmpdir(), "grok-api-"));
    const prev = process.env.GROK_HOME;
    process.env.GROK_HOME = home;
    try {
      const id = "01dddddddddddddddddddddddd";
      const dir = join(home, "sessions", encodeURIComponent("/tmp/p"), id);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "summary.json"), JSON.stringify({
        info: { id, cwd: "/tmp/p" },
        session_summary: "Hello",
        created_at: "2026-08-18T13:00:00.000Z",
        updated_at: "2026-08-18T13:00:00.000Z",
        num_chat_messages: 1,
        generated_title: "Hello",
      }));
      const res = await getSessions(new Request("http://127.0.0.1/api/sessions"));
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.sessions[0].id, id);
      assert.equal(body.sessions[0].cwd, "/tmp/p");
      assert.deepEqual(body.runningSessionIds, []);
    } finally {
      if (prev === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = prev;
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test lib/session-http.test.mjs`

Expected: FAIL，`session-http.ts` 不存在或仍走 Pi `SessionManager`。

- [ ] **Step 3: Implement handlers**

`lib/session-http.ts`：

- `getSessions(req)`：`listAllSessions()` + `readAppMeta()`，返回 `{ sessions, runningSessionIds: [], meta }`。`meta` 为 `{ pinnedIds, archivedIds }`。
- `getSessionContext(req, id)`：`findGrokSession(id)`，读 `path/updates.jsonl`，`mapUpdatesJsonl`，返回 `{ context: { messages, entryIds } }`。没有会话 → 404。
- `postMeta(req)`：body `{ pin?: { id, value }, archive?: { id, value } }`，调用 `pinSession` / `archiveSession`，返回最新 `meta`。

路由文件只转调这些函数。`lib/archived-sessions.ts` 改为从列表响应的 `meta` 读，变更走 `POST /api/meta`。侧栏组件不要改 props。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test lib/session-http.test.mjs lib/session-index.test.mjs`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/api/sessions lib/session-reader.ts lib/session-http.ts lib/session-http.test.mjs lib/archived-sessions.ts
git commit -m "feat: serve Grok session list and read-only history"
```

---

### Task 8: 启动入口与默认端口

**Files:**
- Modify: `bin/grok-web.js`（由 `bin/pi-web.js` 改名）
- Modify: `package.json` scripts
- Test: `lib/bind-guard.test.mjs` 已覆盖规则；入口里调用 `assertBindAllowed(hostname, process.env.GROK_WEB_PASSWORD)`

- [ ] **Step 1: 改入口**

- 可执行文件：`bin/grok-web.js`
- 解析 `-p/--port`、`-H/--hostname`、`--no-open`，默认 port `30142`，默认 host `127.0.0.1`
- 启动前 `assertBindAllowed`
- `dev` script：`vite dev --configLoader runner --config vite.tanstack.config.ts --host 127.0.0.1 --port 30142`

删掉 `bin/pi-web.js` 或把它做成调用 `grok-web.js` 的一层，不要留两套默认端口。

- [ ] **Step 2: 启动检查**

```bash
npm run dev
```

Expected: 监听 `127.0.0.1:30142`。浏览器打开后侧栏能看到当前 `GROK_HOME`（默认 `~/.grok`）下的会话。点开本设计会话应出现用户/助手历史，而不是空会话或 Pi 路径错误。

另开终端：

```bash
GROK_WEB_PASSWORD= curl -sS -o /tmp/gw.json -w '%{http_code}' http://127.0.0.1:30142/api/sessions
```

Expected: `200`，JSON 含 `sessions` 数组。

- [ ] **Step 3: 停掉 dev server，跑全套适配器测试**

```bash
node --experimental-strip-types --test lib/*.test.mjs app/api/sessions/route.test.mjs
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add bin package.json vite.tanstack.config.ts
git commit -m "feat: launch grok-web on 127.0.0.1:30142"
```

---

## Self-review

规格覆盖：

| 规格 | 本计划 |
| --- | --- |
| 新仓库、Vite+TanStack+Node | Task 6–8 |
| UI 复刻 pi-web | Task 6 按文件移植 |
| 不引入 pi-coding-agent | Task 6 删依赖 |
| `~/.grok/sessions` 列表与历史 | Task 2, 3, 7 |
| 置顶/归档只写 `~/.grok/grok-web/` | Task 4 |
| 默认 127.0.0.1:30142，无密码拒非回环 | Task 5, 8 |
| 适配器 `node --test` 夹具 | Task 1–5, 7 |
| ACP 实时、权限、文件、设置、子代理 | 明确留给后续计划 |

类型名：`SessionInfo`、`listGrokSessions`、`mapUpdatesJsonl`、`readAppMeta`、`assertBindAllowed` 前后任务一致。
