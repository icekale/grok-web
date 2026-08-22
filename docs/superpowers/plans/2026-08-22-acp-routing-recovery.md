# ACP Workspace Routing and Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route workspace tools through the exact requested cwd, restore current turn/approval state after reconnect, converge multiple tabs, and make every advertised thinking-level change real.

**Architecture:** Keep workspace authorization in HTTP routes, put canonical cwd ownership and approval atomicity in `AgentRuntime`/`AcpConnection`, and publish one bounded listener-first `session_snapshot` before live SSE deltas. The browser applies snapshots idempotently by prompt generation and reloads persisted history when it missed terminal state.

**Tech Stack:** TypeScript, Grok ACP JSON-RPC, SSE, React hooks, Node test runner, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-22-acp-routing-recovery-design.md`

**Dependency:** Stage A must already be integrated and green.

---

### Task 1: Route workspace tools by canonical cwd

**Files:**
- Modify: `lib/acp/runtime.ts:79-86,127-175,260-315,277-283`
- Modify: `lib/acp/runtime.test.mjs`
- Modify: `lib/acp/connection.ts:437-451`
- Modify: `lib/plugins-http.ts:142-166`
- Modify: `lib/mcp-http.test.mjs`
- Modify: `lib/plugins-http.test.mjs`

- [ ] **Step 1: Add failing runtime routing tests**

Add tests that create loaded sessions for `/tmp/a` and `/tmp/b`, call MCP/Plugins for each cwd, and record the session IDs supplied to the fake ACP methods:

```js
it("routes workspace tools through the loaded session with the same canonical cwd", async () => {
  const calls = [];
  const runtime = workspaceRuntime(calls);
  await runtime.loadSession("session-a", "/tmp/a");
  await runtime.loadSession("session-b", "/tmp/b");
  await runtime.listMcp("/tmp/b");
  await runtime.listPlugins("/tmp/a");
  assert.deepEqual(calls, [
    ["mcp", "session-b"],
    ["plugins", "session-a"],
  ]);
});
```

Add tests for:

- an unrelated loaded session is never used;
- canonical aliases resolve to one key;
- two simultaneous first requests create one session;
- rejected initialization removes only its own promise and a retry succeeds.

- [ ] **Step 2: Add HTTP boundary tests and verify RED**

In MCP/Plugins tests, inject a runtime whose `createSession`/workspace methods fail if called, send invalid/unauthorized cwd, and assert `400`/`403` with zero ACP calls. Add a Marketplace assertion that its list/action receives the cwd-matching session.

Run:

```bash
node --experimental-strip-types --test --test-concurrency=1 lib/acp/runtime.test.mjs lib/mcp-http.test.mjs lib/plugins-http.test.mjs
```

Expected: project B uses the first loaded project A session and concurrent initialization creates duplicates.

- [ ] **Step 3: Add one per-cwd initialization map**

```ts
private readonly workspaceSessionStarts = new Map<string, Promise<string>>();

private async workspaceSession(cwd: string): Promise<string> {
  await this.ensureProcess();
  const canonical = canonicalCwd(cwd);
  const loaded = [...this.sessions].find(([, session]) => (
    session.loaded && session.cwd && canonicalCwd(session.cwd) === canonical
  ));
  if (loaded) return loaded[0];
  const current = this.workspaceSessionStarts.get(canonical);
  if (current) return current;
  const start = this.createSession(canonical);
  this.workspaceSessionStarts.set(canonical, start);
  try {
    return await start;
  } finally {
    if (this.workspaceSessionStarts.get(canonical) === start) {
      this.workspaceSessionStarts.delete(canonical);
    }
  }
}
```

Replace `withSession()` with `withWorkspaceSession()` using this lookup. Keep `createSession`, `loadSession`, and `resumeSession` cwd state canonical. Clear only initialization state when the ACP connection is dropped.

- [ ] **Step 4: Route every workspace method through the helper**

MCP list/mutations, Plugin list/actions, and Marketplace list/actions must receive cwd and use the matching session. Change `listMarketplace()` and the Plugins HTTP call chain to require cwd. Do not add a no-cwd fallback.

- [ ] **Step 5: Run tests and commit**

```bash
node --experimental-strip-types --test --test-concurrency=1 lib/acp/runtime.test.mjs lib/acp/connection.test.mjs lib/mcp-http.test.mjs lib/plugins-http.test.mjs lib/session-index.test.mjs
git add lib/acp/runtime.ts lib/acp/runtime.test.mjs lib/acp/connection.ts lib/plugins-http.ts lib/mcp-http.test.mjs lib/plugins-http.test.mjs
git commit -m "fix: route workspace tools by canonical cwd"
```

---

### Task 2: Enumerate and atomically resolve pending permissions

**Files:**
- Modify: `lib/acp/connection.ts:90-205`
- Modify: `lib/acp/connection.test.mjs`
- Modify: `lib/acp/permissions.ts`
- Modify: `lib/acp/permissions.test.mjs`
- Modify: `lib/acp/runtime.ts:345-490,656-664,934-940`
- Modify: `lib/acp/runtime.test.mjs`
- Modify: `lib/acp/http.ts:198-225`
- Modify: `lib/acp/http.test.mjs`

- [ ] **Step 1: Add failing connection-level snapshot/race tests**

Use a fixed `now()` and long timeout. After sending `session/request_permission`, assert:

```js
assert.deepEqual(acp.pendingPermissionsForSession("s1"), [{
  type: "extension_ui_request",
  id: "7",
  method: "confirm",
  title: "Allow bash",
  message: "bash ...",
  options: [
    { id: "allow-once", label: "Allow once", kind: "allow_once" },
    { id: "reject-once", label: "Reject", kind: "reject_once" },
  ],
  sessionId: "s1",
  expiresAt: 61_000,
}]);
```

Read it twice and assert `expiresAt` is unchanged. Resolve twice and assert the first result is `resolved`, the second is `already_resolved`, and JSON-RPC receives one response. Add timeout and same-request-id/different-session tests.

- [ ] **Step 2: Verify RED**

```bash
node --experimental-strip-types --test --test-concurrency=1 lib/acp/connection.test.mjs lib/acp/permissions.test.mjs
```

Expected: no enumeration API, duplicate completion silently succeeds, and timeout emits no terminal event.

- [ ] **Step 3: Store the safe translated request and expose immutable snapshots**

Extend pending state with `uiRequest`, `sessionId`, and `expiresAt`. Add:

```ts
pendingPermissionsForSession(sessionId: string): PermissionUiSnapshot[] {
  return [...this.pendingPermissions.values()]
    .filter((pending) => pending.sessionId === sessionId)
    .map((pending) => ({ ...pending.uiRequest, expiresAt: pending.expiresAt }));
}
```

Extend `translatePermissionRequest()` to retain only a bounded allowlist of option `{ id, label, kind }` strings from ACP `options`; discard every other option field and all raw tool params. Do not expose raw ACP params or reset timers. Add a test with secret-bearing raw option/tool fields and prove the snapshot contains only translated IDs/labels/kinds.

- [ ] **Step 4: Add one resolved event path**

```ts
type PermissionResolution = {
  type: "permission_resolved";
  sessionId: string;
  id: string;
  result: "confirmed" | "cancelled" | "timed_out";
};
```

Add `onPermissionResolved()`. Manual and timeout paths delete from the map before responding, then emit exactly one resolution. `completePermission()` returns `{ status: "resolved" } | { status: "already_resolved" }`.

- [ ] **Step 5: Map the loser to HTTP 409 and broadcast resolutions**

Add a small `AgentCommandError` carrying `status` and `code`. Runtime throws it for `already_resolved`; `agentErrorResponse()` preserves status/code:

```ts
if (error instanceof AgentCommandError) {
  return Response.json({ error: error.message, code: error.code }, { status: error.status });
}
```

Subscribe runtime to permission resolutions and emit them only to the matching session listeners.

- [ ] **Step 6: Run focused tests and commit**

```bash
node --experimental-strip-types --test --test-concurrency=1 lib/acp/connection.test.mjs lib/acp/permissions.test.mjs lib/acp/runtime.test.mjs lib/acp/http.test.mjs
git add lib/acp/connection.ts lib/acp/connection.test.mjs lib/acp/permissions.ts lib/acp/permissions.test.mjs lib/acp/runtime.ts lib/acp/runtime.test.mjs lib/acp/http.ts lib/acp/http.test.mjs
git commit -m "fix: recover and atomically resolve permissions"
```

---

### Task 3: Publish one authoritative session snapshot over SSE

**Files:**
- Modify: `lib/agent-events.ts`
- Modify: `lib/agent-event-stream.ts`
- Modify: `lib/agent-event-stream.test.mjs`
- Modify: `lib/agent-events-http.ts`
- Modify: `lib/agent-events-http.source.test.mjs`
- Modify: `lib/agent-event-wire.ts`
- Modify: `lib/agent-event-wire.test.mjs`
- Modify: `lib/agent-event-connection.ts:140-165`
- Modify: `lib/agent-event-connection.test.mjs`
- Modify: `lib/tanstack-agent-events-route.test.mjs`
- Modify: `lib/acp/runtime.ts:514-584`

- [ ] **Step 1: Define the wire type and add failing stream tests**

```ts
export type SessionSnapshotEvent = {
  type: "session_snapshot";
  sessionId: string;
  promptGeneration: number;
  busy: boolean;
  streamingMessage: unknown | null;
  queuedMessages: { steering: string[]; followUp: string[] };
  pendingPermissions: Array<Record<string, unknown>>;
  model: { provider: string; id: string };
  thinkingLevel?: string;
  toolPresets: unknown[];
  contextUsage?: unknown;
  eventSequence: number;
};
```

Replace the old connected/message-start test expectations with one `session_snapshot`. Add an update while asynchronous `snapshot()` is pending and prove content represented by the snapshot appears exactly once, while a later update appears once after the snapshot. Include a mapper snapshot containing text, thinking, and tool blocks.

- [ ] **Step 2: Verify RED**

```bash
node --experimental-strip-types --test --test-concurrency=1 lib/agent-event-stream.test.mjs lib/agent-event-wire.test.mjs lib/agent-events-http.source.test.mjs
```

Expected: stream emits `connected`, buffers events before `message_start`, and route supplies `streamingMessage: null`.

- [ ] **Step 3: Add a runtime snapshot method**

```ts
async getSessionSnapshot(sessionId: string) {
  const state = await this.getState(sessionId);
  // Mapper state is updated before each event receives its monotonic sequence.
  // These synchronous reads therefore form one JS-turn watermark.
  return {
    ...state,
    busy: this.isBusy(sessionId),
    streamingMessage: this.getStreamingMessage(sessionId),
    pendingPermissions: this.requireAcp().pendingPermissionsForSession(sessionId),
    eventSequence: this.currentEventSequence(sessionId),
  };
}
```

Assign a monotonically increasing per-session sequence only after an event's data has been applied to runtime/mapper state, and pass `{ sequence, event }` to listeners. Do not copy persisted history. Keep context usage bounded to the existing summary signal read.

- [ ] **Step 4: Make the stream read snapshot after subscription**

Change `AgentEventStreamSession` to:

```ts
interface AgentEventStreamSession {
  snapshot(): Promise<Omit<SessionSnapshotEvent, "type" | "sessionId" | "promptGeneration">>;
  onEvent(listener: (entry: { sequence: number; event: AgentEventLike }) => void): () => void;
}
```

After `onEvent()` installs the listener, capture one generation, await `snapshot()`, publish it, then drain only buffered entries whose `sequence > snapshot.eventSequence`, preserving sequence order. New live entries continue from that watermark. Remove `isEventIncludedInSnapshot()` object-identity suppression; the sequence watermark, not prompt generation or client heuristics, owns the no-duplicate boundary.

- [ ] **Step 5: Wire the real route**

`agent-events-http.ts` supplies `snapshot: () => runtime.getSessionSnapshot(id)` and no hardcoded null. Ensure wire sanitization explicitly allowlists `session_snapshot` fields and safe permission payloads. Treat `session_snapshot` as the EventSource readiness frame in `AgentEventConnection`, replacing the old `connected` readiness check; update its timeout/reconnect tests and the TanStack route test accordingly.

- [ ] **Step 6: Run tests and commit**

```bash
node --experimental-strip-types --test --test-concurrency=1 lib/agent-event-stream.test.mjs lib/agent-event-wire.test.mjs lib/agent-event-connection.test.mjs lib/agent-events-http.source.test.mjs lib/tanstack-agent-events-route.test.mjs lib/acp/map-events.test.mjs lib/acp/runtime.test.mjs
git add lib/agent-events.ts lib/agent-event-stream.ts lib/agent-event-stream.test.mjs lib/agent-events-http.ts lib/agent-events-http.source.test.mjs lib/agent-event-wire.ts lib/agent-event-wire.test.mjs lib/agent-event-connection.ts lib/agent-event-connection.test.mjs lib/tanstack-agent-events-route.test.mjs lib/acp/runtime.ts
git commit -m "feat: publish authoritative ACP session snapshots"
```

---

### Task 4: Reconcile snapshots and approvals in the browser

**Files:**
- Modify: `hooks/useAgentSession.ts:880-930,1100-1515`
- Modify: `hooks/useAgentSession.test.mjs`
- Modify: `lib/streaming-message.ts`
- Modify: `lib/streaming-message.test.mjs`
- Modify: `lib/agent-events.ts`

- [ ] **Step 1: Add failing reducer/hook tests**

Cover:

- a same-generation partial snapshot replaces the in-flight message once;
- later deltas append without duplicating prefix text;
- an older generation snapshot is ignored;
- idle snapshot while the same run is locally busy triggers `loadSession()`/settlement;
- idle stale snapshot cannot settle a newer run;
- pending permission snapshot opens the existing dialog;
- matching `permission_resolved` closes it in both tabs;
- a non-matching resolution leaves the current dialog open.

Reducer example:

```js
const state = reduceStreamingMessage(initial, {
  type: "snapshot",
  message: { role: "assistant", content: [{ type: "text", text: "Hel" }] },
});
assert.equal(state.content[0].text, "Hel");
```

- [ ] **Step 2: Verify RED**

```bash
node --experimental-strip-types --test --test-concurrency=1 lib/streaming-message.test.mjs hooks/useAgentSession.test.mjs
```

- [ ] **Step 3: Add one `session_snapshot` switch case before delta cases**

Validate arrays/object fields before mutation. Gate by `promptGeneration` and current session/run refs. Dispatch the existing reducer `snapshot` action for `streamingMessage`, replace queue/model/mode/tool/context from the frame, and pass every pending permission through `handleExtensionUiRequest()`.

When the frame is idle but local state is active for the same generation, call the existing prompt-settlement/load path. Do not append snapshot content to persisted messages.

- [ ] **Step 4: Handle permission resolution**

On `permission_resolved`, close only the dialog whose ID/session match and stop any local expiry UI. Treat HTTP `409 already_resolved` from a user click as converged state, not a generic failure.

- [ ] **Step 5: Run tests and commit**

```bash
node --experimental-strip-types --test --test-concurrency=1 lib/streaming-message.test.mjs hooks/useAgentSession.test.mjs components/DialogConfirmations.test.mjs lib/agent-event-connection.test.mjs
git add hooks/useAgentSession.ts hooks/useAgentSession.test.mjs lib/streaming-message.ts lib/streaming-message.test.mjs lib/agent-events.ts
git commit -m "fix: reconcile ACP state after browser reconnect"
```

---

### Task 5: Make thinking levels capability-backed and reversible

**Files:**
- Modify: `lib/acp/runtime.ts:446-455`
- Modify: `lib/acp/runtime.test.mjs:1027-1047`
- Modify: `hooks/useAgentSession.ts:590-600,2080-2105`
- Modify: `hooks/useAgentSession.test.mjs`
- Modify: `components/ChatInput.tsx`
- Modify: `components/ChatInput.test.mjs`

- [ ] **Step 1: Replace the obsolete server test and add failure preservation**

```js
it("sends every advertised thinking level including off to ACP", async () => {
  const modes = [];
  const runtime = modeRuntime((mode) => modes.push(mode));
  const id = await runtime.createSession("/tmp/p");
  await runtime.send(id, { type: "set_thinking_level", level: "high" });
  await runtime.send(id, { type: "set_thinking_level", level: "off" });
  assert.deepEqual(modes, ["high", "off"]);
});
```

Add rejection test: after accepted `high`, reject `off`, then `get_state.thinkingLevel` remains `high`.

- [ ] **Step 2: Add client rollback and advertised-list tests, then verify RED**

Test that a rejected selection restores the previous value and adds a notice. Test that an empty/missing advertised level list hides the control and no synthetic `off`/`auto` appears.

```bash
node --experimental-strip-types --test --test-concurrency=1 lib/acp/runtime.test.mjs hooks/useAgentSession.test.mjs components/ChatInput.test.mjs
```

- [ ] **Step 3: Remove the off short circuit**

```ts
const previous = this.ensureSession(sessionId).thinkingLevel;
await this.requireAcp().sessionSetMode(sessionId, level);
this.ensureSession(sessionId).thinkingLevel = level;
return { level, previous };
```

Only mutate after ACP success.

- [ ] **Step 4: Mirror tool-preset rollback in the hook**

Capture the previous level, optimistically display the next level, await the command, then accept the returned level. On error, restore the previous level and call `addNotice()` with the capability error. Use a request-generation ref so an older rejection cannot roll back a newer successful choice.

Build picker entries solely from the current model's advertised array; do not insert defaults.

- [ ] **Step 5: Run tests and commit**

```bash
node --experimental-strip-types --test --test-concurrency=1 lib/acp/models.test.mjs lib/acp/runtime.test.mjs hooks/model-switching.test.mjs hooks/useAgentSession.test.mjs components/ChatInput.test.mjs
git add lib/acp/runtime.ts lib/acp/runtime.test.mjs hooks/useAgentSession.ts hooks/useAgentSession.test.mjs components/ChatInput.tsx components/ChatInput.test.mjs
git commit -m "fix: honor advertised Grok thinking modes"
```

---

### Task 6: Add the minimal stage B stdio browser fixture

**Files:**
- Create: `e2e/fixtures/stage-b-acp.mjs`
- Create: `e2e/stage-b-recovery.spec.ts`
- Modify: `playwright.config.ts`
- Modify: `package.json`

- [ ] **Step 1: Write fixture subprocess checks before browser scenarios**

The executable fixture must support initialize, distinct `session/new` per cwd, MCP/Plugins list logging, a paused partial text turn, one permission request, `session/set_mode`, cancel, and close. Unknown requests return JSON-RPC `-32601` instead of being ignored.

Add a Node test under an existing test glob (for example `scripts/stage-b-acp-fixture.test.mjs`) that spawns it and verifies unique cwd/session IDs and unknown-method failure.

- [ ] **Step 2: Run fixture test and verify RED until the protocol peer exists**

```bash
node --experimental-strip-types --test --test-concurrency=1 scripts/stage-b-acp-fixture.test.mjs
```

- [ ] **Step 3: Add three browser scenarios**

Using temporary `GROK_HOME`, `GROK_BIN` pointing to the fixture, random/isolated port, and one Playwright worker:

1. project A/B MCP and Plugins views produce distinct logged session IDs;
2. disconnect after partial text, reconnect, and finish with the prefix rendered once;
3. two tabs see the same approval, opposite clicks produce one fixture response and both dialogs close.

After each test delete only created sessions and assert no test cwd appears in `/api/sessions`.

- [ ] **Step 4: Run browser tests repeatedly and commit**

```bash
npx playwright test e2e/stage-b-recovery.spec.ts --workers=1
for i in 1 2 3; do npx playwright test e2e/stage-b-recovery.spec.ts --workers=1 || exit 1; done
git add e2e/fixtures/stage-b-acp.mjs scripts/stage-b-acp-fixture.test.mjs e2e/stage-b-recovery.spec.ts playwright.config.ts package.json
git commit -m "test: cover ACP workspace and reconnect recovery"
```

---

### Task 7: Stage B integrated verification

**Files:**
- Modify only for defects found by verification/review.

- [ ] **Step 1: Run all stage B focused tests**

```bash
node --experimental-strip-types --test --test-concurrency=1 \
  lib/acp/runtime.test.mjs \
  lib/acp/connection.test.mjs \
  lib/acp/permissions.test.mjs \
  lib/acp/http.test.mjs \
  lib/mcp-http.test.mjs \
  lib/plugins-http.test.mjs \
  lib/agent-event-stream.test.mjs \
  lib/agent-event-wire.test.mjs \
  lib/streaming-message.test.mjs \
  hooks/useAgentSession.test.mjs \
  components/ChatInput.test.mjs
```

- [ ] **Step 2: Run full gates**

```bash
node --experimental-strip-types --test --test-concurrency=1 "app/**/*.test.mjs" "components/**/*.test.mjs" "hooks/**/*.test.mjs" "lib/**/*.test.mjs" "public/**/*.test.mjs" "src/**/*.test.mjs" "scripts/**/*.test.mjs"
npm run typecheck
npm run lint
git diff --check
GROK_WEB_TANSTACK_OUTPUT_DIR=/tmp/grok-web-stage-b npm run build:tanstack:standalone
```

- [ ] **Step 3: Run route and browser smoke**

Run the safe route matrix against the stage B build, the existing shell Playwright test, and `stage-b-recovery.spec.ts`. Assert the sidebar and `/api/sessions` contain no route-smoke or fixture cwd.

- [ ] **Step 4: Request independent race/correctness review**

Review against `docs/superpowers/specs/2026-08-22-acp-routing-recovery-design.md`. Require explicit inspection of listener/snapshot ordering, promise-map cleanup, permission timeout/response order, stale generation handling, and cross-cwd isolation.

- [ ] **Step 5: Stop at the stage gate**

Fix Critical/Important findings and rerun affected gates. Do not merge, push, restart the main service, or start stage C until the user approves stage B integration.