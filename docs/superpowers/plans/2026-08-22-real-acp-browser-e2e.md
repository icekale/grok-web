# Real ACP Browser E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run deterministic browser-to-stdio ACP scenarios in CI and provide a guarded opt-in browser suite against a dedicated authenticated Grok Build home.

**Architecture:** Promote the stage B stdio fixture into a fail-unknown scenario peer, launch Playwright under a runner-owned temporary home/projects/random port, and retain only allowlisted/redacted failure evidence. A separate live runner validates its dedicated home and authentication before spawning anything, then executes one bounded test-owned session.

**Tech Stack:** Playwright Chromium, Node.js child processes and temporary directories, Grok ACP JSON-RPC/SSE, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-22-real-acp-browser-e2e-design.md`

**Dependencies:** Stages A and B are integrated. Stage B's minimal fixture and recovery spec are green.

---

### Task 1: Promote the stage B fixture into a fail-unknown ACP peer

**Files:**
- Rename: `e2e/fixtures/stage-b-acp.mjs` -> `e2e/fixtures/acp-agent.mjs`
- Modify: `scripts/stage-b-acp-fixture.test.mjs`
- Create: `scripts/acp-e2e-fixture.test.mjs`
- Modify: `e2e/stage-b-recovery.spec.ts`

- [ ] **Step 1: Add failing fixture-contract tests**

Spawn the executable and exchange newline JSON-RPC. Tests must cover:

```js
await rpc.request("initialize", { protocolVersion: 1 });
const a = await rpc.request("session/new", { cwd: projectA, mcpServers: [] });
const b = await rpc.request("session/new", { cwd: projectB, mcpServers: [] });
assert.notEqual(a.sessionId, b.sessionId);
await assert.rejects(rpc.request("unknown/method", {}), (error) => error.code === -32601);
```

Also prove scenario control can pause/release a turn, permissions are keyed by session/request ID, and fixture logs contain only allowlisted fields:

```js
assert.deepEqual(Object.keys(logEntry).sort(), ["cwdAlias", "method", "sessionId", "testId", "timestamp"]);
assert.doesNotMatch(JSON.stringify(logEntry), /prompt|api.?key|password|token/i);
```

- [ ] **Step 2: Verify RED**

```bash
node --experimental-strip-types --test --test-concurrency=1 scripts/acp-e2e-fixture.test.mjs
```

Expected: the generalized fixture path/control/log contract does not exist or unknown methods are ignored.

- [ ] **Step 3: Generalize, do not duplicate, the existing fixture**

Use a shebang executable and structured environment:

```js
const scenario = process.env.GROK_WEB_ACP_FIXTURE_SCENARIO || "core";
const logPath = process.env.GROK_WEB_ACP_FIXTURE_LOG;
const controlPath = process.env.GROK_WEB_ACP_FIXTURE_CONTROL;
```

Implement only required initialize/session/prompt/cancel/close/model/mode/MCP/Plugins/permission/worktree calls. Unknown requests receive:

```js
respondError(message.id, -32601, `Method not found: ${message.method}`);
```

Generate distinct deterministic IDs per cwd. Log method and safe aliases, never params wholesale.

- [ ] **Step 4: Update stage B references and run tests**

```bash
node --experimental-strip-types --test --test-concurrency=1 scripts/stage-b-acp-fixture.test.mjs scripts/acp-e2e-fixture.test.mjs
npx playwright test e2e/stage-b-recovery.spec.ts --workers=1
```

- [ ] **Step 5: Commit**

```bash
git add e2e/fixtures/acp-agent.mjs scripts/stage-b-acp-fixture.test.mjs scripts/acp-e2e-fixture.test.mjs e2e/stage-b-recovery.spec.ts
git commit -m "test: promote the ACP browser fixture"
```

---

### Task 2: Build the isolated deterministic E2E runner

**Files:**
- Create: `scripts/run-acp-e2e.mjs`
- Create: `scripts/run-acp-e2e.test.mjs`
- Modify: `playwright.config.ts`
- Modify: `package.json`

- [ ] **Step 1: Add failing tests for environment construction and cleanup**

Export small pure helpers from the runner module and test:

```js
const env = buildAcpE2eEnv({
  home: "/tmp/home",
  fixture: "/repo/e2e/fixtures/acp-agent.mjs",
  port: 41234,
  projectA: "/tmp/a",
  projectB: "/tmp/b",
  artifactDir: "/tmp/artifacts",
});
assert.equal(env.GROK_HOME, "/tmp/home");
assert.equal(env.GROK_BIN, "/repo/e2e/fixtures/acp-agent.mjs");
assert.equal(env.GROK_WEB_E2E_PORT, "41234");
assert.equal(env.GROK_WEB_E2E_PROJECT_A, "/tmp/a");
```

Inject a child launcher into `runAcpE2e()` and assert `finally` terminates the process group and removes temp home/projects when the child exits nonzero. Assert arguments after `npm run test:e2e:acp --` are forwarded unchanged to the Playwright CLI so focused `--grep` runs work.

- [ ] **Step 2: Verify RED**

```bash
node --experimental-strip-types --test --test-concurrency=1 scripts/run-acp-e2e.test.mjs
```

- [ ] **Step 3: Implement runner-owned isolation**

The runner must:

1. create a temporary Grok home, two temporary Git projects, fixture log/control files, and artifact directory;
2. allocate an available loopback port;
3. set `GROK_BIN`, `GROK_HOME`, project paths, fixture paths, and `CI=1`/no-reuse marker;
4. spawn Playwright as a child process without `shell: true`, appending runner CLI arguments unchanged;
5. on every exit terminate browser/server/fixture descendants and remove temp resources;
6. preserve only the runner-owned redacted artifact directory on failure.

Use the Node-resolved Playwright CLI, not platform-specific `.bin` shell syntax.

- [ ] **Step 4: Make Playwright obey runner isolation**

```ts
const isolated = process.env.GROK_WEB_E2E_ISOLATED === "1";
const port = Number(process.env.GROK_WEB_E2E_PORT || 30143);
// ...
reuseExistingServer: isolated ? false : !process.env.CI,
trace: "retain-on-failure",
screenshot: "only-on-failure",
```

Ensure `webServer.command` receives the runner's port and inherited fixture environment.

Add scripts:

```json
"test:e2e:acp": "node scripts/run-acp-e2e.mjs",
"test:e2e": "node scripts/run-acp-e2e.mjs"
```

- [ ] **Step 5: Run and commit**

```bash
node --experimental-strip-types --test --test-concurrency=1 scripts/run-acp-e2e.test.mjs
npm run test:e2e:acp
git add scripts/run-acp-e2e.mjs scripts/run-acp-e2e.test.mjs playwright.config.ts package.json
git commit -m "test: isolate browser ACP end-to-end runs"
```

---

### Task 3: Add secret-safe failure evidence

**Files:**
- Create: `scripts/e2e-artifacts.mjs`
- Create: `scripts/e2e-artifacts.test.mjs`
- Modify: `scripts/run-acp-e2e.mjs`
- Create: `e2e/helpers/harness.ts`

- [ ] **Step 1: Add failing redaction/allowlist tests**

```js
const unsafe = {
  method: "session/prompt",
  cwd: "/Users/person/private/repo",
  authorization: "Bearer secret-token",
  apiKey: "sk-secret",
  prompt: "private user prompt",
  testId: "stream-text",
};
const safe = safeArtifactEvent(unsafe, { roots: new Map([["/tmp/a", "<project-a>"]]) });
assert.deepEqual(safe, { method: "session/prompt", testId: "stream-text" });
assert.doesNotMatch(JSON.stringify(safe), /secret|private user|\/Users\/person/);
```

Test text redaction for bearer/basic authorization, API-key/password/token assignments, URL credentials, fixture/home/project roots, and unknown absolute paths.

- [ ] **Step 2: Verify RED**

```bash
node --experimental-strip-types --test --test-concurrency=1 scripts/e2e-artifacts.test.mjs
```

- [ ] **Step 3: Implement allowlisted evidence**

`safeArtifactEvent()` constructs a new object from allowed keys; it never clones then scrubs arbitrary input. `redactE2eText()` handles stderr/chronology and replaces test roots with aliases before masking unknown paths/secrets.

The browser helper may register owned session IDs, query fixture control/log endpoints/files through runner-safe APIs, capture response status/method chronology, delete owned sessions, and assert pollution. It must not read auth files or dump environment/storage state.

- [ ] **Step 4: Integrate failure-only artifact writing**

On runner failure write bounded redacted `chronology.json`, `server.log`, and `fixture.log`, then leave Playwright trace/screenshots under the same artifact root. Deterministic prompts use public markers only.

- [ ] **Step 5: Run and commit**

```bash
node --experimental-strip-types --test --test-concurrency=1 scripts/e2e-artifacts.test.mjs scripts/run-acp-e2e.test.mjs
git add scripts/e2e-artifacts.mjs scripts/e2e-artifacts.test.mjs scripts/run-acp-e2e.mjs e2e/helpers/harness.ts
git commit -m "test: redact ACP browser failure evidence"
```

---

### Task 4: Cover deterministic core browser flows

**Files:**
- Create: `e2e/acp-core.spec.ts`
- Modify: `e2e/fixtures/acp-agent.mjs`
- Modify: `e2e/helpers/harness.ts`

- [ ] **Step 1: Add failing New Task and real SSE tests**

The first scenario selects runner project A through the UI, sends `E2E_TEXT_MARKER`, waits for `/api/agent/:id/events`, and asserts fixture log ordering:

```ts
await expect.poll(() => fixtureMethods(testId)).toEqual([
  "initialize",
  "session/new",
  "session/prompt",
]);
await expect(page.getByText("E2E_STREAM_OK", { exact: true })).toBeVisible();
expect(observedSseTypes).toContain("session_snapshot");
expect(observedSseTypes).toContain("message_update");
```

- [ ] **Step 2: Add thought/text/tool scenarios**

Emit split thinking/text chunks and assert one settled assistant message. Emit tool start/update/end and assert tool name, progress, terminal state, and safe result presentation.

- [ ] **Step 3: Add connected-tab approve and deny scenarios**

Fixture sends one permission per test. Click the actual confirmation buttons and assert the fixture records the exact JSON-RPC result once.

- [ ] **Step 4: Add stop/draft recovery**

Pause a turn, click Stop, assert `session/cancel`, stopped UI, and restored/resendable user draft according to the stage B contract.

- [ ] **Step 5: Cleanup and commit**

After each test close/delete only registered sessions and assert `/api/sessions` has no runner cwd/ID. Run:

```bash
npm run test:e2e:acp -- --grep "ACP core"
git add e2e/acp-core.spec.ts e2e/fixtures/acp-agent.mjs e2e/helpers/harness.ts
git commit -m "test: exercise core Grok ACP browser flows"
```

---

### Task 5: Cover deterministic reconnect, multi-tab, and workspace isolation

**Files:**
- Create: `e2e/acp-recovery.spec.ts`
- Modify: `e2e/fixtures/acp-agent.mjs`
- Modify: `e2e/helpers/harness.ts`

- [ ] **Step 1: Add partial reconnect scenario**

Pause after `E2E_PAR`, force-close the page EventSource/network connection through the harness, wait for reconnect snapshot, release `TIAL_OK`, and assert the final text appears exactly once.

- [ ] **Step 2: Add approval race scenario**

Open a second page/context on the same running session. Wait until both show the same request ID, click opposite responses concurrently, and assert one ACP result, one browser `409 already_resolved`, and both dialogs close.

- [ ] **Step 3: Add cwd isolation scenario**

Create/open project A and B sessions, read MCP and Plugins in each settings context, and assert fixture log entries use the matching distinct session/cwd alias. An unrelated preloaded session must not appear.

- [ ] **Step 4: Add mode capability scenario**

Advertise `high` and `off`, accept both, then reject a deliberately unsupported mode from the fixture. Assert UI rollback and no phantom selected state.

- [ ] **Step 5: Repeat and commit**

```bash
for i in 1 2 3 4 5; do npm run test:e2e:acp -- --grep "ACP recovery" || exit 1; done
git add e2e/acp-recovery.spec.ts e2e/fixtures/acp-agent.mjs e2e/helpers/harness.ts
git commit -m "test: cover ACP reconnect and multi-tab recovery"
```

---

### Task 6: Guard and run the opt-in live Grok suite

**Files:**
- Create: `scripts/run-live-e2e.mjs`
- Create: `scripts/run-live-e2e.test.mjs`
- Create: `e2e/live.spec.ts`
- Modify: `package.json`

- [ ] **Step 1: Add failing preflight-before-spawn tests**

Inject `spawn` and assert it is never called when:

- `GROK_WEB_LIVE_E2E !== "1"`;
- home is absent, relative, nonexistent, or equals the default operator `~/.grok`;
- no real Grok binary is resolvable;
- dedicated home lacks OAuth methods and a top-level official API key.

Expected errors contain setup instructions but no secret values.

- [ ] **Step 2: Verify RED**

```bash
node --experimental-strip-types --test --test-concurrency=1 scripts/run-live-e2e.test.mjs
```

- [ ] **Step 3: Implement guarded preflight and live environment**

Resolve the real binary before replacing `GROK_HOME`, allowing an explicit `GROK_WEB_LIVE_E2E_GROK_BIN` for installations whose binary is outside the dedicated home. Reject the repository fixture path. Reuse `readGrokAuth(home)` and `hasGrokApiKey(home)` under `--experimental-strip-types` to check authentication without printing credentials.

Add:

```json
"test:e2e:live": "node --experimental-strip-types scripts/run-live-e2e.mjs"
```

- [ ] **Step 4: Implement one bounded live spec**

Use a temporary Git cwd and one owned session. Verify session creation, one `LIVE_E2E_MARKER` prompt, actual streaming text, and persisted history. Request a harmless read-only operation; approve it only if the model emits a permission. Read Plugins/MCP only when advertised/authenticated. Reconnect once.

Core auth/session/prompt failures fail. Optional tool/Plugins/MCP absence is recorded as capability evidence, not a passing substitute for core flow.

- [ ] **Step 5: Enforce cleanup and commit**

In `finally`, abort, positively close/delete the owned session, stop descendants, remove temporary cwd, and assert the dedicated home session API/index has no owned ID/cwd. Cleanup failure fails with the exact dedicated-home residual path.

```bash
node --experimental-strip-types --test --test-concurrency=1 scripts/run-live-e2e.test.mjs
npm run test:e2e:live  # expected preflight failure without explicit env
git add scripts/run-live-e2e.mjs scripts/run-live-e2e.test.mjs e2e/live.spec.ts package.json
git commit -m "test: add guarded live Grok browser verification"
```

---

### Task 7: Run deterministic browser E2E in CI

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `package.json` only if script naming changes

- [ ] **Step 1: Add the browser gate after unit/lint/typecheck**

```yaml
- name: Install Chromium
  run: npx playwright install --with-deps chromium
- name: Run deterministic ACP browser E2E
  run: npm run test:e2e:acp
- name: Upload redacted E2E evidence
  if: failure()
  uses: actions/upload-artifact@v4
  with:
    name: grok-web-acp-e2e
    path: .artifacts/e2e/
```

The artifact path must contain only runner-produced redacted files; never upload a temp/dedicated `GROK_HOME`.

- [ ] **Step 2: Add source/runner tests for CI boundaries**

Assert CI references `test:e2e:acp`, never `test:e2e:live`, and upload path is the redacted artifact directory.

- [ ] **Step 3: Run local CI-equivalent gates**

```bash
node --experimental-strip-types --test --test-concurrency=1 scripts/acp-e2e-fixture.test.mjs scripts/run-acp-e2e.test.mjs scripts/e2e-artifacts.test.mjs scripts/run-live-e2e.test.mjs
npm run test:e2e:acp
```

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml package.json scripts/*e2e*.test.mjs
git commit -m "ci: run deterministic ACP browser tests"
```

---

### Task 8: Stage C integrated verification

**Files:**
- Modify only for defects found by verification/review.

- [ ] **Step 1: Run full unit/static/build gates**

```bash
node --experimental-strip-types --test --test-concurrency=1 "app/**/*.test.mjs" "components/**/*.test.mjs" "hooks/**/*.test.mjs" "lib/**/*.test.mjs" "public/**/*.test.mjs" "src/**/*.test.mjs" "scripts/**/*.test.mjs"
npm run typecheck
npm run lint
git diff --check
GROK_WEB_TANSTACK_OUTPUT_DIR=/tmp/grok-web-stage-c npm run build:tanstack:standalone
```

- [ ] **Step 2: Run deterministic browser suite repeatedly**

```bash
for i in 1 2 3 4 5; do npm run test:e2e:acp || exit 1; done
```

Assert every run cleans its session/project/home and leaves only failure artifacts when a deliberately injected failure is tested.

- [ ] **Step 3: Run live preflight and one documented real test**

```bash
npm run test:e2e:live  # must fail before spawning without opt-in
GROK_WEB_LIVE_E2E=1 \
GROK_WEB_LIVE_E2E_HOME=/absolute/dedicated/authenticated/home \
GROK_WEB_LIVE_E2E_GROK_BIN=/absolute/path/to/grok \
npm run test:e2e:live
```

The real command must be supplied by the operator at execution time. If no dedicated credentials are provided, stage C is not accepted as live-verified.

- [ ] **Step 4: Request independent test/security review**

Review fixture fail-unknown behavior, process cleanup, default-home guard, authentication preflight, artifact allowlists, Playwright trace leakage, CI upload paths, and proof that scenarios observe real SSE/stdio methods.

- [ ] **Step 5: Stop at the stage gate**

Fix every Critical/Important finding and rerun. Do not merge, push, restart the main service, or begin stage D until the user approves stage C integration.