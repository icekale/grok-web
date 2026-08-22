# 模型设置页去掉 Grok 只读 Effort Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 设置 → 模型 的「Grok 模型」行只显示图标和名称，不再画出 ACP Effort 档位。

**Architecture:** 只改设置页导航展示层。live 行不再携带 `efforts`；对话输入栏的 Effort 菜单和 `session/set_mode` 不动。「Grok 模型」分组与说明保留。

**Tech Stack:** React + TypeScript, CSS, Node.js built-in test runner.

**Spec:** `docs/superpowers/specs/2026-08-22-models-hide-live-effort-design.md`

---

### Task 1: 把回归断言改成「live 行没有 Effort」

**Files:**
- Modify: `components/models-config/ModelsConfigNavigator.test.mjs`
- Modify: `components/ModelsConfig.test.mjs`

- [ ] **Step 1: 替换 navigator 里叠两行 Effort 的断言**

把 `live Grok rows stack the model name above effort so the name stays visible` 换成：

```js
test("live Grok rows show the model name and omit effort", () => {
  assert.match(source, /models-settings-live-row/);
  assert.match(source, /models-settings-row-label/);
  assert.match(source, /t\("models\.liveChatHint"\)/);
  assert.doesNotMatch(source, /models\.liveEffort/);
  assert.doesNotMatch(source, /efforts:/);
  assert.doesNotMatch(source, /models-settings-live-effort/);
  assert.doesNotMatch(styles, /\.models-settings-live-effort\s*\{/);
});
```

- [ ] **Step 2: 增加 ModelsConfig 不再给导航栏算 Effort 的断言**

在 `components/ModelsConfig.test.mjs` 的 `live ACP models use composer labels instead of raw names` 旁增加：

```js
test("live ACP models passed to the navigator do not include effort lists", () => {
  assert.match(source, /name: composerModelLabel\(model\.id, model\.name\)/);
  assert.doesNotMatch(source, /efforts: visibleGrokEffortLevels/);
  assert.doesNotMatch(source, /visibleGrokEffortLevels\(/);
});
```

并删除或改写旧的 `live ACP models use composer labels instead of raw names`，避免两条测试重复断言同一行。

- [ ] **Step 3: 先跑测试确认失败**

Run:

```bash
node --experimental-strip-types --test --test-concurrency=1 components/ModelsConfig.test.mjs components/models-config/ModelsConfigNavigator.test.mjs
```

Expected: 新断言失败，因为源码仍渲染 `models.liveEffort` 并调用 `visibleGrokEffortLevels`。

---

### Task 2: 从 live 行拿掉 Effort

**Files:**
- Modify: `components/models-config/ModelsConfigNavigator.tsx`
- Modify: `components/ModelsConfig.tsx`
- Modify: `app/globals.css`
- Modify: `lib/i18n/messages/en.ts`
- Modify: `lib/i18n/messages/zh-CN.ts`

- [ ] **Step 1: 收窄 live 行类型和 JSX**

`LiveChatModelRow` 只留 `id` / `name`。渲染改成单行只读：

```tsx
<div key={model.id} className="models-settings-row models-settings-live-row" data-readonly="true">
  <ProviderIcon id="grok" size={16} />
  <span className="models-settings-row-label">{model.name}</span>
</div>
```

保留分组标题 `models.liveChat` 和说明 `models.liveChatHint`。

- [ ] **Step 2: ModelsConfig 不再计算 efforts**

```ts
const [liveModels, setLiveModels] = useState<Array<{ id: string; name: string }>>([]);
```

```ts
setLiveModels(grokLiveChatModels(data.modelList).map((model) => ({
  id: model.id,
  name: composerModelLabel(model.id, model.name),
})));
```

删掉 `visibleGrokEffortLevels` 的 import。保留 `composerModelLabel`。

- [ ] **Step 3: 单行只读样式，删除两行 Effort CSS**

保留：

```css
.models-settings-row[data-readonly="true"] {
  cursor: default;
}

.models-settings-row[data-readonly="true"]:hover {
  background: transparent;
}

.models-settings-live-row > :first-child {
  flex: 0 0 auto;
}
```

删除 `.models-settings-live-copy`、`.models-settings-live-effort`，以及把 live 行撑成两行的 `min-height` / 额外 padding。

- [ ] **Step 4: 删除 i18n 键 `models.liveEffort`**

同时从 `lib/i18n/messages/en.ts` 和 `lib/i18n/messages/zh-CN.ts` 删除。

- [ ] **Step 5: 跑测试确认通过**

Run:

```bash
node --experimental-strip-types --test --test-concurrency=1 components/ModelsConfig.test.mjs components/models-config/*.test.mjs lib/i18n/messages/*.test.mjs
```

Expected: 全部通过。

- [ ] **Step 6: 提交（仅在用户要求时）**

```bash
git add components/models-config/ModelsConfigNavigator.tsx components/models-config/ModelsConfigNavigator.test.mjs components/ModelsConfig.tsx components/ModelsConfig.test.mjs app/globals.css lib/i18n/messages/en.ts lib/i18n/messages/zh-CN.ts docs/superpowers/specs/2026-08-22-models-hide-live-effort-design.md docs/superpowers/plans/2026-08-22-models-hide-live-effort.md
git commit -m "$(cat <<'EOF'
fix: hide read-only Grok effort on the models settings list

EOF
)"
```

默认不提交。用户明确要求后再执行。

---

### Task 3: 核对规格覆盖

- 行上只有图标和名称：Task 2 Step 1。
- 对话 Effort 不动：本计划不改 `ChatInput` / `lib/acp/runtime.ts`。
- 整组不删：Task 2 Step 1 保留 `liveChat` / `liveChatHint`。
- 无 `models.liveEffort`：Task 1 + Task 2 Step 4。
