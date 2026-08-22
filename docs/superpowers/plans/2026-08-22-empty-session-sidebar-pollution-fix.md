# Empty Session Sidebar Pollution Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop route smoke from creating real Grok sessions and keep unmistakably empty tool-only sessions out of the shared session index and sidebar.

**Architecture:** Convert the MCP and Plugins route-smoke checks into validation-only `400` probes so they return before ACP startup/session creation. Add one guard in the shared Grok session reader that omits only entries explicitly reporting zero messages and lacking both a persisted title and recoverable user history.

**Tech Stack:** TypeScript, Node.js `node:test`, TanStack Start route smoke, Grok ACP persisted session summaries, Playwright.

---

## File Map

- `scripts/tanstack-route-smoke.mjs` — change two successful stateful probes into non-mutating validation probes.
- `lib/tanstack-route-inventory.test.mjs` — lock the validation-only MCP/Plugins smoke contract.
- `lib/session-index.ts` — omit unnamed, history-free sessions explicitly reporting `num_messages: 0`.
- `lib/session-index.test.mjs` — cover omission of empty tool sessions and preservation of named zero-message sessions.

No new files, helpers, types, dependencies, cleanup job, or ACP protocol changes are needed.

### Task 1: Make MCP and Plugins route smoke non-mutating

**Files:**
- Modify: `lib/tanstack-route-inventory.test.mjs:127-140`
- Modify: `scripts/tanstack-route-smoke.mjs:206-215`

- [ ] **Step 1: Write the failing route-smoke contract test**

Append this test after `the shared route smoke covers every adapter URL` in `lib/tanstack-route-inventory.test.mjs`:

```js
test("MCP and plugin smoke probes validate routes without creating sessions", async () => {
  const smokeSource = await readFile(join(ROOT, "scripts", "tanstack-route-smoke.mjs"), "utf8");
  assert.match(smokeSource, /probe\("GET", "\/api\/mcp", \[400\]\)/);
  assert.match(smokeSource, /probe\("GET", "\/api\/plugins", \[400\]\)/);
  assert.doesNotMatch(smokeSource, /probe\("GET", `\/api\/(?:mcp|plugins)\?cwd=/);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --experimental-strip-types --test --test-concurrency=1 lib/tanstack-route-inventory.test.mjs
```

Expected: FAIL in `MCP and plugin smoke probes validate routes without creating sessions` because the current script includes fixture-cwd probes and does not contain the validation-only probes.

- [ ] **Step 3: Replace the two stateful smoke probes**

In `scripts/tanstack-route-smoke.mjs`, replace:

```js
await probe("GET", `/api/mcp?cwd=${encodeURIComponent(fixtureDir)}`, [200, 400]);
```

with:

```js
await probe("GET", "/api/mcp", [400]);
```

Replace:

```js
await probe("GET", `/api/plugins?cwd=${encodeURIComponent(fixtureDir)}`, [200, 400]);
```

with:

```js
await probe("GET", "/api/plugins", [400]);
```

Do not change the focused MCP/Plugins handler tests; they continue to cover successful responses.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
node --experimental-strip-types --test --test-concurrency=1 lib/tanstack-route-inventory.test.mjs
```

Expected: all tests pass.

- [ ] **Step 5: Commit the smoke fix**

```bash
git add lib/tanstack-route-inventory.test.mjs scripts/tanstack-route-smoke.mjs
git commit -m "fix: keep route smoke from creating sessions"
```

### Task 2: Exclude unmistakably empty tool sessions from the session index

**Files:**
- Modify: `lib/session-index.test.mjs:12-116`
- Modify: `lib/session-index.ts:75-100`

- [ ] **Step 1: Write the failing session-index behavior test**

Add this case inside `describe("listGrokSessions", ...)` in `lib/session-index.test.mjs`:

```js
it("skips unnamed zero-message tool sessions but keeps named sessions", async () => {
  const home = await mkdtemp(join(tmpdir(), "grok-idx-empty-"));
  const prev = process.env.GROK_HOME;
  process.env.GROK_HOME = home;
  try {
    const emptyId = "01iiiiiiiiiiiiiiiiiiiiiiii";
    const namedId = "01jjjjjjjjjjjjjjjjjjjjjjjj";
    await writeSummary(join(home, "sessions", encodeURIComponent("/tmp/tool-only"), emptyId), {
      info: { id: emptyId, cwd: "/tmp/tool-only" },
      session_summary: "",
      generated_title: "",
      created_at: "2026-08-22T00:00:00.000Z",
      updated_at: "2026-08-22T00:00:00.000Z",
      num_messages: 0,
      num_chat_messages: 2,
    });
    await writeSummary(join(home, "sessions", encodeURIComponent("/tmp/named"), namedId), {
      info: { id: namedId, cwd: "/tmp/named" },
      session_summary: "",
      generated_title: "Keep this draft",
      created_at: "2026-08-22T00:00:00.000Z",
      updated_at: "2026-08-22T00:00:00.000Z",
      num_messages: 0,
      num_chat_messages: 2,
    });

    const sessions = await listGrokSessions();
    assert.deepEqual(sessions.map((session) => session.id), [namedId]);
    assert.equal(sessions[0].name, "Keep this draft");
  } finally {
    if (prev === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = prev;
  }
});
```

This uses real temporary summary files. The empty session intentionally has no `updates.jsonl`; the named session verifies that zero alone is not enough to hide a session.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --experimental-strip-types --test --test-concurrency=1 lib/session-index.test.mjs
```

Expected: FAIL because both `emptyId` and `namedId` are currently returned.

- [ ] **Step 3: Add the minimal shared index guard**

In `readSession()` in `lib/session-index.ts`, immediately before the existing fallback:

```ts
if (!firstMessage) firstMessage = EMPTY_SESSION_LABEL;
```

add:

```ts
if (numberField(body.num_messages) === 0 && !firstMessage && !name) return null;
```

The guard runs after `titleFromUpdates()` recovery, so a real user title recovered from history remains visible. It also preserves named sessions and older summaries where `num_messages` is absent.

- [ ] **Step 4: Run session-index and session HTTP tests and verify GREEN**

Run:

```bash
node --experimental-strip-types --test --test-concurrency=1 \
  lib/session-index.test.mjs \
  lib/session-http.test.mjs \
  lib/recent-sessions.test.mjs \
  components/CodexSidebar.test.mjs
```

Expected: all tests pass.

- [ ] **Step 5: Commit the index fix**

```bash
git add lib/session-index.test.mjs lib/session-index.ts
git commit -m "fix: hide empty tool sessions from the sidebar"
```

### Task 3: Verify the complete fix without touching user session data

**Files:**
- No source changes expected.

- [ ] **Step 1: Run all focused regression tests together**

```bash
node --experimental-strip-types --test --test-concurrency=1 \
  lib/tanstack-route-inventory.test.mjs \
  lib/session-index.test.mjs \
  lib/session-http.test.mjs \
  lib/recent-sessions.test.mjs \
  components/CodexSidebar.test.mjs
```

Expected: all focused tests pass with zero failures.

- [ ] **Step 2: Run the complete test suite serially**

```bash
node --experimental-strip-types --test --test-concurrency=1 \
  "app/**/*.test.mjs" \
  "components/**/*.test.mjs" \
  "hooks/**/*.test.mjs" \
  "lib/**/*.test.mjs" \
  "public/**/*.test.mjs" \
  "src/**/*.test.mjs" \
  "scripts/**/*.test.mjs"
```

Expected: zero failures. Serial execution avoids the known `proper-lockfile` contention in the default concurrent suite.

- [ ] **Step 3: Run static checks**

```bash
npm run typecheck
npm run lint
git diff --check
git status --short --branch
```

Expected: typecheck passes; lint has zero errors (existing warnings are acceptable); `git diff --check` is silent; worktree is clean after the two commits.

- [ ] **Step 4: Build an isolated standalone output**

```bash
rm -rf /tmp/grok-web-empty-session-fix
GROK_WEB_TANSTACK_OUTPUT_DIR=/tmp/grok-web-empty-session-fix npm run build:tanstack:standalone
```

Expected: Vite client, SSR, and Nitro builds complete successfully. Existing large-chunk warnings are acceptable.

- [ ] **Step 5: Start the isolated build and verify the real session API/sidebar**

Start the server on an unused port:

```bash
GROK_WEB_TANSTACK_OUTPUT_DIR=/tmp/grok-web-empty-session-fix \
NITRO_HOST=127.0.0.1 \
NITRO_PORT=30143 \
node scripts/start-tanstack-output.mjs >/tmp/grok-web-empty-session-fix.log 2>&1 &
echo $! >/tmp/grok-web-empty-session-fix.pid
```

Wait for `http://127.0.0.1:30143/` to return HTTP 200. Then run this Playwright check:

```bash
node --input-type=module <<'EOF'
import { chromium } from "@playwright/test";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto("http://127.0.0.1:30143/", { waitUntil: "networkidle" });
const body = await page.locator("body").innerText();
if (/pi-web-route-smoke-[^\n]*\n\(no messages\)/.test(body)) {
  throw new Error("route-smoke empty session is still visible");
}
console.log("sidebar has no route-smoke empty session rows");
await browser.close();
EOF
```

Expected: the script prints `sidebar has no route-smoke empty session rows`.

Stop the validation server without deleting or editing anything under `~/.grok`:

```bash
kill "$(cat /tmp/grok-web-empty-session-fix.pid)"
```

- [ ] **Step 6: Review final history and scope**

```bash
git log --oneline --decorate -5
git diff HEAD~2 --stat
git status --short --branch
```

Expected: exactly two implementation commits after the design/plan commits; only the four mapped source/test files changed; worktree clean. Do not push, merge, clean historical sessions, or restart the main local server until the user approves branch completion.
