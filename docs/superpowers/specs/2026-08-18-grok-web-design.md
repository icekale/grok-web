# grok-web 设计规格

日期：2026-08-18  
仓库：`/Users/kale/grok-web`  
参考 UI：https://github.com/icekale/pi-web（本地 `/Users/kale/pi-web`）

## 1. 产品

grok-web 是 Grok Build 的本机浏览器工作区。用户在浏览器里找项目、开会话、看实时智能体、预览文件和 Git、改设置，效果与 icekale/pi-web 一致，底下对接 Grok 而不是 Pi。

成功标准：在 pi-web 里能做的事，在 grok-web 里用同一套界面能对 Grok 做完；TUI 与 web 共用 `~/.grok`，两边都能继续同一会话。

非目标：托管多租户、云端沙箱、重写 Grok、另做一套视觉或导航、第一版用 Rust、浏览器直连 ACP。

## 2. 已定决策

| 项 | 决定 |
| --- | --- |
| 仓库 | 新仓库，不从 pi-web 整树复制当长期结构 |
| UI | **完全复刻** icekale/pi-web 的视觉、交互、信息架构、i18n |
| 运行时 | Vite + TanStack + 本机 Node（与 pi-web 同栈） |
| 智能体 | 官方 ACP：一个长驻 `grok agent stdio` |
| 默认权限 | 不带 `--always-approve`；批准在浏览器完成 |
| 会话真相 | `~/.grok/sessions`（可用 `GROK_HOME` 覆盖根目录） |
| 应用元数据 | `~/.grok/grok-web/`（置顶、归档等），不改 Grok 会话目录名 |
| 监听 | 默认 `127.0.0.1:30142` |
| 远程 | 与 pi-web 相同：非回环必须设密码；用户名固定为 `grok` |
| Node | `>= 22.19.0` |

「新仓库」指 git 历史独立、不依赖 `@earendil-works/pi-coding-agent`。实现时**可以按文件移植** pi-web 的 UI 组件和路由壳，但 Pi SDK 调用全部换成下文的适配器。

## 3. 架构

三层：

1. **浏览器** — 复刻后的 pi-web UI。只打本机 HTTP/SSE，不 spawn Grok，不直连 ACP。
2. **grok-web Node 网关** — 提供与 pi-web 相同形状的 API；适配 ACP 与磁盘。
3. **`grok` 二进制** — 会话落盘、工具、MCP、子代理、权限。网关不把它的内部格式当写路径。

```
浏览器 UI（复刻 pi-web）
        │ HTTP / SSE
        ▼
本机 Node：会话索引 │ ACP 网关 │ 文件/Git 适配 │ 设置/鉴权
        │ stdio JSON-RPC（ACP + x.ai 扩展）
        ▼
grok agent stdio
        │
        ▼
~/.grok（sessions / auth.json / config.toml / grok-web 元数据）
```

进程：grok-web 启动时拉起**一个** `grok agent stdio`，对多个浏览器会话做 ACP 多路复用（`session/new`、`session/load`、`session/prompt`）。进程退出则再拉起；进行中的回合标失败，可重试。

启动入口：`bin/grok-web.js`，行为对齐 `pi-web`（`--port` / `-p`、`--hostname` / `-H`、`--no-open`）。环境变量前缀 `GROK_WEB_`。

## 4. 界面与组件

视觉和交互以 icekale/pi-web **当前主干**为准，不另做仪表盘或卡片墙。

| 表面 | 行为（与 pi-web 相同） | Grok 侧 |
| --- | --- | --- |
| 左栏项目/会话 | 搜索、置顶、归档、重命名、导出、删除 | 列表来自 `summary.json`。重命名：有 ACP/`x.ai` 方法就走协议，否则只改该会话 `summary.json` 的标题（等同 TUI `/rename`，自动标题不再覆盖）。删除：二次确认后删除该会话目录（等同 TUI `/delete`）。导出：打包该会话目录。置顶/归档只写元数据 |
| 中栏对话 | 流式正文、折叠思考、工具、计划、排队、插话、停止 | ACP `session/prompt` + `session/update` |
| 顶栏 | 模型、effort、分叉、从此处编辑 | ACP / `x.ai` 扩展 |
| 右栏 | 文件浏览/预览/上传、Git Diff、worktree | `x.ai/fs/*`、`x.ai/git/*`、`x.ai/git/worktree/*` |
| 设置 | 模型、权限模式、MCP/技能、外观、远程访问 | `~/.grok` + `x.ai/auth` |
| 权限弹层 | 允许/拒绝当前工具 | ACP permission request |
| 子代理 | 树 + 只读子会话；引导/暂停走根 | Grok 子代理会话 + ACP |
| 窄屏 | 左抽屉、右页内面板 | 无额外后端 |

打开应用落到上次项目/会话。目标 WCAG 2.1 AA，与 pi-web 一致。

## 5. 数据流

**适配器保 UI 不动。** 路由与命令形状对齐 pi-web：`/api/sessions`、`/api/agent/:id`、SSE 事件名与载荷尽量兼容现有 hooks。Pi 专有字段在适配器里填默认或从 Grok 等价物映射，禁止为 Grok 改一版不兼容的前端协议。

### 读（不拉起回合）

- 扫 `~/.grok/sessions/<encoded-cwd>/<session-id>/summary.json` 做项目分组与侧栏。
- 历史正文译 `updates.jsonl`（权威对话日志）。译不了的条目跳过并记日志，不拖垮整棵树。
- `chat_history.jsonl` 不作为 UI 主源。

### 写 / 实时

- 新开会话：`session/new`，`cwd` 为项目目录；`_meta` 带当前权限模式（默认询问，不是 yolo）。
- 续聊：`session/load` / ACP 恢复；失败则只读打开磁盘历史，提示另开或重试。
- 发送：`POST /api/agent/:id` → `session/prompt`。
- 流：`session/update`（`agent_message_chunk`、`agent_thought_chunk`、`tool_call`、`tool_call_update`、`plan`）译成 pi-web SSE。
- 排队/插话/停止：映射到 Grok/ACP 已有的取消、追加与转向能力；若某条 ACP 能力缺失，UI 控件保留，操作返回明确错误，不静默吞掉。

### 其它写路径

- 分叉：`x.ai/session/fork`。
- 文件与 Git：优先 `x.ai/*`；扩展不可用时网关用本机 fs/git 做只读预览，写操作失败并说明。
- 设置：读写 `config.toml`、`auth.json`。未登录走 `x.ai/auth`。
- 元数据：仅 `~/.grok/grok-web/`（JSON）。禁止重命名或移动 Grok 会话目录来表示置顶/归档。

### 与 TUI 共存

磁盘上的会话是唯一真相。TUI 与 web 同时写入同一会话时：web 在 `session/load` 失败或检测到占用时提示「只读 / 另开」，不覆盖对方文件。

## 6. 错误处理

| 情况 | 行为 |
| --- | --- |
| 找不到 `grok` | 启动页给出安装说明，会话操作不可用 |
| ACP 进程退出 | 自动再拉起一次；当前回合失败可重试；侧栏/历史仍可读 |
| 未登录或凭据过期 | 走 `x.ai/auth`；失败停在可重试登录态；草稿保留 |
| 权限拒绝 | 该工具失败，其余按 Grok 规则；UI 显示结果 |
| 权限超时未点 | 按拒绝，并提示 |
| 会话文件损坏 | 侧栏仍列出能读到的字段；点开给明确错误 |
| SSE 断开 | 自动重连并补回合状态；补不上提示刷新，草稿保留 |
| 未设密码绑定非回环 | 拒绝启动或拒绝该 bind |
| 删除会话/worktree | 二次确认；删除 Grok 会话目录，不可恢复 |

## 7. 测试

测适配器，不测真实 `grok` 进程、不测真实模型。

必测（`node --test`，测试文件与模块同目录）：

1. ACP `session/update` 夹具 → pi-web SSE / 消息树
2. `~/.grok/sessions` 夹具 → 侧栏分组、标题、时间
3. `updates.jsonl` 夹具 → 只读历史
4. 权限允许 / 拒绝 / 超时
5. 置顶/归档只改元数据，不改会话目录名
6. 无密码时拒绝 `0.0.0.0`

第一版不加全界面 Playwright、不加真 MCP。适配器稳定后再加一条冒烟：进程能起来，能列出夹具会话。

## 8. 目录（实现时）

```
grok-web/
  bin/grok-web.js
  src/           # TanStack 路由与 UI（移植自 pi-web）
  lib/           # 适配器、会话索引、元数据、远程访问
    acp/         # stdio 客户端与多路复用
    grok-fs/     # 读 ~/.grok/sessions
    map/         # ACP ↔ pi-web 事件
  docs/superpowers/specs/
```

依赖：`@agentclientprotocol/sdk` + 与 pi-web 同级的 React/TanStack/Vite。不引入 `pi-coding-agent`。

## 9. 实现顺序（供后续计划拆分，不改变产品范围）

产品范围仍是 pi-web 全功能对齐。落地按依赖切，避免并行两套 UI 协议：

1. 可启动的壳 + 会话索引（只读侧栏与历史）
2. ACP 网关 + 实时对话 + 权限
3. 排队、插话、停止、分叉、从此处编辑
4. 右栏文件 / Git / worktree
5. 设置、登录、MCP/技能、远程访问
6. 子代理树

每一步都接在同一套复刻 UI 上，不先做临时界面再换。
