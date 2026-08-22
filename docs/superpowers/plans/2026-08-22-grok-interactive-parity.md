# Grok Interactive Capability Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a safe global Grok Runtime Profile, capability-driven standard modes/Plan, and restore-code into a new ACP-owned worktree.

**Architecture:** Persist one versioned non-secret profile under `~/.grok/grok-web`, discover support through shell-free CLI help/inspect plus ACP state, and build layered argv deterministically. Applying a profile is a serialized idle-only process transaction with disk/process rollback. Restore-code has a dedicated authorized route and uses only the existing allowlisted worktree/fork RPCs after read-only preflight.

**Tech Stack:** TypeScript, React, TanStack Start, Node child processes/filesystem, Grok CLI/ACP, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-22-grok-interactive-parity-design.md`

**Dependencies:** Stages A-C are integrated, deterministic ACP E2E runs in CI, and an opt-in real Grok E2E command exists.

---

### Task 1: Add the Runtime Profile schema and atomic store

**Files:**
- Create: `lib/runtime-profile.ts`
- Create: `lib/runtime-profile.test.mjs`
- Reuse: `lib/atomic-file.ts`
- Reuse: `lib/grok-home.ts`
- Reuse: `lib/file-access.ts`

- [ ] **Step 1: Write failing defaults and validation tests**

```js
assert.deepEqual(readRuntimeProfile(home), {
  version: 1,
  agent: null,
  agentProfilePath: null,
  sandbox: null,
  permissionMode: "default",
  allow: [],
  deny: [],
  disableWebSearch: false,
  disableSubagents: false,
  maxTurns: null,
  rules: null,
});
```

Add tests that reject:

- unsupported version;
- unknown request fields and `apiKey`, `password`, `token`, `env`;
- simultaneous `agent` and `agentProfilePath`;
- duplicate or identical allow/deny rules;
- empty/overlong rules and out-of-range max turns;
- relative, missing, directory, symlink-escape, and untrusted profile paths.

Test mode `0600`, `runtime-profile.json` location, and old complete file preservation using the existing atomic-file failure test seam.

- [ ] **Step 2: Verify RED**

```bash
node --experimental-strip-types --test --test-concurrency=1 lib/runtime-profile.test.mjs
```

- [ ] **Step 3: Implement one strict versioned profile**

```ts
export type RuntimeProfile = {
  version: 1;
  agent: string | null;
  agentProfilePath: string | null;
  sandbox: string | null;
  permissionMode: "default" | "acceptEdits" | "auto" | "dontAsk" | "bypassPermissions" | "plan";
  allow: string[];
  deny: string[];
  disableWebSearch: boolean;
  disableSubagents: boolean;
  maxTurns: number | null;
  rules: string | null;
};
```

`runtimeProfilePath(home)` returns `join(grokWebMetaDir(), "runtime-profile.json")`. Read absence as defaults. Invalid on-disk version returns defaults plus an actionable warning for GET; invalid PUT fails `400` and does not write. Use `realpath`/`stat.isFile()` and existing allowed roots for profile paths.

- [ ] **Step 4: Run tests and commit**

```bash
node --experimental-strip-types --test --test-concurrency=1 lib/runtime-profile.test.mjs lib/atomic-file.test.mjs lib/file-access.test.mjs
git add lib/runtime-profile.ts lib/runtime-profile.test.mjs
git commit -m "feat: add a safe Grok runtime profile"
```

---

### Task 2: Discover CLI and Agent capabilities without a shell

**Files:**
- Create: `lib/grok-capabilities.ts`
- Create: `lib/grok-capabilities.test.mjs`
- Reuse: `lib/acp/process.ts`

- [ ] **Step 1: Add failing exact-token and inspect-shape tests**

Inject `execFile` and `stat` functions. Supply controlled outputs for:

```text
grok --help
  --sandbox <PROFILE>
  --permission-mode <MODE>
  --allow <RULE>
  --deny <RULE>
  --disable-web-search
  --no-subagents
  --max-turns <N>
  --rules <RULES>
  --restore-code
  --worktree [<WORKTREE>]

grok agent --help
  --agent-profile <PATH>

grok agent stdio --help
  --leader-socket <PATH>
```

Assert exact `--sandbox` is recognized but `--sandboxed` is not. Parse `grok inspect --json` and accept only agents with string name/description and a valid source object.

- [ ] **Step 2: Add cache invalidation tests**

Call twice with identical binary path/mtime/version and assert four subprocess invocations only once. Change mtime/version and assert refresh. Malformed help/JSON returns unavailable controls plus sanitized warnings, never guessed capabilities.

- [ ] **Step 3: Verify RED**

```bash
node --experimental-strip-types --test --test-concurrency=1 lib/grok-capabilities.test.mjs
```

- [ ] **Step 4: Implement structured execFile discovery**

```ts
export type GrokCapabilities = {
  version: string;
  globalFlags: Set<string>;
  agentFlags: Set<string>;
  stdioFlags: Set<string>;
  agents: Array<{ name: string; description?: string; source?: unknown }>;
  warnings: string[];
};
```

Run exact argv arrays with bounded output/timeouts and no shell. Cache by resolved binary realpath, stat mtime/size, and parsed `--version`. Do not retain raw stderr that may contain private paths.

- [ ] **Step 5: Run and commit**

```bash
node --experimental-strip-types --test --test-concurrency=1 lib/grok-capabilities.test.mjs lib/acp/process.test.mjs
git add lib/grok-capabilities.ts lib/grok-capabilities.test.mjs
git commit -m "feat: detect Grok runtime capabilities"
```

---

### Task 3: Build layered Grok Agent argv from validated capabilities

**Files:**
- Modify: `lib/acp/process.ts`
- Modify: `lib/acp/process.test.mjs`
- Modify: `lib/acp/runtime.ts:897-912`

- [ ] **Step 1: Add failing argv-order and injection tests**

```js
assert.deepEqual(grokAgentArgs(profile, capabilities), [
  "--sandbox", "workspace",
  "--permission-mode", "acceptEdits",
  "--allow", "Bash(git status:*)",
  "--deny", "Bash(rm -rf:*)",
  "--disable-web-search",
  "--no-subagents",
  "--max-turns", "40",
  "--rules", "Keep scope; $(not a shell)",
  "agent",
  "--agent-profile", "/trusted/profile.json",
  "stdio",
]);
```

Assert metacharacters/whitespace remain one array value, defaults are omitted, unsupported flags fail before spawn, and `agent`/`agentProfilePath` conflict fails.

- [ ] **Step 2: Verify RED**

```bash
node --experimental-strip-types --test --test-concurrency=1 lib/acp/process.test.mjs
```

- [ ] **Step 3: Implement a pure layered builder**

Append global flags, then `agent`, then Agent flags, then `stdio`, then stdio flags. Every value is a separate argv entry. Do not concatenate a command string or add `shell: true`.

The discovered Agent-name option uses top-level `--agent <name>` before the `agent` command. `agentProfilePath` uses `--agent-profile <path>` after `agent` only when advertised.

- [ ] **Step 4: Pass profile/capabilities into child spawn**

`connectDefault()` reads the active profile/capability snapshot and calls `grokAgentArgs(profile, capabilities)` while preserving the stage A sanitized environment.

- [ ] **Step 5: Run and commit**

```bash
node --experimental-strip-types --test --test-concurrency=1 lib/acp/process.test.mjs lib/acp/runtime.test.mjs
git add lib/acp/process.ts lib/acp/process.test.mjs lib/acp/runtime.ts lib/acp/runtime.test.mjs
git commit -m "feat: launch Grok with the runtime profile"
```

---

### Task 4: Apply profiles as a serialized idle-only runtime transaction

**Files:**
- Modify: `lib/acp/runtime.ts:180-190,517-550,854-940`
- Modify: `lib/acp/runtime.test.mjs`
- Modify: `lib/runtime-profile.ts`

- [ ] **Step 1: Add failing transaction tests**

Using injected connection/start/profile writers, cover:

- busy prompt rejects before write/stop;
- busy terminal rejects before write/stop;
- successful candidate reloads captured idle session IDs/cwds;
- candidate initialize failure restores old profile then old argv/process;
- rollback startup failure returns degraded status with sanitized candidate/rollback errors;
- two simultaneous apply calls serialize and a stale candidate cannot publish after a newer generation.

Example:

```js
await assert.rejects(
  runtime.applyRuntimeProfile(next, store),
  (error) => error.status === 409 && error.code === "runtime_busy",
);
assert.deepEqual(events, []);
```

- [ ] **Step 2: Verify RED**

```bash
node --experimental-strip-types --test --test-concurrency=1 lib/acp/runtime.test.mjs lib/runtime-profile.test.mjs
```

- [ ] **Step 3: Add a dedicated transaction instead of changing generic recycle**

```ts
async applyRuntimeProfile(next: RuntimeProfile, store: RuntimeProfileStore): Promise<RuntimeApplyResult> {
  return this.serializeProfileApply(async () => {
    if (this.listBusyIds().length > 0) throw new AgentCommandError(409, "runtime_busy", "Grok is busy");
    const previous = store.read();
    const recoverable = this.loadedSessionLocations();
    store.write(next);
    try {
      await this.replaceProcess(next);
      await this.reloadLocations(recoverable);
      return { status: "applied", profile: next };
    } catch (candidateError) {
      store.write(previous.profile);
      try {
        await this.replaceProcess(previous.profile);
        await this.reloadLocations(recoverable);
      } catch (rollbackError) {
        return { status: "degraded", error: sanitize(candidateError), rollbackError: sanitize(rollbackError) };
      }
      throw new AgentCommandError(503, "runtime_start_failed", sanitize(candidateError));
    }
  });
}
```

The real implementation must dispose old child/connection once, publish candidate only after initialize, and retain generation guards.

- [ ] **Step 4: Preserve the existing model recycle behavior**

Do not silently route model changes through the profile transaction unless required. Add regression tests for current `recycleProcess()` model refresh and connection-close recovery.

- [ ] **Step 5: Run and commit**

```bash
node --experimental-strip-types --test --test-concurrency=1 lib/acp/runtime.test.mjs lib/acp/process.test.mjs lib/runtime-profile.test.mjs
git add lib/acp/runtime.ts lib/acp/runtime.test.mjs lib/runtime-profile.ts
git commit -m "feat: transactionally restart the Grok runtime"
```

---

### Task 5: Add the Runtime Profile HTTP contract

**Files:**
- Create: `lib/runtime-profile-http.ts`
- Create: `lib/runtime-profile-http.test.mjs`
- Create: `src/routes/api/runtime-profile.ts`
- Modify: `src/api-methods.ts`
- Modify: `lib/tanstack-route-inventory.test.mjs`
- Modify: `scripts/tanstack-route-smoke.mjs`
- Modify: `lib/settings-http.ts`
- Modify: `lib/settings-http.test.mjs`

- [ ] **Step 1: Add failing GET/PUT tests**

GET returns profile, capabilities, agents, version, warning/degraded state, and `restartRequired: false`. PUT requires JSON and maps:

- invalid profile -> `400`;
- untrusted profile path -> `403`;
- busy -> `409 runtime_busy` with no persisted change;
- candidate/rollback result -> `200 applied` or `503` with sanitized status.

Test two simultaneous PUTs serialize through runtime.

- [ ] **Step 2: Resolve the old permission-mode ownership**

Move the General-page permission control to Runtime Profile. Keep `/api/settings` GET compatibility, but make its permission value read from the active Runtime Profile. Make `/api/settings` PUT delegate to the same validated profile transaction rather than writing an independent conflicting source. Add regression tests proving both APIs converge on one value and one restart path.

- [ ] **Step 3: Verify RED**

```bash
node --experimental-strip-types --test --test-concurrency=1 lib/runtime-profile-http.test.mjs lib/settings-http.test.mjs lib/tanstack-route-inventory.test.mjs
```

- [ ] **Step 4: Implement thin route and safe smoke probes**

Add `/api/runtime-profile` GET/PUT to route inventory. Route smoke uses GET and invalid-body PUT only; it never restarts the operator runtime or writes configuration.

- [ ] **Step 5: Run and commit**

```bash
node --experimental-strip-types --test --test-concurrency=1 lib/runtime-profile-http.test.mjs lib/settings-http.test.mjs lib/tanstack-route-inventory.test.mjs src/api-methods.test.mjs
git add lib/runtime-profile-http.ts lib/runtime-profile-http.test.mjs src/routes/api/runtime-profile.ts src/api-methods.ts lib/tanstack-route-inventory.test.mjs scripts/tanstack-route-smoke.mjs lib/settings-http.ts lib/settings-http.test.mjs
git commit -m "feat: expose Grok runtime profile settings"
```

---

### Task 6: Add the Agent Runtime settings UI

**Files:**
- Create: `components/AgentRuntimeConfig.tsx`
- Create: `components/AgentRuntimeConfig.test.mjs`
- Modify: `components/SettingsPage.tsx:39-135,279-440`
- Modify: `components/SettingsPage.test.mjs`
- Modify: `components/resource-settings/resource-settings-types.ts` only if the existing controller needs a shared error field
- Modify: `lib/i18n/messages/en.ts`
- Modify: `lib/i18n/messages/zh-CN.ts`
- Modify: `lib/i18n/messages/parity.test.mjs`

- [ ] **Step 1: Add failing navigation and capability-render tests**

Assert Settings includes a `runtime` section, General no longer owns a second permission picker, and the new page:

- shows only advertised controls;
- labels unsupported controls/version warnings;
- filters Agents from validated inspect output;
- enforces mutual exclusion for Agent name/profile path;
- reports global scope and restart requirement;
- registers dirty/discard/back behavior.

- [ ] **Step 2: Add failing save/rollback UI tests**

Mock `409 runtime_busy`, `503 runtime_start_failed`, and degraded rollback. Assert draft remains, prior saved profile remains displayed, and errors are actionable. A successful apply normalizes from server response.

- [ ] **Step 3: Verify RED**

```bash
node --experimental-strip-types --test --test-concurrency=1 components/AgentRuntimeConfig.test.mjs components/SettingsPage.test.mjs lib/i18n/messages/parity.test.mjs
```

- [ ] **Step 4: Implement one controlled draft page**

Reuse the existing settings form classes and `SettingsSectionController`. Do not add a form library. Rules use simple repeatable text rows; profile path uses the existing trusted path/browser APIs, not an unrestricted browser-local path.

Saving opens a restart confirmation. Disable Apply while busy/saving. Never force-abort active work.

- [ ] **Step 5: Run and commit**

```bash
node --experimental-strip-types --test --test-concurrency=1 components/AgentRuntimeConfig.test.mjs components/SettingsPage.test.mjs lib/i18n/messages/parity.test.mjs
git add components/AgentRuntimeConfig.tsx components/AgentRuntimeConfig.test.mjs components/SettingsPage.tsx components/SettingsPage.test.mjs components/resource-settings/resource-settings-types.ts lib/i18n/messages/en.ts lib/i18n/messages/zh-CN.ts
git commit -m "feat: add Agent Runtime settings"
```

---

### Task 7: Expose only standard ACP-advertised modes and Plan

**Files:**
- Modify: `lib/acp/config-options.ts`
- Modify: `lib/acp/config-options.test.mjs`
- Modify: `lib/acp/runtime.ts:130-165,345-490,562-584,880-888`
- Modify: `lib/acp/runtime.test.mjs`
- Modify: `lib/agent-events.ts`
- Modify: `hooks/useAgentSession.ts`
- Modify: `hooks/useAgentSession.test.mjs`
- Modify: `components/ChatInput.tsx`
- Modify: `components/ChatInput.test.mjs`
- Modify: `components/ChatWindow.plan.test.mjs`

- [ ] **Step 1: Add failing standard-mode parser tests**

From session new/load/update payloads, parse only a standard mode/config option shape with string IDs/labels/current value. Test advertised `plan`, ordinary mode, malformed values, and no modes.

```js
assert.deepEqual(readAcpModes({ modes: {
  currentModeId: "default",
  availableModes: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }],
} }), {
  current: "default",
  available: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }],
});
```

- [ ] **Step 2: Add runtime/readback tests**

`get_state` exposes advertised modes/current mode. `set_mode` rejects an unadvertised ID before RPC, calls standard `session/set_mode`, and updates only from successful response/update. Reconnect snapshot restores current mode.

- [ ] **Step 3: Add UI tests and verify RED**

Plan/mode control appears only when `plan` is advertised. It changes state through the standard command and rolls back on failure. Existing custom `rpiv-todos` widgets do not make Plan appear.

```bash
node --experimental-strip-types --test --test-concurrency=1 lib/acp/config-options.test.mjs lib/acp/runtime.test.mjs hooks/useAgentSession.test.mjs components/ChatInput.test.mjs components/ChatWindow.plan.test.mjs
```

- [ ] **Step 4: Implement the standard path**

Add a small `readAcpModes`/`applyModeUpdate` beside config options. Store it per session, include it in stage B snapshot, and add a separate mode selector/toggle to ChatInput. Do not route generic extension widgets/forms into this control.

- [ ] **Step 5: Run and commit**

```bash
node --experimental-strip-types --test --test-concurrency=1 lib/acp/config-options.test.mjs lib/acp/runtime.test.mjs lib/agent-event-stream.test.mjs hooks/useAgentSession.test.mjs components/ChatInput.test.mjs components/ChatWindow.plan.test.mjs
git add lib/acp/config-options.ts lib/acp/config-options.test.mjs lib/acp/runtime.ts lib/acp/runtime.test.mjs lib/agent-events.ts hooks/useAgentSession.ts hooks/useAgentSession.test.mjs components/ChatInput.tsx components/ChatInput.test.mjs components/ChatWindow.plan.test.mjs
git commit -m "feat: expose standard Grok session modes"
```

---

### Task 8: Add restore-code preflight with zero mutation on unsupported state

**Files:**
- Create: `lib/restore-code-http.ts`
- Create: `lib/restore-code-http.test.mjs`
- Create: `src/routes/api/sessions/$id/restore-code.ts`
- Modify: `src/api-methods.ts`
- Modify: `lib/tanstack-route-inventory.test.mjs`
- Modify: `scripts/tanstack-route-smoke.mjs`
- Modify: `lib/acp/runtime.ts`
- Modify: `lib/acp/connection.ts`

- [ ] **Step 1: Add failing historical metadata/preflight tests**

Create session fixtures with `summary.json` containing `git_root_dir`, `head_commit`, and `head_branch`. Test:

- missing session -> `404`;
- non-Git/missing metadata -> `400`;
- unauthorized realpath -> `403`;
- absent CLI restore/worktree flags -> `501 unsupported`, zero RPC calls;
- `_x.ai/git/worktree/list` method-not-found/failure -> `501 unsupported`, zero create calls;
- existing target collision -> `409 worktree_conflict`.

- [ ] **Step 2: Verify RED**

```bash
node --experimental-strip-types --test --test-concurrency=1 lib/restore-code-http.test.mjs lib/acp/connection.test.mjs
```

- [ ] **Step 3: Implement preflight as a dependency-injected service**

```ts
type RestoreDeps = {
  findSession: typeof findGrokSession;
  readCapabilities: typeof readGrokCapabilities;
  listWorktrees: () => Promise<unknown>;
  createWorktree: (sessionId: string, sourcePath: string) => Promise<{ worktreePath?: string }>;
  forkIntoCwd: (sessionId: string, sourceCwd: string, newCwd: string) => Promise<{ newSessionId: string }>;
  removeWorktree: (path: string) => Promise<unknown>;
};
```

Read summary metadata directly for this operation rather than expanding every sidebar `SessionInfo`. Validate realpaths/allowed roots and run only the read-only worktree-list method before confirmation/mutation.

- [ ] **Step 4: Add route inventory and safe smoke**

Add `POST /api/sessions/$id/restore-code`. Route smoke uses a fake ID/invalid body and expects `404`/`400`; it never creates a worktree.

- [ ] **Step 5: Run and commit**

```bash
node --experimental-strip-types --test --test-concurrency=1 lib/restore-code-http.test.mjs lib/acp/connection.test.mjs lib/tanstack-route-inventory.test.mjs src/api-methods.test.mjs
git add lib/restore-code-http.ts lib/restore-code-http.test.mjs 'src/routes/api/sessions/$id/restore-code.ts' src/api-methods.ts lib/tanstack-route-inventory.test.mjs scripts/tanstack-route-smoke.mjs lib/acp/runtime.ts lib/acp/connection.ts
git commit -m "feat: preflight safe session code restore"
```

---

### Task 9: Create/fork restore worktrees with request-owned cleanup

**Files:**
- Modify: `lib/restore-code-http.ts`
- Modify: `lib/restore-code-http.test.mjs`
- Modify: `lib/acp/runtime.ts:816-838`
- Modify: `lib/acp/runtime.test.mjs`
- Reuse: `lib/acp/connection.ts:273-281,359-368`
- Reuse: `lib/file-access.ts`

- [ ] **Step 1: Add failing success and cleanup tests**

Assert exact order `list -> create -> fork`, returned worktree becomes an allowed root, fork uses returned cwd, and original cwd files remain unchanged.

Add failures:

- create `-32601` -> unsupported, no cleanup because no owned path;
- fork `-32601` after successful create -> remove exactly returned request-owned path;
- ambiguous create error with no confirmed path -> no broad cleanup;
- cleanup failure -> `500` with exact residual path under authorized project;
- returned path outside the expected project/worktree boundary -> reject and do not fork.

- [ ] **Step 2: Verify RED**

```bash
node --experimental-strip-types --test --test-concurrency=1 lib/restore-code-http.test.mjs lib/acp/runtime.test.mjs
```

- [ ] **Step 3: Add a narrow `forkSessionIntoCwd()`**

```ts
async forkSessionIntoCwd(sourceSessionId: string, sourceCwd: string, newCwd: string) {
  await this.ensureProcess();
  const result = await this.requireAcp().sessionFork({ sourceSessionId, sourceCwd, newCwd });
  const session = this.ensureSession(result.newSessionId);
  session.loaded = true;
  session.cwd = canonicalCwd(newCwd);
  return result;
}
```

Do not parse rewind snapshots or try alternate private method names.

- [ ] **Step 4: Implement request ownership**

Set `ownedWorktreePath` only after a successful create response and boundary validation. Cleanup may call only the existing allowlisted remove method for that exact path. The ACP-returned path is authoritative; an advisory branch/name is shown only if the detected backend explicitly supports naming, otherwise the UI must not promise a requested branch.

- [ ] **Step 5: Run and commit**

```bash
node --experimental-strip-types --test --test-concurrency=1 lib/restore-code-http.test.mjs lib/acp/runtime.test.mjs lib/acp/connection.test.mjs lib/worktrees-http.test.mjs
git add lib/restore-code-http.ts lib/restore-code-http.test.mjs lib/acp/runtime.ts lib/acp/runtime.test.mjs
git commit -m "feat: restore sessions into ACP-owned worktrees"
```

---

### Task 10: Add restore-code UI and authentication affordance

**Files:**
- Modify: `components/CodexSidebar.tsx:1090-1190`
- Modify: `components/CodexSidebar.test.mjs`
- Modify: `components/AppShell.tsx`
- Modify: `components/AppShell.session-info.test.mjs`
- Create: `components/RestoreCodeDialog.tsx`
- Create: `components/RestoreCodeDialog.test.mjs`
- Modify: `hooks/useAgentSession.ts`
- Modify: `hooks/useAgentSession.test.mjs`
- Modify: `lib/i18n/messages/en.ts`
- Modify: `lib/i18n/messages/zh-CN.ts`

- [ ] **Step 1: Add failing session-action and dialog tests**

The session row menu offers “Restore code in new worktree” only for eligible Git sessions/capability. Dialog explains the original cwd is untouched, shows capability errors, and requires confirmation. Success navigates AppShell to returned session/cwd. Residual cleanup path is displayed without pretending success.

- [ ] **Step 2: Add authentication-required tests**

When new/load/prompt returns `Authentication required`, show a dedicated notice/action that opens Models/Login settings. A visible custom Provider model must not suppress this action or mark Agent authentication successful.

- [ ] **Step 3: Verify RED**

```bash
node --experimental-strip-types --test --test-concurrency=1 components/CodexSidebar.test.mjs components/RestoreCodeDialog.test.mjs components/AppShell.session-info.test.mjs hooks/useAgentSession.test.mjs lib/i18n/messages/parity.test.mjs
```

- [ ] **Step 4: Implement minimal UI**

Reuse `DialogShell`, existing session row menu, and AppShell navigation handlers. Do not add a restore wizard framework. The action POSTs the session ID after confirmation; server remains authoritative for every path/capability check.

- [ ] **Step 5: Run and commit**

```bash
node --experimental-strip-types --test --test-concurrency=1 components/CodexSidebar.test.mjs components/RestoreCodeDialog.test.mjs components/AppShell.session-info.test.mjs hooks/useAgentSession.test.mjs lib/i18n/messages/parity.test.mjs
git add components/CodexSidebar.tsx components/CodexSidebar.test.mjs components/AppShell.tsx components/AppShell.session-info.test.mjs components/RestoreCodeDialog.tsx components/RestoreCodeDialog.test.mjs hooks/useAgentSession.ts hooks/useAgentSession.test.mjs lib/i18n/messages/en.ts lib/i18n/messages/zh-CN.ts
git commit -m "feat: add safe restore-code browser flow"
```

---

### Task 11: Extend deterministic and live ACP E2E for stage D

**Files:**
- Modify: `e2e/fixtures/acp-agent.mjs`
- Create: `e2e/runtime-profile.spec.ts`
- Create: `e2e/restore-code.spec.ts`
- Modify: `e2e/live.spec.ts`
- Modify: `e2e/helpers/harness.ts`

- [ ] **Step 1: Add deterministic profile apply/rollback scenarios**

Test capability-driven controls, successful idle restart/reload, busy `409`, candidate startup failure with old-profile rollback, and degraded rollback failure presentation. Fixture logs exact child argv layers without secret values.

- [ ] **Step 2: Add deterministic mode/restore scenarios**

Advertise/hide standard Plan, set/read back mode, create a fixture-owned worktree, fork into returned cwd, and verify original cwd checksum remains unchanged. Add unsupported list/create/fork and cleanup-failure scenarios.

- [ ] **Step 3: Extend live suite conditionally**

Against the dedicated authenticated home, read capabilities. Only when `GROK_WEB_LIVE_E2E_MUTATIONS=1` is also set, apply one reversible harmless profile setting and restore one test-owned session into a new worktree, verify navigation, then restore the old profile and remove the test-owned worktree/session. Without that additional flag, live tests remain read-only for profile/restore capabilities. Missing optional capability is recorded; core profile GET/capability discovery must pass.

- [ ] **Step 4: Run and commit**

```bash
npm run test:e2e:acp
GROK_WEB_LIVE_E2E=1 GROK_WEB_LIVE_E2E_HOME=/dedicated/home GROK_WEB_LIVE_E2E_GROK_BIN=/path/to/grok npm run test:e2e:live
git add e2e/fixtures/acp-agent.mjs e2e/runtime-profile.spec.ts e2e/restore-code.spec.ts e2e/live.spec.ts e2e/helpers/harness.ts
git commit -m "test: verify Grok runtime profile and restore flows"
```

---

### Task 12: Stage D integrated verification

**Files:**
- Modify only for defects found by verification/review.

- [ ] **Step 1: Run every new focused test**

```bash
node --experimental-strip-types --test --test-concurrency=1 \
  lib/runtime-profile.test.mjs \
  lib/grok-capabilities.test.mjs \
  lib/acp/process.test.mjs \
  lib/acp/runtime.test.mjs \
  lib/runtime-profile-http.test.mjs \
  lib/settings-http.test.mjs \
  lib/acp/config-options.test.mjs \
  lib/restore-code-http.test.mjs \
  components/AgentRuntimeConfig.test.mjs \
  components/SettingsPage.test.mjs \
  components/RestoreCodeDialog.test.mjs \
  components/CodexSidebar.test.mjs \
  hooks/useAgentSession.test.mjs
```

- [ ] **Step 2: Run complete repository gates**

```bash
node --experimental-strip-types --test --test-concurrency=1 "app/**/*.test.mjs" "components/**/*.test.mjs" "hooks/**/*.test.mjs" "lib/**/*.test.mjs" "public/**/*.test.mjs" "src/**/*.test.mjs" "scripts/**/*.test.mjs"
npm run typecheck
npm run lint
git diff --check
GROK_WEB_TANSTACK_OUTPUT_DIR=/tmp/grok-web-stage-d npm run build:tanstack:standalone
```

- [ ] **Step 3: Run route/browser/live gates**

Run the safe 75+ route matrix including new GET/invalid PUT/restore fake-ID routes, all deterministic Playwright tests repeatedly, and one operator-supplied dedicated-home live run. Verify the original project cwd, profile, sessions, and Provider configuration are unchanged after tests.

- [ ] **Step 4: Request independent security/correctness/UI review**

Review profile schema/secret rejection, exact argv layering, process transaction rollback, concurrent apply serialization, help/inspect parsing, path trust, private RPC allowlist, request-owned cleanup, Plan capability claims, authentication affordance, and browser accessibility.

- [ ] **Step 5: Stop for final integration approval**

Fix Critical/Important findings and rerun. Do not merge, push, restart the main service, or claim interactive parity until the user reviews the complete stage D evidence and chooses integration.