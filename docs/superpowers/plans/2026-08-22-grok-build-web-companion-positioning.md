# Grok Build Web Companion Positioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every prominent product description identify `grok-web` as the web companion for Grok Build while preserving all current Grok ACP, session, and custom-provider behavior.

**Architecture:** This is a copy-and-metadata change over the existing TanStack application. Keep runtime and provider code untouched; enforce the positioning through focused metadata/i18n tests, then update bilingual documentation and remove two confirmed dead-code remnants.

**Tech Stack:** TypeScript, React 19, TanStack Start, Node test runner, JSON/PWA metadata, bilingual locale catalogs.

**Design:** `docs/superpowers/specs/2026-08-22-grok-build-web-companion-positioning-design.md`

---

## File Map

**Product documentation**

- Modify `README.md`: lead with the approved English positioning and shared Grok Build home.
- Modify `README.zh-CN.md`: mirror the approved Chinese positioning.
- Modify `PRODUCT.md`: make Grok Build exclusivity, custom-provider ownership, and product limits explicit; split the current run-on capability statement.

**Metadata**

- Modify `package.json`: use the approved package description.
- Modify `public/manifest.webmanifest`: replace the generic coding-agent description.
- Modify `src/routes/__root.tsx`: use the approved description in document metadata.
- Modify `lib/tanstack-root.test.mjs`: lock package, PWA, and document metadata to the same positioning.

**Application copy**

- Modify `lib/i18n/messages/en.ts`: describe Models as Grok Build configuration and remove four dead keys.
- Modify `lib/i18n/messages/zh-CN.ts`: apply the equivalent Chinese copy and remove the same keys.
- Create `lib/i18n/messages/product-positioning.test.mjs`: enforce the bilingual model/provider ownership language and dead-key removal.

**Confirmed cleanup**

- Modify `app/globals.css`: remove orphaned `.codex-worktree-create` selectors.
- Modify `components/CodexSidebar.test.mjs`: assert the removed UI leaves no matching CSS.

No runtime, ACP, session, authentication, provider-discovery, or model persistence file should change.

---

### Task 1: Align Package, PWA, And Document Metadata

**Files:**
- Modify: `lib/tanstack-root.test.mjs`
- Modify: `package.json`
- Modify: `public/manifest.webmanifest`
- Modify: `src/routes/__root.tsx`

- [ ] **Step 1: Add the failing metadata assertions**

In `lib/tanstack-root.test.mjs`, add a shared expected description after the manifest load:

```js
const companionDescription = "The web companion for Grok Build";
```

Add this test before the manifest deep-equality test:

```js
test("package and document metadata position Grok Web as the Grok Build companion", () => {
  assert.equal(pkg.description, companionDescription);
  assert.match(
    root,
    new RegExp(`name: "description",[\\s\\S]*?content: "${companionDescription}"`),
  );
});
```

In the existing manifest deep-equality expectation, rename the test to:

```js
test("the static PWA manifest keeps Grok Web app metadata", () => {
```

and replace the old description with:

```js
    description: companionDescription,
```

- [ ] **Step 2: Run the test and verify the old metadata fails**

Run:

```bash
node --experimental-strip-types --test lib/tanstack-root.test.mjs
```

Expected: FAIL because `package.json`, `public/manifest.webmanifest`, and `src/routes/__root.tsx` still contain the old workspace/generic descriptions.

- [ ] **Step 3: Apply the minimal metadata changes**

In `package.json`, set:

```json
  "description": "The web companion for Grok Build",
```

In `public/manifest.webmanifest`, set:

```json
  "description": "The web companion for Grok Build",
```

In `src/routes/__root.tsx`, replace the generic description meta with:

```tsx
      {
        name: "description",
        content: "The web companion for Grok Build",
      },
```

Do not change the product name, application name, title, icons, start URL, or PWA colors.

- [ ] **Step 4: Run the focused metadata test**

Run:

```bash
node --experimental-strip-types --test lib/tanstack-root.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit the metadata contract**

```bash
git add package.json public/manifest.webmanifest src/routes/__root.tsx lib/tanstack-root.test.mjs
git commit -m "docs: position Grok Web as the Grok Build companion"
```

---

### Task 2: Make Models Copy Belong To Grok Build

**Files:**
- Create: `lib/i18n/messages/product-positioning.test.mjs`
- Modify: `lib/i18n/messages/en.ts`
- Modify: `lib/i18n/messages/zh-CN.ts`

- [ ] **Step 1: Add a failing bilingual positioning test**

Create `lib/i18n/messages/product-positioning.test.mjs` with:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { enLocale } = await jiti.import("./en.ts");
const { zhCNLocale } = await jiti.import("./zh-CN.ts");

const deadKeys = [
  "sidebar.exportSession",
  "sidebar.renameCommand",
  "sidebar.deleteCommand",
  "chat.commandName",
];

test("Models copy describes Grok Build accounts, ACP models, and provider configuration", () => {
  assert.equal(
    enLocale.messages["models.pageSubtitle"],
    "Grok Build account, ACP models, and provider configuration",
  );
  assert.equal(
    enLocale.messages["models.customProvidersHint"],
    "Import and test providers stored in Grok Build's models.json. Live chat models still come from Grok ACP.",
  );
  assert.equal(
    zhCNLocale.messages["models.pageSubtitle"],
    "Grok Build 账号、ACP 模型和 Provider 配置",
  );
  assert.equal(
    zhCNLocale.messages["models.customProvidersHint"],
    "导入并测试 Grok Build models.json 中的 Provider；当前对话的模型仍来自 Grok ACP。",
  );
});

test("removed session controls leave no dead locale keys", () => {
  for (const key of deadKeys) {
    assert.equal(key in enLocale.messages, false, `English still contains ${key}`);
    assert.equal(key in zhCNLocale.messages, false, `zh-CN still contains ${key}`);
  }
});
```

- [ ] **Step 2: Run the new test and verify it fails**

Run:

```bash
node --experimental-strip-types --test lib/i18n/messages/product-positioning.test.mjs
```

Expected: FAIL on the old Models copy and the four still-present dead keys.

- [ ] **Step 3: Update the English and Chinese Models copy**

In `lib/i18n/messages/en.ts`, set:

```ts
    "models.pageSubtitle": "Grok Build account, ACP models, and provider configuration",
    "models.customProvidersHint": "Import and test providers stored in Grok Build's models.json. Live chat models still come from Grok ACP.",
```

In `lib/i18n/messages/zh-CN.ts`, set:

```ts
    "models.pageSubtitle": "Grok Build 账号、ACP 模型和 Provider 配置",
    "models.customProvidersHint": "导入并测试 Grok Build models.json 中的 Provider；当前对话的模型仍来自 Grok ACP。",
```

Keep all provider controls, API labels, discovery copy, and `models.liveChatHint` unchanged.

- [ ] **Step 4: Remove the dead locale keys from both catalogs**

Delete these entries from both `lib/i18n/messages/en.ts` and `lib/i18n/messages/zh-CN.ts`:

```ts
    "sidebar.exportSession": "...",
    "sidebar.renameCommand": "...",
    "sidebar.deleteCommand": "...",
    "chat.commandName": "...",
```

Do not remove the working `/name` handler alias from `hooks/useAgentSession.ts`; only its unreachable palette-description key is dead.

- [ ] **Step 5: Run the positioning and locale-parity tests**

Run:

```bash
node --experimental-strip-types --test \
  lib/i18n/messages/product-positioning.test.mjs \
  lib/i18n/messages/parity.test.mjs
```

Expected: both tests PASS, proving English/Chinese parity and the exact ownership language.

- [ ] **Step 6: Commit the bilingual product copy**

```bash
git add lib/i18n/messages/en.ts lib/i18n/messages/zh-CN.ts lib/i18n/messages/product-positioning.test.mjs
git commit -m "docs: frame model settings as Grok Build configuration"
```

---

### Task 3: Remove Orphaned Worktree-Create CSS

**Files:**
- Modify: `components/CodexSidebar.test.mjs`
- Modify: `app/globals.css`

- [ ] **Step 1: Add a failing CSS cleanup assertion**

In the existing `sidebar recomposition preserves worktree switching` test in `components/CodexSidebar.test.mjs`, add:

```js
  assert.doesNotMatch(styles, /\.codex-worktree-create\b/);
```

Keep the existing source assertion:

```js
  assert.doesNotMatch(sidebar, /codex-worktree-create/);
```

- [ ] **Step 2: Run the sidebar test and verify the stale CSS fails it**

Run:

```bash
node --experimental-strip-types --test components/CodexSidebar.test.mjs
```

Expected: FAIL because `.codex-worktree-create` remains in `app/globals.css`.

- [ ] **Step 3: Delete only the orphaned selectors**

In the shared input selector near `app/globals.css:1087`, change:

```css
.codex-sidebar-search-wrap input,
.codex-project-rename,
.codex-session-main input,
.codex-worktree-create input {
```

to:

```css
.codex-sidebar-search-wrap input,
.codex-project-rename,
.codex-session-main input {
```

Delete the standalone rules:

```css
.codex-worktree-create { height: 28px; display: flex; align-items: center; padding-left: 7px; border: 1px solid var(--border); border-radius: 5px; background: var(--bg); }
.codex-worktree-create input { font-size: var(--text-meta); }
```

Do not rename any remaining `codex-*` classes; they are internal implementation details outside this positioning scope.

- [ ] **Step 4: Run the focused sidebar test**

Run:

```bash
node --experimental-strip-types --test components/CodexSidebar.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit the dead CSS removal**

```bash
git add app/globals.css components/CodexSidebar.test.mjs
git commit -m "chore: remove stale worktree create styles"
```

---

### Task 4: Rewrite The Bilingual Product Introduction

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `PRODUCT.md`

- [ ] **Step 1: Run a documentation contract check and verify the old positioning fails**

Run:

```bash
node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const readme = await readFile("README.md", "utf8");
const zh = await readFile("README.zh-CN.md", "utf8");
const product = await readFile("PRODUCT.md", "utf8");

assert.match(readme, /\*\*The web companion for \[Grok Build\]\(https:\/\/grok\.com\)\.\*\*/);
assert.match(zh, /\*\*Grok Build 的 Web 伴侣。\*\*/);
assert.match(product, /the web companion for Grok Build/i);
assert.match(product, /Grok Build provider configuration/);
NODE
```

Expected: FAIL because the approved primary positioning and provider-ownership statement are not yet present.

- [ ] **Step 2: Replace the English README introduction**

Replace the paragraphs between `# Grok Web` and the source link with:

```markdown
**The web companion for [Grok Build](https://grok.com).**

Continue the same Grok Build projects, sessions, tools, and settings in the browser. grok-web runs in front of one long-lived `grok agent` ACP process and uses your existing `~/.grok` home, so the TUI and web UI share the same work.

Built for local, single-operator use. This is an independent community project, not an xAI product or hosted Grok service.
```

Keep the source link, screenshot, requirements, architecture, troubleshooting, support, license, and pi-web attribution. Do not add a landing-page feature list.

- [ ] **Step 3: Replace the Chinese README introduction**

Replace the paragraphs between `# Grok Web` and the source link with:

```markdown
**Grok Build 的 Web 伴侣。**

在浏览器中继续同一批 Grok Build 项目、会话、工具和设置。grok-web 挂在一个长期运行的 `grok agent` ACP 进程前面，并直接使用现有的 `~/.grok` 主目录，因此 TUI 与网页共享同一份工作。

面向本机单人使用。这是独立的社区项目，不是 xAI 官方产品，也不是托管的 Grok 服务。
```

Keep the remaining Chinese README structure aligned with the English document.

- [ ] **Step 4: Tighten PRODUCT.md around the approved boundary**

Replace the `## Product Purpose` section with:

```markdown
## Product Purpose

grok-web is the web companion for Grok Build. It gives existing Grok Build users a browser workspace over the same projects, sessions, tools, settings, and `~/.grok` home they already use from the TUI.

It does not replace Grok Build, create a second agent runtime, or own a separate model backend. One long-lived `grok agent stdio` process remains the source of conversation behavior.

Success: a Grok Build user can move between TUI and browser without forking session state, and another user can clone and run the same local companion.
```

Replace the `## Positioning` section with:

```markdown
## Positioning

The web companion for Grok Build: local-first, single-operator, and wired through Grok ACP. Unlike a generic chat UI, grok-web shares Grok Build's on-disk sessions, authentication, tools, and configuration.

This is an independent community project. It is not a cloud Grok service, multi-tenant host, or replacement agent runtime.
```

Add this explicit rule to `## Capabilities and Constraints` next to the model/provider bullets:

```markdown
- Custom providers are Grok Build provider configuration stored through the existing models.json flow. grok-web keeps the complete import, edit, discovery, and connection-test UI; live chat models still come from Grok ACP.
```

Split the current long bullet beginning with `Chat, session index, files` into these bullets without changing behavior:

```markdown
- Core workspace: chat, project/session index, files, Git, worktrees, subagent tree, compact, feedback, recap, and prompt history.
- Grok configuration: login, ACP models, custom providers, skills, plugins, MCP, tool permissions, and remote password settings.
- Navigation: New task, Projects, Recent, then Worktrees for the selected project. Recent is a jump list over the same `~/.grok` sessions, not a second session store.
- Composer commands: `/rename`, `/delete`, `/export`, `/skills`, `/plugins`, and `/mcp`. Skills, plugins, and MCP open in the Grok tools panel.
```

Remove the now-duplicated old custom-provider bullet from the same section. Keep protocol, security, distribution, brand commitments, evidence, principles, and accessibility facts unchanged.

- [ ] **Step 5: Re-run the documentation contract check**

Run the exact command from Step 1 again.

Expected: PASS.

Also run:

```bash
rg -n "Local browser workspace for Grok Build|Local web interface for the Grok coding agent" \
  README.md README.zh-CN.md PRODUCT.md package.json public/manifest.webmanifest src/routes/__root.tsx
```

Expected: no matches.

- [ ] **Step 6: Commit the approved product narrative**

```bash
git add README.md README.zh-CN.md PRODUCT.md
git commit -m "docs: reposition grok-web as the Grok Build companion"
```

---

### Task 5: Run Regression And Scope Validation

**Files:**
- Verify all files changed in Tasks 1-4.
- Do not modify runtime/provider code unless a test exposes a real regression caused by these changes.

- [ ] **Step 1: Run the focused positioning and preservation tests**

Run:

```bash
node --experimental-strip-types --test \
  lib/tanstack-root.test.mjs \
  lib/i18n/messages/product-positioning.test.mjs \
  lib/i18n/messages/parity.test.mjs \
  components/CodexSidebar.test.mjs \
  components/models-config/ModelsConfigNavigator.test.mjs \
  components/models-config/models-config-navigation.test.mjs \
  lib/model-connection-test.test.mjs \
  lib/model-discovery.test.mjs
```

Expected: PASS. The model/provider tests confirm the positioning pass did not reduce custom-provider behavior.

- [ ] **Step 2: Run the full unit suite**

Run:

```bash
npm test
```

Expected: PASS with zero failed tests.

- [ ] **Step 3: Run static validation**

Run:

```bash
npm run lint
npm run typecheck
git diff --check
```

Expected: all commands exit 0 with no lint, type, or whitespace errors.

- [ ] **Step 4: Audit the final scope**

Run:

```bash
git diff --name-only HEAD~4..HEAD
```

Expected files only:

```text
PRODUCT.md
README.md
README.zh-CN.md
app/globals.css
components/CodexSidebar.test.mjs
lib/i18n/messages/en.ts
lib/i18n/messages/product-positioning.test.mjs
lib/i18n/messages/zh-CN.ts
lib/tanstack-root.test.mjs
package.json
public/manifest.webmanifest
src/routes/__root.tsx
```

No ACP, provider discovery, provider persistence, auth, session, or HTTP/SSE runtime file should appear.

- [ ] **Step 5: Confirm repository state**

Run:

```bash
git status --short
```

Expected: no output. Do not create a final empty commit.

---

## Review Notes

- The plan deliberately keeps internal `codex-*` names, pi-web migration keys, and pi-web attribution.
- The plan deliberately preserves complete custom-provider CRUD, import, discovery, and connection testing.
- No visual layout or empty-state component changes are planned, so Playwright screenshots are not required. If implementation changes a rendered layout beyond text replacement, add desktop and mobile screenshot checks before Task 5 is considered complete.
- Cleanup-review suggestions about delete-dialog extraction, tools-section constants, and `loadTools` state requests remain outside this plan.
