# grok-web 原生 Git 写入与反馈 / 历史

日期：2026-08-19  
仓库：`icekale/grok-web`  
上级规格：`docs/superpowers/specs/2026-08-18-grok-web-design.md`

## 1. 产品

把 Grok ACP 已有、但 grok-web 还没有界面的写路径接到现有壳上：右栏 FileViewer 的 Git 写入，以及对话里的反馈、回顾、输入历史。

视觉和交互继续复刻 icekale/pi-web：用现有 FileViewer 工具栏按钮、`codex-dialog`、斜杠菜单、`↑` 历史条。不另做 Changes 列表、不另做 Feedback 页、不加顶栏按钮。

成功标准：用户在有 diff 的文件上能 Stage / Discard / Commit；能 `/feedback`、`/recap`；`↑` 能看到本会话句子和 Grok 全局 prompt history。写操作只走 ACP，失败给明确错误。

## 2. 已定决策

| 项 | 决定 |
| --- | --- |
| 范围 | Git 写入 + 反馈/回顾/历史，先 Git |
| Git 位置 | FileViewer 工具栏，Source / Preview / Diff 旁边 |
| Commit | `codex-dialog` + `codex-dialog-editor` 写 message |
| Discard | 单击即执行，不用危险确认框；失败用 notice |
| Stage / Discard 粒度 | 当前打开的文件（相对 `cwd` 的路径） |
| Commit 粒度 | 已暂存变更（ACP `git/commit`，必填 `message`） |
| 反馈 | `/feedback 文字` 立刻发；裸 `/feedback` 打开 editor 对话框 |
| 回顾 | `/recap` 当 builtin 斜杠，结果进对话/notice |
| 历史 | `↑` = 本会话用户句 ∪ `_x.ai/prompt_history`，按文本去重 |
| 本机 git 写 | **禁止**。只读 diff/status 仍可本机回退 |
| 测试 | 单测用 fake-agent。本机验收可以用真 `grok` 和真模型 |

非目标：独立 Changes 面板、顶栏 Feedback 按钮、本机 `git add/commit/checkout`、图片、工具预设写入、`git/stage` 空路径的「暂存全部」按钮。

## 3. ACP

已对 `grok agent stdio` 探过，方法一律 `_x.ai/` 前缀：

| UI | 方法 | 参数 | 结果要点 |
| --- | --- | --- | --- |
| Stage 当前文件 | `_x.ai/git/stage` | `{ paths: [rel] }` | `{ result: { paths } }`；`path` 单数字段无效 |
| Discard 当前文件 | `_x.ai/git/discard` | `{ paths: [rel] }` | 空 `{}` 也成功，UI **必须**传当前文件，禁止空 discard |
| Commit | `_x.ai/git/commit` | `{ message }` | 缺 message → Invalid params |
| 发反馈 | `_x.ai/feedback` | `{ session_id, feedback_text }` | `{ success: true }` |
| 回顾 | `_x.ai/recap` | `{ sessionId }` | snake_case `session_id` 无效 |
| 输入历史 | `_x.ai/prompt_history` | `{ cwd }` | `{ prompts: string[] }`（空会话为 `[]`） |

`git/diffs` + `includePatch` 已在 FileViewer Diff 模式使用。写成功后刷新 `gitRefreshKey` 以重拉 diff。

## 4. HTTP

浏览器协议保持 pi-web 形状，只加写接口：

- `POST /api/git/stage` `{ cwd, path }`
- `POST /api/git/discard` `{ cwd, path }`
- `POST /api/git/commit` `{ cwd, message }`
- `POST /api/agent/:id` `{ type: "feedback", text }`
- `POST /api/agent/:id` `{ type: "recap" }`
- `POST /api/agent/:id` `{ type: "get_prompt_history" }`

`cwd` / `path` 走现有文件允许根检查。Git 写：先 `getAgentRuntime().ensureProcess()`，没有 ACP 则 501，文案说明需要 Grok 进程。不要本机执行 `git add` / `git checkout` / `git commit`。

路径：`path` 转成相对 `cwd` 的 `/` 路径再交给 `paths: [rel]`。

## 5. UI

**FileViewer 工具栏**（仅 `hasGitDiff`）：

- 在 `file-viewer-mode-switch` 旁增加 Stage、Discard、Commit…，样式用现有 `file-viewer-mode-button`。
- Stage / Discard：当前 `filePath`。成功后 bump `gitRefreshKey`（或等价刷新）；若 diff 消失则回到 Source。
- Commit…：打开 `DialogShell`（`data-size="editor"`），textarea 用 `codex-dialog-editor`，footer 为取消 + 主按钮 Commit。空 message 禁用主按钮。
- 忙碌时按钮 disabled。错误用现有 notice / `codex-dialog-error`。
- 中英 i18n 键加在 `en.ts` / `zh-CN.ts`，文案不出现 Pi。

**斜杠**（`ChatInput` builtin + `handleBuiltinSlashCommand`）：

- `feedback`、`recap` 加入 `BUILTIN_SLASH_COMMANDS`。
- `/feedback <text>` → agent `feedback`。
- `/feedback` → 打开同一套 editor 对话框，提交后再发。
- `/recap` → agent `recap`；若结果只有 `{ ok: true }`，notice 成功；若 ACP 以后带回文本，显示在 notice 或会话里。

**历史**：

- `ChatWindow` 的 `inputHistory` 先收本会话用户句，再并入 `get_prompt_history` 的 `prompts`，按全文去重，最多 50 条。
- ACP 失败则只显示本会话历史，不打断输入。

## 6. 错误处理

| 情况 | 行为 |
| --- | --- |
| ACP 未启动 | Git 写 501；斜杠 notice 错误 |
| `git/commit` 没有暂存或 git 失败 | 对话框内错误，不关窗 |
| discard / stage 路径不在允许根 | 403 |
| 空 discard / 空 paths | 网关拒绝，不转发（避免误伤工作区） |
| feedback 空文本 | 不发送 |
| prompt_history 失败 | 静默回退本会话历史 |

## 7. 测试

单测（fake-agent，不强制打模型）：

1. `git/stage` 只接受 `paths` 数组并回传 staged paths
2. `git/discard` 要求非空 `paths`
3. `git/commit` 拒绝空 message
4. `feedback` 需要 `session_id` + `feedback_text`
5. `recap` 用 `sessionId`
6. `get_prompt_history` 用 `cwd` 返回 `prompts`
7. FileViewer：有 diff 才渲染三个按钮（源码断言即可）
8. builtin 斜杠含 `feedback`、`recap`

本机验收（允许真 `grok` / 真模型）：

- 在有 diff 的文件上 Stage → Diff 仍在或刷新；Discard 后工作区恢复；Commit 需要非空 message
- `/feedback 测试` 返回成功
- 裸 `/feedback` 打开对话框
- `↑` 在有历史时能列出条目

## 8. 目录

改动落在现有文件：`lib/acp/connection.ts`、`fake-agent.mjs`、`runtime.ts`、`app/api/git/*`、`FileViewer.tsx`、`useAgentSession.ts`、`ChatInput.tsx`、`ChatWindow.tsx`、i18n。不新增顶层页面。
