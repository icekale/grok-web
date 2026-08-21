# grok-web 操作面改为 Grok TUI 语言

日期：2026-08-21  
仓库：`icekale/grok-web`  
状态：已批准并落地。协议真相已由 `2026-08-21-grok-native-core-design.md` 锁定；本文只改操作面（设置、composer、空状态、权限、侧栏），不换壳。

## 1. 问题

内部合同已经是 Grok ACP 和 `~/.grok`。用户看见的还是 Pi 的操作习惯：

- 无项目空状态第二步是「去 Settings → Models 加模型」
- Settings → Models 是多供应商控制台（Accounts + Custom providers + thinking level map / DeepSeek thinking），不像 Grok 登录和 ACP 模型列表
- Composer 芯片说 Thinking / Reasoning，菜单仍带 Auto / Minimal / Max
- 权限框标题写死 `Allow tool`，副标题是 `extension request`；没有 `command` 时把整个 input `JSON.stringify`
- 工具档位 Shield 芯片只要 `onToolPresetChange` 在就显示，不管 ACP 有没有 `configOptions` tools
- Skills / Plugins / MCP 只埋在设置里；worktree 区块默认收起；会话菜单有重命名/归档/删除，导出 API 已有但不在菜单里
- 子代理开关只在 `count > 0` 时出现，TUI 用户不容易发现

这不是再做一层适配器能修的。壳可以留，说话方式必须改成 `grok` CLI 用户的脑子。

## 2. 目标

同一个三栏壳里，一个每天用 Grok TUI 的人不用先学 Pi 的设置体系，就能把同一批 `~/.grok` 会话做完。

1. **设置先谈 Grok。** Models 页主路径是 grok.com 登录和 ACP 模型列表。自定义 OpenAI-compatible provider 可以留，但必须标明「不改变当前对话模型列表」，并往后藏。
2. **Composer 说 Effort。** 只露出 Grok 的 `low / medium / high / xhigh`（或 ACP 实际返回、且落在这组里的档位）。
3. **空状态谈项目和会话。** 不要把「加模型」当成开箱第二步。
4. **权限框像 TUI。** 标题用 ACP `toolCall.title`（例如 `Execute \`ls\``）；正文是命令或路径，不是 JSON dump。
5. **Grok 日常能力在主路径。** worktree、skills、plugins、MCP、子代理、会话 rename/delete/export 按 TUI 用户的使用频率露出来。
6. **工具档位服从 ACP。** 没有 tools `configOptions` 就不画 Shield 芯片，不编造 Pi 的 none/read-only/full。

## 3. 非目标

- 不重画 chrome，不换成 grok.com 网页，不暗示 xAI 官方身份
- 不改 HTTP 路径，不重写 ACP 网关，不把内部 `pi-*` 符号大改名
- 不实现 Pi 才有的 extension custom UI
- 不删自定义 provider 功能（只降级）
- 不把 Archived / Remote / 外观从设置里拿掉
- 不在本计划做 TanStack / lucide / TypeScript 大升级

## 4. 约束

- 对话协议仍是 Grok ACP。直播模型列表仍来自 ACP，不是 `models.json`。
- 自定义 provider 可导入和探测，与 `PRODUCT.md` 现有句一致：它们不驱动 live chat。
- 用户可见文案：en + zh-CN 同步；`lib/i18n/messages/parity.test.mjs` 必须绿。
- 默认 `npm test` 不得拉起 `grok`、不得打真模型。
- 权限、effort、工具档位的测试夹具用 Grok / ACP 形状，禁止再用 `title: "bash"` 当唯一终端用例。

## 5. 设计

### 5.1 设置导航

现序：General → Archived → Models → Skills → Plugins → MCP → Remote。

改序：

1. General（外观、语言、声音、权限模式、关于）
2. Models（Grok 账号 + ACP 模型；自定义 provider 在页内降级）
3. Skills
4. Plugins
5. MCP
6. Remote
7. Archived（卫生项，放到最后）

`AppShell.openSettings` 的 section 类型扩到 `skills | mcp | remote | archived`，与 `SettingsPage` 对齐。侧栏/项目菜单跳转必须能落到这几页。

### 5.2 Settings → Models

页头文案改为 Grok 账号和模型，不要再写成「配置多家供应商」。

主栏（默认展开、默认选中）：

- grok.com / xAI 登录、退出、订阅状态（沿用现有 `_x.ai/auth/*` 和 Accounts 行）
- **只读** ACP 模型列表：id、显示名、该模型的 effort 档位。来源与 composer 相同（`mapGrokModels` / 现有 models API），不是手写 `models.json`
- 一句说明：当前对话用的就是这份列表

次栏（默认折叠，组名保留「Custom providers」）：

- 现有自定义 provider 编辑器可以留下
- 组上必须有说明：探测/导入不改变上面的 live chat 列表
- DeepSeek thinking、thinking level map、Anthropic thinking、cost 表只出现在自定义模型编辑器里，不出现在 ACP 模型只读列表上
- 「Add provider」留在次栏页脚，不占页头主按钮

空账号 + 无自定义 provider 时，主 CTA 是登录 Grok，不是添加 provider。

### 5.3 Composer Effort

- 芯片和菜单对用户说 **Effort**（en / zh-CN），不再说 Thinking / Reasoning
- 可见档位 = `visibleGrokEffortLevels(ACP 返回值)` 与 `["low","medium","high","xhigh"]` 的交集；ACP 没返回时用 `GROK_EFFORT_LEVELS`
- 菜单不出现 Auto / Off / Minimal / Max，即使内部类型暂时还留着这些字
- 默认仍是 `defaultGrokEffortLevel`（优先 `xhigh`，否则 `high`）
- 不再用 `thinkingLevelMap` 覆盖 Grok 档位标签

内部字段名（`thinkingLevel`、SSE 字段）可以留，避免无谓的协议改名。改的是用户看见的词和菜单内容。

### 5.4 空状态

无项目（`showPlaceholder` 且没有 `activeCwd`）：

1. 从侧栏选一个项目目录（该目录在 `~/.grok` 下的会话）
2. 继续已有会话，或开一个新会话

去掉「Add models in Settings → Models」作为第二步。未登录 Grok 时，可以在步骤下面加一行弱提示：需要的话去 Settings → Models 登录。已登录或说不清登录态时，不要出现这条。

已选项目、未选会话：保留「从侧栏选会话」，并补一句「或开一个新的 Grok 会话」。

新会话 home（`isEmptyNew`）：保留 `{cwd}` 标题，加一句副标题——这是这个目录的 Grok Build 会话，TUI 和 web 共用 `~/.grok`。不要在 home 上放「去加模型」。

### 5.5 权限框

`translatePermissionRequest`：

| 规则 | 结果 |
| --- | --- |
| 标题 | ACP `toolCall.title`，否则 `kind`，否则工具稳定名。禁止写死 `Allow tool` |
| `command` 或 `cmd` | 正文就是那条命令（保留换行），不包一层 JSON |
| `path` / 读写真相字段 | 正文是路径 |
| 其它 | 一行摘要：稳定工具名 + 至多一个已知字段。禁止把整个 input `JSON.stringify` 当主文案 |

对话框：

- `title` = 上面的 ACP 标题（TUI 同款 `Execute \`...\`` / `Read \`...\``）
- 副标题从 `extension request` 改成「Grok 需要许可」一类（en + zh-CN）
- 命令/路径用等宽块渲染，不要当普通段落挤成一行
- 按钮仍是取消 / 允许（现有 confirm）

`lib/acp/permissions.test.mjs` 和 `permission-bash.json` 夹具按新规则改期望。补一条 `read_file` / path 夹具，证明不是 JSON dump。

### 5.6 侧栏：会话动作对齐 TUI

会话 `⋯` 菜单：

- **重命名** — 有 ACP / `x.ai` 方法走协议，否则只改该会话 `summary.json` 标题（等同 `/rename`，自动标题不再覆盖）。菜单标 `/rename`。
- **删除** — 二次确认后删会话目录（等同 `/delete`）。菜单标 `/delete`。确认文案保持「从磁盘删掉，不能撤销」。
- **导出** — 走已有 `GET /api/sessions/:id/export`，打包该会话目录。
- **从侧栏隐藏** — grok-web 元数据，不是 TUI 命令。分隔线以下，不要写成 `/archive`，也不要做成另一套会话库。

顺序：Rename / Delete / Export，然后才是隐藏。Composer `/` 同样露出 `/rename` `/delete` `/export`（`/name` 仍可当别名）。`/delete` 走同一套磁盘删除确认。Recent 留下，当作同一批 `~/.grok` 会话的跳转，不是另一套会话库。

### 5.7 Worktrees / Skills / Plugins / MCP / 子代理

这些是 TUI 日常能力，放在项目列表和 Recent 之间，不要埋在设置或项目 `⋯` 里。

**Worktrees。** 选中项目是 git 仓库且 `worktrees` 拉回来后，侧栏区块默认展开（含创建行）。创建/删除行为不变。

**Skills / Plugins / MCP。** 选中项目时以日常按钮露出，分别 `openSettings("skills"|"plugins"|"mcp")`。Composer `/skills` `/plugins` `/mcp` 进同一页。从这条路径打开时，对话框是 Grok 工具面板（只含 Skills / Plugins / MCP），标题不是 Settings。完整设置页仍可从页脚进入。项目 `⋯` 不再重复这三项。页内编辑器不重写。

**子代理。** 打开的是根会话时，顶栏子代理控件就要在，不必等 `count > 0`。桌面顶栏写出 Subagents / 子代理，不要只剩图标。count 为 0 时控件仍可打开，空状态用现有 `subagents.empty`。用户文案不要出现 Codex。

### 5.8 工具档位芯片

Composer Shield 芯片只列出 ACP 枚举过的 `none | read-only | default | full`。

- 有枚举：只画声明过的档位，走现有 `session/set_config_option`
- `id: "tools"` 但没有 options / category 列表：不画芯片
- 无 tools 配置：不画芯片；会话按 Grok 默认工具集工作
- 禁止在没有 ACP 声明时本地伪造档位并画芯片；新会话在尚未得知声明前不要带 `toolNames`

`useAgentSession` 需要把「ACP 声明了哪些档位」传给 `ChatInput`，不能只传 `onToolPresetChange`。

## 6. 测试

必须有、且不打真模型：

- `translatePermissionRequest`：终端命令、`read_file` 路径、无已知字段时的一行摘要；期望标题不是 `Allow tool`
- `visibleGrokEffortLevels` + composer 可见档位：菜单不含 auto/off/minimal/max
- `hasToolsConfig` 为假或 `advertisedToolPresets` 为空时不把工具芯片当作必有 UI（单元测 session/config，不必上浏览器）
- 会话导出仍走现有 `getSessionExport` 测试；如有菜单/i18n 键，parity 覆盖
- en / zh-CN key parity

不在本计划把 Playwright e2e 拉进 CI。

## 7. 成功标准

一个 Grok TUI 用户：

1. 打开应用，空状态让他选项目/会话，不让他去加模型
2. Settings → Models 第一眼是 Grok 登录和 ACP 模型
3. Composer 只看见 Effort 四档（或 ACP 子集）
4. 权限框标题和命令跟 TUI 同一句话
5. 能从侧栏导出、重命名、删除会话；能从项目菜单进 Skills / Plugins / MCP
6. ACP 没声明 tools 时，composer 没有 Shield 档位芯片

`PRODUCT.md` 落地后补三句：空状态不再引导加模型；Models 主路径是 Grok+ACP；权限标题用 ACP title。Chrome 仍可在日后演变，但本计划不换布局。

## 8. 与旧规格的关系

- `2026-08-18-grok-web-design.md` 第 4 节「完全复刻 pi-web 交互」对**用词和设置信息架构**不再适用。三栏位置仍以该节为准。
- `2026-08-21-grok-native-core-design.md` 仍然是协议法。本文不改 ACP 映射，只改用户看见的层；权限映射的标题/正文规则由本文收紧。
- 第一版第 4 节已写的会话导出，由本文补到菜单。

## 9. 落地顺序

1. 权限框标题/正文 + 测试（用户每次跑工具都能看见）
2. Composer Effort 用词和档位过滤
3. 空状态文案
4. 工具芯片按 `hasToolsConfig` 显隐
5. Settings 导航顺序 + Models 主/次栏
6. 会话导出菜单 + 项目菜单 Skills/Plugins/MCP + worktree 默认展开规则 + 子代理控件常驻

1–4 可以先合，5–6 依赖更多 UI，但仍属同一规格，不另开产品方向。
