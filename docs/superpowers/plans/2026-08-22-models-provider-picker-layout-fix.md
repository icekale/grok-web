# 模型页布局与 Provider 入口修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复模型设置页中文分组标题的窄列显示，并恢复“添加 Provider”中的 Grok OAuth、xAI API Key、自定义 Provider 三种现有入口。

**Architecture:** 只修改模型设置页的展示层。CSS 为分组标题按钮增加专用覆盖，不影响普通 Provider 折叠按钮；Provider Picker 继续复用现有 `/api/auth/providers`、`/api/auth/all-providers` 和既有选择回调，只移除已连接/已配置项的隐藏过滤。

**Tech Stack:** React + TypeScript, CSS, Node.js built-in test runner, Playwright browser smoke check.

---

### Task 1: 为回归行为写失败测试

**Files:**
- Modify: `components/models-config/ModelsConfigNavigator.test.mjs`
- Modify: `components/ModelsConfig.test.mjs`

- [ ] **Step 1: 保留分组标题布局断言**

在 `components/models-config/ModelsConfigNavigator.test.mjs` 保留现有断言，确保 `.models-settings-group-label.models-settings-disclosure` 具有 `width: 100%` 和 `justify-content: flex-start`。

- [ ] **Step 2: 增加 Provider Picker 的失败断言**

在 `components/ModelsConfig.test.mjs` 增加一个源码断言，验证 Picker 的过滤逻辑不再按认证状态隐藏入口：

```js
test("Provider picker keeps connected OAuth, configured API key, and custom entries", () => {
  assert.doesNotMatch(source, /oauthProviders\.filter\(\(p\) => !p\.loggedIn/);
  assert.doesNotMatch(source, /apiKeyProviders\.filter\(\(p\) => !p\.configured/);
  assert.match(source, /onSelectOAuth\(p\.id\)/);
  assert.match(source, /onSelectApiKey\(p\.id\)/);
  assert.match(source, /onAddCustom\(\)/);
});
```

- [ ] **Step 3: 运行模型相关测试并确认先失败**

Run:

```bash
node --experimental-strip-types --test --test-concurrency=1 components/ModelsConfig.test.mjs components/models-config/*.test.mjs
```

Expected: 新增 Picker 断言失败，原因是当前代码仍包含 `!p.loggedIn` 与 `!p.configured` 过滤；其余既有模型测试通过。

---

### Task 2: 实现最小修复

**Files:**
- Modify: `app/globals.css:3362`
- Modify: `components/ModelsConfig.tsx:1680-1687`

- [ ] **Step 1: 保持分组标题专用 CSS 覆盖**

确保 `app/globals.css` 在普通 `.models-settings-disclosure` 规则后包含：

```css
.models-settings-group-label.models-settings-disclosure {
  width: 100%;
  min-height: 30px;
  justify-content: flex-start;
  gap: 5px;
  padding: 6px 8px 4px;
}
```

这只覆盖同时拥有两个 class 的“自定义供应商”分组按钮，不改变 Provider 行的 24px 折叠按钮。

- [ ] **Step 2: 保留所有已加载的 OAuth 与 API Key 入口**

在 `components/ModelsConfig.tsx` 的 `AddProviderPicker` 中，将过滤逻辑改为仅按搜索词过滤：

```tsx
const availableOAuth = oauthProviders.filter((p) => !q || p.name.toLowerCase().includes(q));
const availableApiKey = apiKeyProviders.filter((p) =>
  !q || p.displayName.toLowerCase().includes(q) || p.id.toLowerCase().includes(q),
);
```

不要修改 `onSelectOAuth`、`onSelectApiKey`、`onAddCustom` 回调，也不要新增认证 API；当前后端提供的三项即为 Grok OAuth、xAI API Key、自定义 Provider。

- [ ] **Step 3: 运行模型相关测试确认通过**

Run:

```bash
node --experimental-strip-types --test --test-concurrency=1 components/ModelsConfig.test.mjs components/models-config/*.test.mjs
```

Expected: 所有模型相关测试通过，包含 Picker 入口回归测试。

- [ ] **Step 4: 提交实现**

```bash
git add app/globals.css components/ModelsConfig.tsx components/ModelsConfig.test.mjs components/models-config/ModelsConfigNavigator.test.mjs
git commit -m "fix: restore model provider picker entries"
```

---

### Task 3: 构建并验证实际页面

**Files:**
- No additional source files.

- [ ] **Step 1: 构建本地 standalone 输出**

```bash
rm -rf /tmp/grok-web-local-build
GROK_WEB_TANSTACK_OUTPUT_DIR=/tmp/grok-web-local-build npm run build:tanstack:standalone
```

Expected: 构建成功，并生成 `/tmp/grok-web-local-build/server/index.mjs`。

- [ ] **Step 2: 重启本地服务**

停止占用 `30142` 的旧 `grok-web` standalone server，然后启动：

```bash
GROK_WEB_TANSTACK_OUTPUT_DIR=/tmp/grok-web-local-build \
NITRO_HOST=127.0.0.1 NITRO_PORT=30142 \
node scripts/start-tanstack-output.mjs
```

Expected: `http://127.0.0.1:30142/` 返回成功。

- [ ] **Step 3: 用浏览器检查布局与三项入口**

使用 Playwright 打开 `/`，切换到“设置 → 模型”，确认：

```js
const group = page.locator('.models-settings-group-label.models-settings-disclosure');
await expect(group).toHaveCSS('width', /^(19|20|21|22|23|24)\\dpx$/);
await expect(group).toHaveText('自定义供应商');
await page.getByRole('button', { name: '添加 Provider' }).click();
await expect(page.locator('.models-picker')).toContainText('Grok');
await expect(page.locator('.models-picker')).toContainText('xAI API Key');
await expect(page.locator('.models-picker')).toContainText('OpenAI / Anthropic compatible');
```

- [ ] **Step 4: 运行最终检查**

```bash
git diff --check
git status --short --branch
curl -fsS http://127.0.0.1:30142/ >/dev/null
```

Expected: 无 diff 格式错误，本地服务可访问，工作区仅包含本次预期提交或干净。
