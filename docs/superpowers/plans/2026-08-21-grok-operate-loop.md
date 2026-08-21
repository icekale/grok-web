# Grok operate loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not commit unless Kale asks.

**Goal:** 三栏壳不动，把设置、composer、空状态、权限框和侧栏改成 Grok TUI 用户的操作语言。

**Architecture:** 协议仍是 ACP。本计划只改用户看见的层：`translatePermissionRequest`、`visibleGrokEffortLevels`、i18n、Settings 导航/Models 主次栏、Composer 芯片显隐、侧栏菜单。直播模型列表继续走 `/api/models` + `mapGrokModels`。

**Tech Stack:** 现有 Node 22 + Vite + TanStack Start。测试：`node --experimental-strip-types --test`。不打真 `grok`。

规格：`docs/superpowers/specs/2026-08-21-grok-operate-loop-design.md`

**本计划不做：** 换 chrome、内部 `pi-*` 大改名、删自定义 provider、TanStack 升级、提交 git（除非用户要求）。

---

## File structure

| 路径 | 职责 |
| --- | --- |
| `lib/acp/permissions.ts` | 权限标题用 ACP title；正文是 command/path，禁止 JSON dump |
| `lib/acp/permissions.test.mjs` | 重放 `permission-bash.json` + 新 `permission-read.json` |
| `lib/grok-effort-levels.ts` | 可见档位与 `low/medium/high/xhigh` 求交 |
| `lib/tool-presets.ts` | `composerShowsToolPreset(advertised)` |
| `lib/composer-models.ts` | `grokLiveChatModels(modelList)` |
| `lib/i18n/messages/en.ts` + `zh-CN.ts` | Effort / 空状态 / 权限副标题 / Models / 导出 |
| `components/ChatInput.tsx` | Effort 用词；Shield 只在 advertised 时画 |
| `components/ChatWindow.tsx` | 权限正文等宽块；home 副标题；传 advertised |
| `hooks/useAgentSession.ts` | `toolsAdvertised` |
| `components/AppShell.tsx` | 空状态；`openSettings` 扩 section；子代理常驻 |
| `components/SettingsPage.tsx` | 导航顺序 |
| `components/ModelsConfig.tsx` + navigator | Grok 主栏 + 自定义次栏 |
| `components/CodexSidebar.tsx` | 导出、项目菜单、worktree 默认展开 |
| `PRODUCT.md` | 补三句产品承诺 |

---

### Task 1: 权限框标题和正文

**Files:**
- Modify: `lib/acp/permissions.ts`
- Modify: `lib/acp/permissions.test.mjs`
- Create: `lib/acp/fixtures/permission-read.json`
- Modify: `components/ChatWindow.tsx`（confirm 正文用 `<pre>`；副标题 i18n）
- Modify: `lib/i18n/messages/en.ts`, `zh-CN.ts`

- [ ] **Step 1: 先改测试为新期望（RED）**

`permission-read.json`：

```json
{
  "sessionId": "s",
  "toolCall": {
    "title": "read_file",
    "kind": "read",
    "rawInput": { "path": "/tmp/a.ts" }
  },
  "options": [{ "optionId": "allow-once", "name": "Allow once", "kind": "allow_once" }]
}
```

测试期望：

- `permission-bash.json`：`title` 为 ``Execute `ls -la ~/.grok` ``，`message` 为 `ls -la ~/.grok`（不是 `Allow tool`，不是 JSON）
- `title: "bash", rawInput.cmd: "ls"`：标题 ``Execute `ls` ``，正文 `ls`
- `read_file`：标题 ``Read `/tmp/a.ts` ``，正文 `/tmp/a.ts`
- 无已知字段：标题为稳定名或 kind，正文是一行工具名，**不含** `{`

- [ ] **Step 2: 实现 `translatePermissionRequest`**

规则：有 `command`/`cmd` → 标题 `Execute \`...\``（若 ACP title 已是 `Execute ` 或带反引号则原样），正文为命令。有 `path`/`file_path`/`filePath` → `Read \`path\``（write/edit kind 用 Write），正文为路径。否则稳定名 + 至多一个 `description`/`query`/`pattern`/`url`。禁止 `JSON.stringify` 整个 input。禁止写死 `Allow tool`。

- [ ] **Step 3: 对话框 UI**

`chat.extensionRequest` 文案改为 “Grok needs permission” / “Grok 需要许可”。confirm 的 `message` 用等宽块（现有 `codex-dialog-inset` 或 `<pre className="codex-dialog-message">`）。

- [ ] **Step 4: 跑测**

```bash
node --experimental-strip-types --test lib/acp/permissions.test.mjs lib/i18n/messages/parity.test.mjs
```

---

### Task 2: Composer Effort

**Files:**
- Modify: `lib/grok-effort-levels.ts`, `lib/composer-models.test.mjs`
- Modify: `lib/i18n/messages/en.ts`, `zh-CN.ts`
- Modify: `components/ChatInput.tsx`（芯片 aria/title 走已改文案）

- [ ] **Step 1: 测试**

`visibleGrokEffortLevels(["auto","off","minimal","max","high"])` → `["high"]`  
`visibleGrokEffortLevels(["auto","off"])` → `["low","medium","high","xhigh"]`（交为空则回退）

- [ ] **Step 2: 实现求交**

`GROK_EFFORT_LEVELS` 为允许集。ACP 列表先 filter 再 sort。空则用默认四档。

- [ ] **Step 3: 文案**

`chat.changeReasoning` → “Change effort: {level}” / “更改 Effort：{level}”  
`chat.changeReasoningLabel` → “Change effort”  
`chat.reasoning` → “Effort”  
`chat.thinkingLow` 等四档改为 “Low effort” / “低 Effort”。短标签 Low/Med/High/Extra High 可留。Auto/Off/Minimal/Max 文案可留但不进菜单。

---

### Task 3: 空状态

**Files:**
- Modify: `lib/i18n/messages/en.ts`, `zh-CN.ts`
- Modify: `components/AppShell.tsx`
- Modify: `components/ChatWindow.tsx`

- [ ] **Step 1: 新键（两份 locale 同步）**

- `workspace.continueOrNew`: “Continue a session, or start a new one” / “继续已有会话，或开一个新会话”
- `workspace.selectSessionOrNew`: “Select a session from the sidebar, or start a new Grok session”
- `workspace.loginHint`: “If needed, sign in to Grok in Settings → Models”
- `chat.homeSubtitle`: “Grok Build sessions for this directory. The TUI and this app share ~/.grok.”

保留 `workspace.addModels` / `openModels` 键以免漏删引用，但主路径不再使用。`workspace.stepModels` 改成与 `continueOrNew` 同义或不再引用。

- [ ] **Step 2: AppShell 无项目空状态**

步骤 1 选项目，步骤 2 继续/新建。登录提示：仅当 `GET /api/auth/providers` 明确返回 `grok.com` 且 `loggedIn === false` 时显示；请求失败则不显示。

- [ ] **Step 3: 已选项目无会话 + 新会话 home 副标题**

---

### Task 4: 工具芯片服从 ACP

**Files:**
- Modify: `lib/tool-presets.ts` + 现有或新建 `lib/tool-presets.test.mjs`
- Modify: `hooks/useAgentSession.ts`
- Modify: `components/ChatWindow.tsx`, `components/ChatInput.tsx`

- [ ] **Step 1: 测试**

`composerShowsToolPreset(true) === true`  
`composerShowsToolPreset(false) === false`

- [ ] **Step 2: `loadTools` 成功 → `toolsAdvertised=true`，`AgentCapabilityError` / 失败 → `false`。新会话默认 `false`。**

- [ ] **Step 3: ChatInput 仅当 `onToolPresetChange && toolsAdvertised` 画 Shield。**

---

### Task 5: Settings 导航 + Models 主次栏

**Files:**
- Modify: `components/SettingsPage.tsx`
- Modify: `components/AppShell.tsx`（`SettingsSection` 类型与 `openSettings`）
- Modify: `lib/composer-models.ts` + test（`grokLiveChatModels`）
- Modify: `components/ModelsConfig.tsx`, `ModelsConfigNavigator.tsx`
- Modify: i18n

- [ ] **Step 1: 导航顺序** General → Models → Skills → Plugins → MCP → Remote → Archived

- [ ] **Step 2: `openSettings` 类型 = `SettingsSection`**

- [ ] **Step 3: `grokLiveChatModels` = `provider === "grok"`**

- [ ] **Step 4: Models 页**

- 头：Grok 账号和模型；副标题不要 `~/.pi/agent/models.json`
- 导航顶部只读 Grok 模型列表（`GET /api/models?cwd=`，Settings 传入 cwd；cwd 空则仍拉列表，失败则空）
- Accounts 仍是 grok.com 登录
- Custom providers 默认折叠，组下说明：探测/导入不改变 live chat
- Add provider 留在次栏页脚
- 无账号且无自定义时，主 CTA 选中/打开 grok.com 登录，不是 Add provider
- DeepSeek / thinking map 只留在自定义 ModelDetail（已是如此，不要搬到 ACP 列表）

---

### Task 6: 侧栏日常能力

**Files:**
- Modify: `components/CodexSidebar.tsx`
- Modify: `components/AppShell.tsx`
- Modify: i18n

- [ ] **Step 1: 会话菜单增加 Export**，点击走 `GET /api/sessions/:id/export`（`window.location.assign`，已有 user-initiated 白名单）

- [ ] **Step 2: 项目菜单增加 Skills / Plugins / MCP**，调用 `onOpenSettings`

- [ ] **Step 3: 有 linked（非 main）worktree 时默认展开区块；git 仓库在 list 成功后始终显示区块+创建行**

- [ ] **Step 4: 选中会话时顶栏子代理控件始终可见（count 可为 0）**

---

### Task 7: PRODUCT.md + 规格状态

- 空状态不再引导加模型
- Models 主路径是 Grok 登录 + ACP 列表
- 权限标题用 ACP title
- 规格文件状态改为已落地

---

### 验证

```bash
npm test
npm run typecheck
```

`lib/i18n/messages/parity.test.mjs` 必须绿。
