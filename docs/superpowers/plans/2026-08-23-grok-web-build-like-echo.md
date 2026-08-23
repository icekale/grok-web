# Grok Web Build 式混合回显实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Grok Web 在工作中显示完整工具时间线和实时结果，完成后保留可一次展开的过程摘要，同时让 thinking 默认折叠。

**Architecture:** 复用现有 ACP/SSE 消息、`streamState.streamingMessage` 和 `liveToolResults`，只调整 `MessageView` 的流式筛选/默认展开策略以及 `ChatWindow` 向过程子消息传递的显示参数。不新增协议、持久化字段或渲染服务。

**Tech Stack:** React 19, TypeScript, `renderToStaticMarkup`, Node test runner, Playwright ACP E2E。

**Spec:** `docs/superpowers/specs/2026-08-23-grok-web-build-like-echo-design.md`

---

### Task 1: 锁定 MessageView 的混合回显行为

**Files:**
- Modify: `components/MessageView.test.mjs`
- Modify: `components/ChatWindow.process-details.test.mjs`
- Modify: `e2e/acp-core.spec.ts`

- [ ] **Step 1: 更新流式多工具测试为完整时间线**

将 `keeps only the current tool card while streaming earlier green rows` 改为 `keeps every tool card while streaming`。保留同一 assistant 消息中的 `read_file`、`grep`、`search_replace`，调用 `renderMessage(..., { isStreaming: true })`，并断言三种工具名和各自输入摘要都出现在 HTML 中；断言不再检查 `+2` 或前序工具缺失。

```js
const html = renderMessage({
  role: "assistant",
  provider: "grok",
  model: "grok-4.6",
  content: [
    { type: "text", text: "working" },
    { type: "toolCall", toolCallId: "c1", toolName: "read_file", input: { target_file: "a.ts" } },
    { type: "toolCall", toolCallId: "c2", toolName: "grep", input: { pattern: "foo" } },
    { type: "toolCall", toolCallId: "c3", toolName: "search_replace", input: { file_path: "a.ts" } },
  ],
}, { isStreaming: true });

assert.match(html, />read_file</);
assert.match(html, />grep</);
assert.match(html, />search_replace</);
assert.match(html, /a\.ts/);
assert.match(html, /foo/);
```

- [ ] **Step 2: 添加实时 tool result 默认可见测试**

在 `MessageView.test.mjs` 中添加一个 streaming assistant 消息和 `toolResults` Map，结果文本使用公开标记 `LIVE_TOOL_OUTPUT`。不传任何展开 prop，断言 HTML 同时包含工具名、输入和 `LIVE_TOOL_OUTPUT`。

```js
const html = renderMessage({
  role: "assistant",
  provider: "grok",
  model: "grok-4.6",
  content: [{
    type: "toolCall",
    toolCallId: "live-1",
    toolName: "run_terminal_command",
    input: { command: "printf LIVE_TOOL_OUTPUT" },
  }],
}, {
  isStreaming: true,
  toolResults: new Map([[
    "live-1",
    { role: "toolResult", toolCallId: "live-1", content: [{ type: "text", text: "LIVE_TOOL_OUTPUT" }] },
  ]]),
});

assert.match(html, /LIVE_TOOL_OUTPUT/);
```

- [ ] **Step 3: 锁定 thinking 与工具展开策略分离**

更新现有 `keeps streaming thinking and tool inputs collapsed by default`：不再要求工具输入隐藏，只断言 thinking 的 markdown 标题/列表不在 HTML 中，并断言工具命令在 HTML 中。

保留 `defaultDetailsExpanded: true` 的兼容测试，并新增显式策略测试：

```js
const html = renderMessage(assistantWithThinkingAndTool(), {
  defaultToolDetailsExpanded: true,
  defaultThinkingDetailsExpanded: false,
});
assert.doesNotMatch(html, /<h2>Plan<\/h2>/);
assert.match(html, /printf &quot;hello&quot;/);
```

将 `keeps a streaming write collapsed until the user expands it` 改为验证 streaming write 的输入在默认工具展开策略下可见；仍保留 `rawInput` 不完整时显示原始片段的行为断言。

- [ ] **Step 4: 增加 ChatWindow 过程组参数契约测试**

在 `components/ChatWindow.process-details.test.mjs` 中保留过程摘要默认折叠断言，并增加源码契约断言，确保过程组子消息使用独立的工具展开参数，而不是把同一个参数传给 thinking：

```js
assert.match(source, /defaultToolDetailsExpanded/);
assert.match(source, /defaultThinkingDetailsExpanded/);
assert.match(source, /defaultToolDetailsExpanded: true/);
assert.match(source, /defaultThinkingDetailsExpanded: false/);
```

- [ ] **Step 5: 更新 ACP 浏览器场景的可见性断言**

在 `e2e/acp-core.spec.ts` 的 `E2E_TOOL` 场景中，发送后直接断言工具名和 `E2E_TOOL_OK` 可见，不再先点击 `button.chat-process-summary` 才能看到工具；保留过程摘要断言只用于已完成历史回合的场景。

- [ ] **Step 6: 运行测试确认 RED**

Run:

```bash
node --experimental-strip-types --test --test-concurrency=1 components/MessageView.test.mjs components/ChatWindow.process-details.test.mjs
```

Expected: 新的多工具、实时结果和参数契约断言失败，因为当前实现仍隐藏前序工具且工具默认折叠。

---

### Task 2: 实现 MessageView 的完整流式工具时间线

**Files:**
- Modify: `components/MessageView.tsx`

- [ ] **Step 1: 添加兼容的独立展开 props**

在 `MessageView` 的 Props 中保留 `defaultDetailsExpanded?: boolean`，并加入：

```ts
defaultToolDetailsExpanded?: boolean;
defaultThinkingDetailsExpanded?: boolean;
```

在 `MessageView` 内计算兼容默认值：

```ts
const toolDetailsExpanded = defaultToolDetailsExpanded ?? defaultDetailsExpanded ?? isStreaming ?? false;
const thinkingDetailsExpanded = defaultThinkingDetailsExpanded ?? defaultDetailsExpanded ?? false;
```

把两个值传入 `AssistantMessageView`，并加入 `memo` comparator。这样旧调用仍保持旧语义，新流式调用默认只展开工具，thinking 仍折叠。

- [ ] **Step 2: 移除流式阶段的前序工具过滤**

将 `visibleBlockItems` 从“非流式全部、流式只保留最后一个 toolCall”改为直接返回 `blockItems`：

```ts
const visibleBlockItems = blockItems;
```

删除只用于补偿隐藏前序工具的 `streamingToolSummary` 和其渲染块，避免工具时间线下方再显示重复的 `runningToolsMore` 摘要。保留 agent phase 的轻量状态提示，它位于 ChatWindow 的消息区域之外。

- [ ] **Step 3: 把独立策略传入 block 渲染**

扩展 `BlockView` props：

```ts
defaultToolDetailsExpanded: boolean;
defaultThinkingDetailsExpanded: boolean;
```

将 thinking 传给 `ThinkingBlock` 的 `defaultExpanded`，将 tool call 传给 `ToolCallBlock` 的 `defaultExpanded`。`ToolCallBlock` 保持现有 `userExpanded ?? defaultExpanded` 优先级，让用户手动收起/展开后不被后续流式更新覆盖。

- [ ] **Step 4: 保留现有安全和延迟逻辑**

不要修改以下逻辑：`MAX_MARKDOWN_CHARS`、`loadThinkingContent`、`loadToolResult`、`SafeMarkdownBody`、`getToolCallInputText`、`getResultDiff`、错误状态和结果缓存。工具默认展开只改变结果节点何时可见，不绕过 deferred result 的 API 加载和大文本保护。

- [ ] **Step 5: 运行 MessageView 测试确认 GREEN**

Run:

```bash
node --experimental-strip-types --test --test-concurrency=1 components/MessageView.test.mjs
```

Expected: 流式多工具、实时结果、thinking 折叠和既有工具输入测试全部通过。

- [ ] **Step 6: 提交 MessageView 变更**

```bash
git add components/MessageView.tsx components/MessageView.test.mjs
git commit -m "fix: show the full live Grok tool timeline"
```

---

### Task 3: 让完成态过程摘要一次展开全部工具详情

**Files:**
- Modify: `components/ChatWindow.tsx`
- Modify: `components/ChatWindow.process-details.test.mjs`

- [ ] **Step 1: 扩展 renderMessage 的局部显示参数**

在 `renderMessage` 的 `options` 类型中增加：

```ts
defaultToolDetailsExpanded?: boolean;
defaultThinkingDetailsExpanded?: boolean;
```

将这两个值传给 `MessageView`，同时保留现有 `defaultDetailsExpanded` 的传递兼容性。

- [ ] **Step 2: 为过程组子消息设置混合默认值**

在 `ProcessDetailsGroup` 的 `visibleProcessIndices.map` 和 `finalProcessMessage` 两个 `renderMessage` 调用中传入：

```tsx
defaultToolDetailsExpanded: true,
defaultThinkingDetailsExpanded: false,
```

这些子消息只在 `expanded` 分支挂载，因此过程摘要点击一次后工具卡以展开状态首次挂载；thinking 不会被同步展开。过程组再次收起后，组件卸载，下一次展开重新得到一致的默认状态。

- [ ] **Step 3: 为 streamingMessage 显式传工具展开策略**

在 ChatWindow 最后的 streaming `MessageView` 调用中传入：

```tsx
defaultToolDetailsExpanded={true}
defaultThinkingDetailsExpanded={false}
```

这使产品策略在调用点清楚可读，即使以后 `MessageView` 的通用兼容默认值调整，实时回显仍保持 Build 式工具可见性。

- [ ] **Step 4: 保持过程摘要和滚动行为不变**

不要修改 `isLiveTail`、`findFinalAssistantIndex`、`splitFinalAssistantBlocks`、历史分页、`promptAnchorSpacer` 或 minimap。流式过程仍只从 `streamState.streamingMessage` 渲染，避免把持久化工具卡重复插入当前 transcript。

- [ ] **Step 5: 运行组件测试**

Run:

```bash
node --experimental-strip-types --test --test-concurrency=1 components/MessageView.test.mjs components/ChatWindow.process-details.test.mjs components/ChatWindow.plan.test.mjs
```

Expected: 相关组件测试通过，过程摘要仍默认折叠，新的策略契约断言通过。

- [ ] **Step 6: 提交 ChatWindow 变更**

```bash
git add components/ChatWindow.tsx components/ChatWindow.process-details.test.mjs e2e/acp-core.spec.ts
git commit -m "feat: expand completed Grok process details once"
```

---

### Task 4: 完成回归验证

**Files:**
- No new files.

- [ ] **Step 1: 运行全部相关 Node 测试**

```bash
node --experimental-strip-types --test --test-concurrency=1 components/MessageView.test.mjs components/ChatWindow.process-details.test.mjs components/ChatWindow.plan.test.mjs hooks/useAgentSession.test.mjs lib/agent-event-stream.test.mjs
```

Expected: exit code `0`。

- [ ] **Step 2: 运行类型检查和 lint**

```bash
npm run typecheck
npm run lint
```

Expected: 两个命令均 exit code `0`，无新增 lint 或 TypeScript 错误。

- [ ] **Step 3: 运行构建**

```bash
npm run build:tanstack
```

Expected: TanStack standalone build 完成且无编译错误。

- [ ] **Step 4: 运行 ACP 浏览器场景**

```bash
npm run test:e2e:acp -- --grep "E2E_TOOL|ACP core"
```

Expected: 工具调用无需点击过程摘要即可看到工具名和 `E2E_TOOL_OK`；其他 ACP core 场景通过。

- [ ] **Step 5: 检查 diff 和工作区**

```bash
git diff HEAD~2..HEAD --stat
git status --short
```

确认只包含设计/计划提交和本次回显相关代码、测试变更；不修改用户已有的无关工作区文件。
