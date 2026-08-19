# Native Git Writes and Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** FileViewer can Stage / Discard / Commit the current file over Grok ACP; `/feedback` and `/recap` work; `↑` history merges ACP `prompt_history`.

**Architecture:** Thin `_x.ai/git/stage|discard|commit`, `_x.ai/feedback`, `_x.ai/recap`, `_x.ai/prompt_history` on `AcpConnection`. Git writes are `POST /api/git/*` (ACP only, no local git write). Feedback/recap/history are `POST /api/agent/:id` command types. UI stays on FileViewer toolbar, `codex-dialog`, builtin slash, and existing `↑` history.

**Tech Stack:** Existing Node + Vite + TanStack + `lib/acp/*`. Tests: `node --experimental-strip-types --test`. Live accept may use real `grok`.

**Spec:** `docs/superpowers/specs/2026-08-19-grok-web-native-git-feedback.md`

---

## File map

- Modify: `lib/acp/connection.ts`, `fake-agent.mjs`, `connection.test.mjs`, `runtime.ts`, `runtime.test.mjs`
- Create: `app/api/git/stage/route.ts`, `discard/route.ts`, `commit/route.ts` + TanStack adapters
- Modify: `src/api-methods.ts`, `lib/tanstack-route-inventory.test.mjs`, `src/routeTree.gen.ts` (or let Vite regenerate)
- Modify: `components/FileViewer.tsx`, `ChatInput.tsx`, `ChatWindow.tsx`, `hooks/useAgentSession.ts`
- Modify: `lib/i18n/messages/en.ts`, `zh-CN.ts`

### Task 1: ACP git write + feedback + recap + history

**Files:** `lib/acp/connection.ts`, `fake-agent.mjs`, `connection.test.mjs`

- [ ] **Step 1:** Add failing tests to `connection.test.mjs`:

```javascript
  it("stages discards and commits over _x.ai/git", async () => {
    const { child, acp } = spawnFake();
    try {
      await acp.initialize();
      const staged = await acp.gitStage(["readme.md"]);
      assert.deepEqual(staged.paths, ["readme.md"]);
      await assert.rejects(acp.gitDiscard([]), /paths/);
      const discarded = await acp.gitDiscard(["readme.md"]);
      assert.ok(discarded);
      const committed = await acp.gitCommit("msg");
      assert.equal(committed.ok, true);
    } finally {
      child.kill();
    }
  });

  it("sends feedback recap and prompt history over ACP", async () => {
    const { child, acp } = spawnFake();
    try {
      await acp.initialize();
      const { sessionId } = await acp.sessionNew("/tmp/p");
      assert.equal((await acp.feedback(sessionId, "hello")).success, true);
      assert.equal((await acp.recap(sessionId)).ok, true);
      assert.deepEqual((await acp.promptHistory("/tmp/p")).prompts, ["prev"]);
    } finally {
      child.kill();
    }
  });
```

- [ ] **Step 2:** Run and confirm FAIL (`gitStage is not a function`).
- [ ] **Step 3:** Implement connection methods + fake-agent handlers. `git/stage` and `git/discard` require non-empty `paths`. `git/commit` requires `message`. `feedback` uses `session_id` + `feedback_text`. `recap` uses `sessionId`. `prompt_history` uses `cwd`.
- [ ] **Step 4:** Tests pass.
- [ ] **Step 5:** Commit `feat: talk to Grok git write, feedback, recap, and prompt history APIs`

### Task 2: Runtime commands + Git HTTP

**Files:** `lib/acp/runtime.ts`, `runtime.test.mjs`, `app/api/git/{stage,discard,commit}/route.ts`, adapters, inventory

- [ ] **Step 1:** Runtime tests: `feedback` / `recap` / `get_prompt_history` via `runtime.send`; `gitStage`/`gitDiscard`/`gitCommit` on runtime reject empty paths / empty message.
- [ ] **Step 2:** FAIL then implement `runtime.send` cases and `gitStage`/`gitDiscard`/`gitCommit`.
- [ ] **Step 3:** Shared helper for POST git writes: validate cwd+path (or message), allowlist, `ensureProcess`, 501 if ACP missing, never spawn local `git`.
- [ ] **Step 4:** Register POST in `src/api-methods.ts` and `lib/tanstack-route-inventory.test.mjs`.
- [ ] **Step 5:** Commit `feat: expose ACP git writes and chat feedback commands`

### Task 3: FileViewer toolbar

**Files:** `FileViewer.tsx`, i18n

- [ ] **Step 1:** Source test: `FileViewer.tsx` contains `files.stage` / `files.discard` / `files.commit` only inside `hasGitDiff`.
- [ ] **Step 2:** Add buttons next to `file-viewer-mode-switch` using `file-viewer-mode-button`. Stage/Discard POST current file. Commit opens `DialogShell` editor. Refresh `gitRefreshKey` via optional `onGitMutated` or local state. i18n en + zh-CN, no "Pi".
- [ ] **Step 3:** Commit `feat: add Stage Discard Commit to the file viewer toolbar`

### Task 4: Slash + history

**Files:** `ChatInput.tsx`, `useAgentSession.ts`, `ChatWindow.tsx`

- [ ] **Step 1:** Tests: builtin list includes `feedback` and `recap`; empty `/feedback` returns `action: "openFeedback"`.
- [ ] **Step 2:** Handle commands; ChatWindow dialog for empty feedback; merge `get_prompt_history` into `inputHistory` (dedupe, cap 50, fail silent).
- [ ] **Step 3:** Live accept with real grok if available: stage/discard on a disposable file, `/feedback 测试`, history fetch.
- [ ] **Step 4:** Commit `feat: add /feedback /recap and ACP prompt history`

## Spec coverage

- Git toolbar, commit dialog, discard no confirm → Task 3
- ACP methods + empty paths rejected → Task 1–2
- HTTP 501 / 403 → Task 2
- Slash + dialog + history → Task 4
- No local git write → Task 2
- Live real grok → Task 4
