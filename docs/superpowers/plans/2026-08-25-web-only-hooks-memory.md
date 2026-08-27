# Web-only Hooks and Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Grok Build operator manage hooks and memory from grok-web so those jobs no longer require the TUI.

**Architecture:** Companion HTTP over Grok home files plus `grok inspect --json`. No undeclared `_x.ai` RPCs. User hook writes go to `~/.grok/hooks/*.json`. Folder-trust writes `~/.grok/trusted_folders.toml`. Memory enable pins `[memory] enabled` in `config.toml`. Mutating trust/hooks/enable recycles the existing ACP process.

**Tech Stack:** TypeScript, Node 22 test runner, existing TanStack API adapters, React settings tools pane.

**Spec:** `docs/superpowers/specs/2026-08-25-web-only-hooks-memory-design.md`

**Files:**
- Create: `lib/grok-inspect.ts`, `lib/grok-inspect.test.mjs`, `lib/hooks-http.ts`, `lib/hooks-http.test.mjs`, `lib/folder-trust.ts`, `lib/folder-trust.test.mjs`, `lib/memory-http.ts`, `lib/memory-http.test.mjs`, `src/routes/api/hooks.ts`, `src/routes/api/memory.ts`, `components/HooksConfig.tsx`, `components/HooksConfig.test.mjs`, `components/MemoryConfig.tsx`, `components/MemoryConfig.test.mjs`
- Modify: `src/api-methods.ts`, `lib/tanstack-route-inventory.test.mjs`, `scripts/tanstack-route-smoke.mjs`, `components/SettingsPage.tsx`, `hooks/useAgentSession.ts`, `components/ChatInput.tsx`, `lib/i18n/messages/en.ts`, `lib/i18n/messages/zh-CN.ts`, `lib/api-types.ts`

Do not: rewind UI, imagine, dream (unless ACP lists it), hook JSON editor, grok-web `project-trust.json` as folder-trust.

---

### Task 1: Parse `grok inspect --json` hooks

**Files:**
- Create: `lib/grok-inspect.ts`, `lib/grok-inspect.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { parseGrokInspect } from "./grok-inspect.ts";

test("parseGrokInspect reads hooks, projectTrusted, and projectRoot", () => {
  const parsed = parseGrokInspect({
    projectTrusted: true,
    projectRoot: "/repo",
    hooks: [{
      event: "(plugin)",
      hookType: "file",
      target: "/plugins/oh-my-grok/hooks/hooks.json",
      matcher: null,
      source: { type: "plugin", plugin_name: "oh-my-grok", path: "/plugins/oh-my-grok" },
    }],
  });
  assert.equal(parsed.projectTrusted, true);
  assert.equal(parsed.projectRoot, "/repo");
  assert.equal(parsed.hooks[0].sourceType, "plugin");
  assert.equal(parsed.hooks[0].pluginName, "oh-my-grok");
  assert.equal(parsed.hooks[0].removable, false);
});

test("parseGrokInspect ignores malformed hook rows", () => {
  const parsed = parseGrokInspect({ hooks: [{ event: 1 }, null, "x"] });
  assert.deepEqual(parsed.hooks, []);
  assert.equal(parsed.projectTrusted, false);
});
```

- [ ] **Step 2: Run it RED**

```bash
node --experimental-strip-types --test --test-concurrency=1 lib/grok-inspect.test.mjs
```

Expected: FAIL because `lib/grok-inspect.ts` does not exist.

- [ ] **Step 3: Implement parse + inspect runner**

`parseGrokInspect` maps inspect JSON to `{ projectTrusted, projectRoot, folderTrustEnabled, hooks[] }` where each hook has `event`, `hookType`, `target`, `matcher`, `sourceType`, `pluginName`, `sourcePath`, `removable` (`sourceType === "global"` or target under grok home `hooks/`).

`runGrokInspect(cwd, deps?)` execs `resolveGrokBin()` with `["inspect", "--json"]`, `{ cwd, timeout: 10_000, env: { ...process.env, GROK_HOME: grokHome() } }`, parses stdout JSON. Missing binary throws the existing grok-missing error. Inject `execFile` in tests.

`removable` is true only when resolved `target` is a regular file under `join(grokHome(), "hooks")`.

- [ ] **Step 4: GREEN**

Same test command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/grok-inspect.ts lib/grok-inspect.test.mjs
git commit -m "feat: parse Grok inspect hooks"
```

---

### Task 2: Render user hook JSON and add/remove on disk

**Files:**
- Create: `lib/user-hooks.ts`, `lib/user-hooks.test.mjs`

- [ ] **Step 1: Failing tests**

```js
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { addUserHook, removeUserHook, renderUserHookFile, HOOK_EVENTS } from "./user-hooks.ts";

test("renderUserHookFile writes Grok JSON for a command hook", () => {
  const text = renderUserHookFile({
    event: "SessionStart",
    type: "command",
    command: "echo hi",
  });
  assert.match(text, /"SessionStart"/);
  assert.match(text, /"command": "echo hi"/);
  assert.doesNotMatch(text, /timeout/);
});

test("addUserHook writes under GROK_HOME/hooks and removeUserHook deletes only that file", () => {
  const home = mkdtempSync(join(tmpdir(), "grok-hooks-home-"));
  const previous = process.env.GROK_HOME;
  process.env.GROK_HOME = home;
  try {
    const added = addUserHook({ event: "PreToolUse", type: "command", command: "true", matcher: "Bash" });
    assert.equal(added.startsWith(join(home, "hooks") + "/"), true);
    const body = JSON.parse(readFileSync(added, "utf8"));
    assert.equal(body.hooks.PreToolUse[0].matcher, "Bash");
    removeUserHook(added);
    assert.throws(() => readFileSync(added));
  } finally {
    if (previous === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = previous;
  }
});

test("removeUserHook refuses paths outside GROK_HOME/hooks", () => {
  const home = mkdtempSync(join(tmpdir(), "grok-hooks-home-"));
  process.env.GROK_HOME = home;
  const plugin = join(home, "installed-plugins", "x", "hooks.json");
  mkdirSync(join(home, "installed-plugins", "x"), { recursive: true });
  writeFileSync(plugin, "{}");
  assert.throws(() => removeUserHook(plugin), /refused|outside/i);
});
```

- [ ] **Step 2: RED then implement**

`HOOK_EVENTS` is the spec list. Unknown event throws. `http` requires `https:` or loopback `http:`. `command` requires non-empty command. Timeout omitted unless a positive integer.

`addUserHook` creates `hooks/` with mkdir 0o700, writes via `writePrivateFileAtomicSync`, filename `web-<event>-<8 hex>.json`.

`removeUserHook` realpath-resolves, requires prefix `realpath(join(grokHome(), "hooks")) + sep`.

- [ ] **Step 3: GREEN and commit**

```bash
node --experimental-strip-types --test --test-concurrency=1 lib/user-hooks.test.mjs
git add lib/user-hooks.ts lib/user-hooks.test.mjs
git commit -m "feat: write user Grok hook files"
```

---

### Task 3: Folder-trust store

**Files:**
- Create: `lib/folder-trust.ts`, `lib/folder-trust.test.mjs`

- [ ] **Step 1: Characterization test against real `grok inspect`**

Use a temp dir **outside** this git repo, `GROK_HOME` isolated, `git init`, a `.grok/hooks` file. Assert inspect `projectTrusted === false`. Try writing `trusted_folders.toml` until inspect reports true. Lock the working format in `folder-trust.ts`. If no format works, try `grok --trust` / documented CLI; if still impossible, throw a typed error `folder_trust_unsupported` and the UI hides Trust (list/add still ship).

Minimum unit tests without grok binary:

```js
test("trustFolder refuses home and filesystem root", () => {
  assert.throws(() => encodeTrustedFolders(["/"]), /over-broad/i);
});
```

- [ ] **Step 2: Implement read/write**

`readFolderTrust(home)` / `writeFolderTrust(home, folders: string[])` using atomic 0o600 write. Untrust removes that canonical path only. Refuse home, `/`, non-absolute paths.

- [ ] **Step 3: GREEN and commit**

```bash
git add lib/folder-trust.ts lib/folder-trust.test.mjs
git commit -m "feat: read and write Grok folder-trust"
```

---

### Task 4: `/api/hooks` HTTP

**Files:**
- Create: `lib/hooks-http.ts`, `lib/hooks-http.test.mjs`, `src/routes/api/hooks.ts`
- Modify: `src/api-methods.ts`, `lib/tanstack-route-inventory.test.mjs`, `scripts/tanstack-route-smoke.mjs`

- [ ] **Step 1: Failing HTTP tests** following `lib/plugins-http.test.mjs`: allowlisted cwd, GET without cwd → 400, POST without JSON → 415, add writes a file (inject inspect + recycle stubs).

GET: allowlist cwd, `runGrokInspect(cwd)`, return `{ projectTrusted, projectRoot, folderTrustEnabled, hooks }`. Missing grok → 503.

POST actions: `add`, `remove`, `trust`, `untrust`, `reload`. After add/remove/trust/untrust/reload call `getAgentRuntime().recycleProcess()` unless a test injects `{ recycle: async () => {} }`.

- [ ] **Step 2: Adapter + inventory**

```ts
// src/routes/api/hooks.ts
import { createFileRoute } from "@tanstack/react-router";
import { GET, POST } from "@/lib/hooks-http";
export const Route = createFileRoute("/api/hooks")({
  server: { handlers: { GET: ({ request }) => GET(request), POST: ({ request }) => POST(request) } },
});
```

Add `"/api/hooks": ["GET", "POST"]` to `API_ROUTE_METHODS`. Add inventory entry. Smoke: GET 400 (no cwd), POST 400 invalid body. Bump `EXPECTED_ADAPTERS` count by 1 (and later +1 for memory).

- [ ] **Step 3: GREEN and commit**

```bash
git add lib/hooks-http.ts lib/hooks-http.test.mjs src/routes/api/hooks.ts src/api-methods.ts lib/tanstack-route-inventory.test.mjs scripts/tanstack-route-smoke.mjs
git commit -m "feat: add /api/hooks for Grok hook files"
```

---

### Task 5: Hooks settings UI + `/hooks`

**Files:**
- Create: `components/HooksConfig.tsx`, `components/HooksConfig.test.mjs`
- Modify: `components/SettingsPage.tsx`, `hooks/useAgentSession.ts`, `components/ChatInput.tsx`, `lib/i18n/messages/en.ts`, `lib/i18n/messages/zh-CN.ts`

- [ ] **Step 1: Source contracts RED**

```js
test("tools settings include Hooks and /hooks opens it", async () => {
  const settings = await readFile(new URL("./SettingsPage.tsx", import.meta.url), "utf8");
  const input = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  const session = await readFile(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");
  assert.match(settings, /"hooks"/);
  assert.match(input, /name: "hooks"/);
  assert.match(session, /onOpenSettings\?\.\("hooks"\)/);
});
```

- [ ] **Step 2: Implement**

`SettingsSection` adds `"hooks"`. `TOOL_NAV_SECTIONS` = skills, plugins, hooks, mcp. `HooksConfig` fetches GET, grouped list, Trust/Untrust, Add dialog, Remove on `removable`, Reload. i18n keys `hooks.*` in both catalogs.

Builtin slash `hooks` → `onOpenSettings("hooks")` like skills.

- [ ] **Step 3: GREEN, i18n parity, commit**

```bash
node --experimental-strip-types --test --test-concurrency=1 components/HooksConfig.test.mjs lib/i18n/messages/parity.test.mjs
git add components/HooksConfig.tsx components/HooksConfig.test.mjs components/SettingsPage.tsx hooks/useAgentSession.ts components/ChatInput.tsx lib/i18n/messages/en.ts lib/i18n/messages/zh-CN.ts
git commit -m "feat: open Grok hooks from Settings and /hooks"
```

---

### Task 6: Memory files + enable pin

**Files:**
- Create: `lib/memory-store.ts`, `lib/memory-store.test.mjs`

- [ ] **Step 1: Tests for enable pin, workspace slug, remember append, session-only delete**

`readMemoryEnabled(configText)` true iff `[memory]` `enabled = true`. `pinMemoryEnabled(text, enabled)` sets `[memory]\nenabled = true|false` without clobbering other tables (same style as `pinDefaultReasoningEffort`).

`workspaceMemoryDir(cwd, home)`: git `origin` `org/repo` slug + 8-char hash as Grok documents; fallback path slug. Test with a fake origin.

`appendRememberNote(file, text, now)` appends `\n## Note\n\n- YYYY-MM-DD: text\n`. `assertSessionLogPath(path)` allows delete only under `.../sessions/`.

- [ ] **Step 2: Implement GREEN commit**

```bash
git add lib/memory-store.ts lib/memory-store.test.mjs
git commit -m "feat: pin Grok memory files and remember notes"
```

---

### Task 7: `/api/memory` + UI + slashes

**Files:**
- Create: `lib/memory-http.ts`, `lib/memory-http.test.mjs`, `src/routes/api/memory.ts`, `components/MemoryConfig.tsx`, `components/MemoryConfig.test.mjs`
- Modify: route inventory, smoke, api-methods, SettingsPage, ChatInput, useAgentSession, i18n

GET returns `{ enabled, envOverrides, files: [{ scope, path, name, mtime }] , preview? }`. POST `enable`/`disable` writes config + recycle. POST `remember` appends. POST `delete` session logs only.

`/memory` opens settings section. `/remember [text]` returns `{ handled, action: "remember", text }` and ChatInput opens a confirm dialog then POST.

`/flush` only if we already list ACP commands named `flush` in get_commands — otherwise omit. Default omit.

- [ ] Commit

```bash
git commit -m "feat: manage Grok memory from Settings and /remember"
```

---

### Task 8: Verify

```bash
node --experimental-strip-types --test --test-concurrency=1 lib/grok-inspect.test.mjs lib/user-hooks.test.mjs lib/folder-trust.test.mjs lib/hooks-http.test.mjs lib/memory-store.test.mjs lib/memory-http.test.mjs components/HooksConfig.test.mjs components/MemoryConfig.test.mjs lib/i18n/messages/parity.test.mjs lib/tanstack-route-inventory.test.mjs
npm test
```

Expected: 0 fail. Manual: `/hooks` lists inspect hooks; add SessionStart echo; file exists under `~/.grok/hooks`. Enable memory; remember a note; see it in MEMORY.md.
