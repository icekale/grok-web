# Grok Web 工作态状态条实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 干活时 `phaseLabel` 不因工具卡出现而消失，避免直播区看起来像已经中断。

**Architecture:** 只改 `ChatWindow.tsx` 里工作态状态条的渲染条件，去掉 `!hasStreamingContent`。`stopping` 分支、`bashRunning`、过程摘要、工具卡、composer、侧栏都不动。不新增协议或组件。

**Tech Stack:** React 19, TypeScript, Node test runner 源码契约测试。

**Spec:** `docs/superpowers/specs/2026-08-24-grok-web-live-working-status-design.md`

---

### Task 1: 锁定状态条在有流式内容时仍显示

**Files:**
- Modify: `components/ChatWindow.dialogs.test.mjs`
- Modify: `components/ChatWindow.tsx`

- [ ] **Step 1: 写失败测试**

在 `components/ChatWindow.dialogs.test.mjs` 末尾追加：

```js
test("keeps the live phase label while streaming content is visible", () => {
  const stopping = source.slice(
    source.indexOf('agentRunning && agentPhase?.kind === "stopping"'),
    source.indexOf("bashRunning &&"),
  );
  assert.match(stopping, /agentRunning && agentPhase && agentPhase\.kind !== "stopping"/);
  assert.doesNotMatch(stopping, /!hasStreamingContent/);
  assert.match(stopping, /phaseLabel\(agentPhase, t\)/);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --experimental-strip-types --test components/ChatWindow.dialogs.test.mjs
```

Expected: FAIL，现有条件仍是 `agentRunning && !hasStreamingContent && agentPhase && agentPhase.kind !== "stopping"`。

- [ ] **Step 3: 最小实现**

`components/ChatWindow.tsx` 把工作态状态条从：

```tsx
{agentRunning && !hasStreamingContent && agentPhase && agentPhase.kind !== "stopping" && (
```

改成：

```tsx
{agentRunning && agentPhase && agentPhase.kind !== "stopping" && (
```

`stopping` 分支保持原样。不要改 `hasStreamingContent` 对 `MessageView` 的守卫。

- [ ] **Step 4: 再跑测试确认通过**

```bash
node --experimental-strip-types --test components/ChatWindow.dialogs.test.mjs
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add components/ChatWindow.dialogs.test.mjs components/ChatWindow.tsx
git commit -m "fix: keep live phase label while tools stream"
```

---

## Spec coverage

| Spec | Task |
| --- | --- |
| 去掉 `!hasStreamingContent` | Task 1 |
| `stopping` 单独渲染 | Task 1 不改 stopping 分支 |
| 不改 composer/侧栏/摘要/工具卡 | Task 1 只动这一行 |

## Placeholder scan

无 TBD。测试和替换字符串都是原文。
