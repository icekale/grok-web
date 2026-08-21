# grok-web 内部模型改为 Grok ACP 真相

日期：2026-08-21  
仓库：`/Users/kale/grok-web`  
状态：已定方向，按 `docs/superpowers/plans/2026-08-21-grok-native-core.md` 分阶段落地

## 1. 问题

第一版规格把「适配器保 UI 不动、SSE 尽量兼容 pi-web」写成了架构法。结果是：

- 浏览器和 `useAgentSession` 说 Pi 方言（`bash` / `pi-bash-*.log` / `extension_ui_request` / `rpc-manager` 会话）
- Grok ACP 的真实载荷（`run_terminal_command`、`Execute \`cmd\``、嵌套 `content`、chunk 工具 id、ACP 图片块）被翻译层吃掉
- 测试夹具是假 Pi 形状，所以 Grok 特有字段在 CI 里永远是绿的，只在真实对话框里爆

这不是「还差几个补丁」，是真相源放错了层。

## 2. 目标

保留现在的壳：侧栏、对话栏、文件/Git、设置、i18n、路由外形。

改变内部合同：

1. **磁盘与 ACP 是真相。** 会话正文来自 `~/.grok/sessions/.../updates.jsonl` 的 `session/update`。实时流来自同一个 ACP 形状。
2. **测试只认 Grok 夹具。** 新的 mapper / 权限 / 历史测试必须能重放真实（或从真实裁剪的）ACP 行。禁止再以 `title: "bash"` 当 Grok 终端工具的唯一用例。
3. **UI 只展示。** `MessageView` / 权限框 / 状态行从已经规范化的 Grok 消息上取字段，不再猜测 Pi 工具名。
4. **Pi 变成要删的兼容层。** `rpc-manager`、`pi-stubs`、双 HTTP 树、`pi-bash` 日志、Pi 工具 preset 名，不是架构中心。

非目标：新视觉、新框架、重写 Grok、浏览器直连 ACP、为了像 TUI 先换 chrome、把 HTTP 路径改名成另一套 REST。

## 3. 目标分层

```
浏览器壳（AppShell / Sidebar / Chat / File / Git）
        │ HTTP 路径保持 /api/agent /api/sessions /api/files /api/git
        │ 载荷：grok-web 自己的 wire（可以沿用现有事件名）
        ▼
lib：Grok 消息模型 + ACP 网关
        │ stdio JSON-RPC（ACP + x.ai）
        ▼
grok agent stdio  +  ~/.grok/sessions
```

现在错误的箭头是 `ACP → Pi SSE → Pi 会话引擎 → UI`。  
改成 `ACP → Grok 消息 → UI`。中间不再经过 `rpc-manager`。

## 4. 内部模型（锁定）

规范化后的对话对象继续用现有 `lib/types.ts` 的 `AgentMessage` 家族（user / assistant / toolResult），但语义改为 Grok：

| 字段 | 规则 |
| --- | --- |
| `toolCall.toolName` | 稳定名：`run_terminal_command` → `bash`；后续 ACP `title: Execute \`...\`` 不得覆盖 |
| `toolCall.input` | `sanitizeGrokToolInput` 之后；bash 以 `command` 为准 |
| `toolResult.content` | 只要工具 stdout/结果，不要把 `description` 拼进去 |
| 用户图 | ACP `image` 块；历史重载也要还原，不能只在发送路径存在 |
| 权限 | ACP `session/request_permission` 的 `toolCall` + `options`；对话框展示命令，不是 JSON dump |

实时 SSE 事件名（`agent_start`、`message_update`、`tool_execution_update`）可以留着，当作 **grok-web wire**，不再承诺兼容 pi-web。改名是可选打磨，不是本计划成功标准。

禁止：

- 新代码 `import` `lib/pi-stubs/*`（`getAgentDir` 改 `grokHome()`）
- 新代码调用 `startRpcSession` / `getRpcSession`
- 新测试用 Pi 工具名冒充 Grok 终端工具
- 为了「像 Pi」而保留 `pi-bash-*.log` 作为 agent bash 的输出通道

## 5. 测试策略（本计划的真正护栏）

夹具目录：`lib/acp/fixtures/`。来源是真实 `updates.jsonl` / permission 参数的裁剪，不是手写 Pi 形状。

最低集：

- 终端：`run_terminal_command` → 中间 description → completed stdout
- 读文件：先 `read_file`，后 `title: Read \`path\``，content 为嵌套 `{type:"content", content:{type:"text"}}`
- 权限：`title: run_terminal_command` + `rawInput.command`
- 图片 prompt：`session/prompt` 带 `type: image`
- 工具 id：`call-<uuid>-N` 在计数时折成一次调用
- 信号：`signals.json` + `chat_history.jsonl` 的当前窗口次数

每改 `history-map` / `map-events` / `permissions`，必须重放这批夹具。

假 ACP 进程（`lib/acp/fake-agent.mjs`）继续用于进程级测试，但发出的 `session/update` 必须长得像 Grok，不能长得像 Pi。

## 6. 要删的兼容层（顺序固定）

1. 双 HTTP 树：`src/routes/api/*` 直接调 `lib/*`，删除 `app/api` 中转
2. `lib/rpc-manager.ts`（Pi 会话引擎；子代理与 project-trust 已有 ACP 等价物）
3. `lib/pi-stubs/`
4. 产品面上的 Pi 专有能力：composer `!` + `pi-bash-*.log`；仅 Pi 认识的 tool 名 preset（ACP `configOptions` 除外）

壳文件（`AppShell.tsx`、`CodexSidebar.tsx`、`ChatWindow.tsx`、`FileViewer.tsx`）本计划不重写。`useAgentSession.ts` 只在合同已经是 Grok 之后再拆，禁止先拆后改协议。

## 7. 成功标准

- 新录一条 Grok `tool_call`（含 `run_terminal_command`），不在 `MessageView` 里加特殊 if，卡片和权限框就能看
- `rg "pi-stubs|rpc-manager|startRpcSession|pi-bash" --glob '!docs/**' --glob '!node_modules/**'` 在落地结束后为空，或只剩有意保留的注释/迁移说明
- `npm test` 绿；主路径测试夹具来自 ACP，而不是 `title: "bash"` 独苗
- 用户可感知的壳不变：项目列表、对话、文件、Git、设置仍在原位置

## 8. 与旧规格的关系

`docs/superpowers/specs/2026-08-18-grok-web-design.md` 第 5 节「适配器保 UI 不动 / SSE 兼容 pi-web」作废，改由本文替换。视觉与信息架构仍以该文第 4 节为准（壳保留）。落地后改 `PRODUCT.md` 的「adapter preserves Pi protocol」表述，避免后续工作又锁回去。
