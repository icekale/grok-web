# Data and Remote Safety Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent official logout from damaging custom Provider credentials, require positive ACP ownership before session deletion, make core writes atomic, and harden remote/process boundaries.

**Architecture:** Keep all current file formats and reuse existing TOML section rewriting, `writePrivateFileAtomicSync`, request-peer, and runtime ownership primitives. Security checks fail closed at the shared boundary: top-level credential classification, ACP load/close before disk deletion, server startup bind validation, and a sanitized child environment.

**Tech Stack:** TypeScript, Node.js 22, TanStack Start/Nitro, Grok ACP stdio, `proper-lockfile`, Node test runner.

**Spec:** `docs/superpowers/specs/2026-08-22-data-remote-safety-hardening-design.md`

---

### Task 1: Isolate the official API key from model-section keys

**Files:**
- Modify: `lib/grok-settings/home-config.ts:145-219`
- Modify: `lib/grok-settings/home-config.test.mjs:75-143`
- Test: `lib/auth-http.test.mjs`

- [ ] **Step 1: Replace the old model-key expectations with failing isolation tests**

```js
it("does not treat model api_key values as official Grok authentication", () => {
  const home = mkdtempSync(join(tmpdir(), "grok-custom-key-"));
  writeFileSync(join(home, "config.toml"), `
[model."cpa/grok-4.6"]
api_key = "custom-secret"
`);
  assert.equal(hasGrokApiKey(home), false);
});

it("clearing the official key preserves every section-local key", () => {
  const home = mkdtempSync(join(tmpdir(), "grok-key-isolation-"));
  writeFileSync(join(home, "config.toml"), `api_key = "official"
[model."cpa/grok-4.6"]
api_key = "custom"
[mcp_servers.docs]
api_key = "mcp"
`);
  clearGrokApiKey(home);
  const text = readFileSync(join(home, "config.toml"), "utf8");
  assert.doesNotMatch(text, /official/);
  assert.match(text, /api_key = "custom"/);
  assert.match(text, /api_key = "mcp"/);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
node --experimental-strip-types --test --test-concurrency=1 lib/grok-settings/home-config.test.mjs lib/auth-http.test.mjs
```

Expected: the model-only fixture is incorrectly reported connected and `clearGrokApiKey()` removes `custom-secret`.

- [ ] **Step 3: Delete section-wide Grok key classification and operate on the preamble only**

```ts
export function hasGrokApiKey(home = grokHome()): boolean {
  const file = join(home, "config.toml");
  if (!existsSync(file)) return false;
  const { preamble } = splitTopLevelToml(readFileSync(file, "utf8"));
  return preamble.split(/\r?\n/).some((line) => apiKeyLineHasValue(line.trim()));
}

export function clearGrokApiKey(home = grokHome()): void {
  const file = join(home, "config.toml");
  if (!existsSync(file)) return;
  const { preamble, rest } = splitTopLevelToml(readFileSync(file, "utf8"));
  const kept = preamble.split(/\r?\n/).filter((line) => !/^api_key\s*=/.test(line.trim()));
  writePrivateFileAtomicSync(file, `${kept.join("\n")}${rest}`);
}
```

Remove `tomlSectionName()` and `isGrokApiKeySection()` if no callers remain.

- [ ] **Step 4: Add route-level regression assertions**

In `lib/auth-http.test.mjs`, seed a top-level official key plus two custom `[model.*]` keys, call the existing xAI delete and Grok logout handlers, and assert both custom keys remain after each route.

- [ ] **Step 5: Run tests and commit**

```bash
node --experimental-strip-types --test --test-concurrency=1 lib/grok-settings/home-config.test.mjs lib/auth-http.test.mjs lib/provider-api-key-route.test.mjs
git add lib/grok-settings/home-config.ts lib/grok-settings/home-config.test.mjs lib/auth-http.test.mjs
git commit -m "fix: isolate official Grok credentials"
```

Expected: all focused tests pass.

---

### Task 2: Upsert only Settings-managed model sections

**Files:**
- Modify: `lib/grok-model-table.ts:99-128`
- Modify: `lib/grok-model-table.test.mjs`

- [ ] **Step 1: Add failing repair and preservation tests**

```js
test("sync repairs an existing managed section without rewriting unknown sections", () => {
  const home = mkdtempSync(join(tmpdir(), "grok-model-repair-"));
  writeFileSync(join(home, "config.toml"), `[model."manual/model"]
model = "manual"
custom = "keep-byte-for-byte"

[model."cpa/grok-4.6"]
model = "grok-4.6"
base_url = "https://old.example/v1"
`);
  syncSettingsModelsToGrokConfig({ providers: { cpa: {
    api: "openai-responses",
    baseUrl: "https://new.example/v1",
    apiKey: "restored-key",
    models: [{ id: "grok-4.6" }],
  } } }, home);
  const text = readFileSync(join(home, "config.toml"), "utf8");
  assert.match(text, /\[model\."manual\/model"\][\s\S]*custom = "keep-byte-for-byte"/);
  assert.match(text, /\[model\."cpa\/grok-4\.6"\][\s\S]*base_url = "https:\/\/new\.example\/v1"/);
  assert.match(text, /api_key = "restored-key"/);
  assert.equal((text.match(/\[model\."cpa\/grok-4\.6"\]/g) ?? []).length, 1);
});
```

- [ ] **Step 2: Run the test and verify RED**

```bash
node --experimental-strip-types --test --test-concurrency=1 lib/grok-model-table.test.mjs
```

Expected: existing managed section is skipped and retains the old URL/missing key.

- [ ] **Step 3: Rewrite only targeted managed sections**

Use the existing `rewriteTomlSections()` callback to remove sections whose `settingsManagedPickerId(sectionName)` is in the current wanted set, append `renderGrokModelTable()` for every current row, and continue pruning deleted Settings-managed sections. Do not match unnamespaced/manual sections.

The resulting loop must have one action per row:

```ts
const managed = new Map(rows.map((row) => [grokSettingsPickerId(row, text), row]));
text = rewriteTomlSections(text, (sectionName) => {
  const pickerId = settingsManagedPickerId(sectionName);
  return !pickerId || !managed.has(pickerId);
});
for (const [pickerId, row] of managed) {
  const suffix = text.length === 0 || text.endsWith("\n") ? "" : "\n";
  text = `${text}${suffix}\n${renderGrokModelTable(row, pickerId)}`;
}
```

Return changed picker IDs only when serialized output differs, preserving the existing caller contract that triggers ACP recycle.

- [ ] **Step 4: Run model/config tests**

```bash
node --experimental-strip-types --test --test-concurrency=1 lib/grok-model-table.test.mjs lib/models-config-store.test.mjs lib/models-http.test.mjs lib/acp/runtime.test.mjs
```

Expected: all pass; unknown and native sections remain.

- [ ] **Step 5: Commit**

```bash
git add lib/grok-model-table.ts lib/grok-model-table.test.mjs
git commit -m "fix: repair managed Grok model sections"
```

---

### Task 3: Make credential and summary writes atomic

**Files:**
- Modify: `lib/provider-credential-store.ts:1-70`
- Create: `lib/provider-credential-store.test.mjs`
- Modify: `lib/session-http.ts:1-130`
- Modify: `lib/session-http.runtime.test.mjs`
- Reuse: `lib/atomic-file.ts`

- [ ] **Step 1: Add failing source-boundary and behavior tests**

```js
// lib/provider-credential-store.test.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./provider-credential-store.ts", import.meta.url), "utf8");
test("credential updates use the shared atomic writer inside the lock", () => {
  assert.match(source, /writePrivateFileAtomicSync\(authPath,/);
  assert.doesNotMatch(source, /writeFileSync\(authPath,/);
});
```

Extend `lib/session-http.runtime.test.mjs`:

```js
test("session rename uses the shared atomic writer", async () => {
  const source = await readFile(new URL("./session-http.ts", import.meta.url), "utf8");
  assert.match(source, /writePrivateFileAtomicSync\(join\(session\.path, "summary\.json"\)/);
  assert.doesNotMatch(source, /writeFileSync\(join\(session\.path, "summary\.json"\)/);
});
```

The existing `lib/atomic-file.test.mjs` remains the behavioral interrupted-write proof: injected rename failure leaves the destination unchanged.

- [ ] **Step 2: Verify RED**

```bash
node --experimental-strip-types --test --test-concurrency=1 lib/provider-credential-store.test.mjs lib/session-http.runtime.test.mjs lib/atomic-file.test.mjs
```

Expected: both new boundary tests fail.

- [ ] **Step 3: Replace direct writes with the existing helper**

```ts
import { writePrivateFileAtomicSync } from "./atomic-file";
// inside the existing proper-lockfile critical section
writePrivateFileAtomicSync(authPath, `${JSON.stringify(parsed, null, 2)}\n`);
```

In `session-http.ts`, import `writePrivateFileAtomicSync`, replace rename/auto-name summary writes, and remove `writeFileSync` if unused:

```ts
writePrivateFileAtomicSync(
  join(session.path, "summary.json"),
  `${JSON.stringify(body, null, 2)}\n`,
);
```

- [ ] **Step 4: Run focused tests**

```bash
node --experimental-strip-types --test --test-concurrency=1 lib/provider-credential-store.test.mjs lib/provider-listing.test.mjs lib/auth-http.test.mjs lib/session-http.runtime.test.mjs lib/session-http.test.mjs lib/atomic-file.test.mjs
```

- [ ] **Step 5: Commit**

```bash
git add lib/provider-credential-store.ts lib/provider-credential-store.test.mjs lib/session-http.ts lib/session-http.runtime.test.mjs
git commit -m "fix: atomically persist credentials and session titles"
```

---

### Task 4: Require ACP ownership before physical session deletion

**Files:**
- Modify: `lib/session-http.ts:262-272`
- Modify: `lib/session-http.test.mjs:100-125`
- Modify: `lib/session-http.runtime.test.mjs`
- Modify: `lib/acp/runtime.ts:225-229` only if `closeSession()` must expose a stable result

- [ ] **Step 1: Add dependency-injected failing deletion tests**

Define the planned test seam in `session-http.ts`:

```ts
type SessionDeleteRuntime = Pick<AgentRuntime, "hasSession" | "isBusy" | "loadSession" | "closeSession">;
```

Write tests for: already-busy, external load failure, close failure, unloaded load+close success, and already-owned idle success. Example:

```js
const runtime = {
  hasSession: () => false,
  isBusy: () => false,
  loadSession: async () => { throw new Error("already loaded elsewhere"); },
  closeSession: async () => ({ outcome: "closed" }),
};
const response = await deleteSession(id, runtime);
assert.equal(response.status, 409);
assert.equal(existsSync(dir), true);
assert.equal((await response.json()).code, "session_in_use");
```

For success, record calls and assert `load:<id>` then `close:<id>` precede removal.

- [ ] **Step 2: Run and verify RED**

```bash
node --experimental-strip-types --test --test-concurrency=1 lib/session-http.test.mjs lib/session-http.runtime.test.mjs
```

Expected: current function ignores ownership failures and deletes the directory.

- [ ] **Step 3: Implement the fail-closed algorithm**

```ts
export async function deleteSession(
  id: string,
  runtime: SessionDeleteRuntime = getAgentRuntime(),
): Promise<Response> {
  const session = await findGrokSession(id);
  if (!session) return Response.json({ error: "Session not found" }, { status: 404 });
  if (runtime.hasSession(id) && runtime.isBusy(id)) {
    return Response.json({ error: "Session is running", code: "session_busy" }, { status: 409 });
  }
  try {
    if (!runtime.hasSession(id)) await runtime.loadSession(id, session.cwd);
    await runtime.closeSession(id);
  } catch {
    return Response.json({ error: "Session is in use", code: "session_in_use" }, { status: 409 });
  }
  rmSync(session.path, { recursive: true, force: true });
  invalidateSessionListCache();
  return Response.json({ ok: true, id });
}
```

Use the existing runtime methods; do not add force deletion.

- [ ] **Step 4: Update the old delete test to inject an owned runtime and run focused tests**

```bash
node --experimental-strip-types --test --test-concurrency=1 lib/session-http.test.mjs lib/session-http.runtime.test.mjs lib/acp/runtime.test.mjs components/DialogConfirmations.test.mjs
```

- [ ] **Step 5: Commit**

```bash
git add lib/session-http.ts lib/session-http.test.mjs lib/session-http.runtime.test.mjs lib/acp/runtime.ts
git commit -m "fix: refuse unowned session deletion"
```

---

### Task 5: Enforce the bind guard inside the server runtime

**Files:**
- Create: `lib/server-bind.ts`
- Create: `lib/server-bind.test.mjs`
- Modify: `src/server.ts:1-13`
- Modify: `lib/tanstack-server-startup.test.mjs`

- [ ] **Step 1: Add failing runtime-bind tests**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { assertServerBindAllowed } from "./server-bind.ts";

test("direct Nitro non-loopback bind requires a password", () => {
  assert.throws(() => assertServerBindAllowed({ NITRO_HOST: "0.0.0.0" }, false), /refuses|password/i);
  assert.doesNotThrow(() => assertServerBindAllowed({ NITRO_HOST: "127.0.0.1" }, false));
  assert.doesNotThrow(() => assertServerBindAllowed({ NITRO_HOST: "0.0.0.0" }, true));
});
```

Add a source assertion that `src/server.ts` calls this guard before `createServerEntry()`.

- [ ] **Step 2: Verify RED**

```bash
node --experimental-strip-types --test --test-concurrency=1 lib/server-bind.test.mjs lib/tanstack-server-startup.test.mjs
```

- [ ] **Step 3: Implement one small shared runtime guard**

```ts
import { assertBindAllowed } from "./bind-guard";

export function assertServerBindAllowed(
  env: Pick<NodeJS.ProcessEnv, "NITRO_HOST" | "HOST" | "GROK_WEB_HOSTNAME"> = process.env,
  passwordEnabled: string | boolean | undefined,
): void {
  const host = env.NITRO_HOST || env.GROK_WEB_HOSTNAME || env.HOST || "127.0.0.1";
  assertBindAllowed(host, passwordEnabled);
}
```

At module initialization in `src/server.ts`, call it with `process.env.GROK_WEB_PASSWORD || isWebPasswordEnabled()` before constructing the server entry.

- [ ] **Step 4: Test direct startup behavior**

Extend `lib/tanstack-server-startup.test.mjs` to spawn the built server with a temporary `GROK_HOME`, `NITRO_HOST=0.0.0.0`, no password, and assert non-zero exit plus no listening port. Retain the loopback startup case.

- [ ] **Step 5: Run and commit**

```bash
node --experimental-strip-types --test --test-concurrency=1 lib/bind-guard.test.mjs lib/server-bind.test.mjs lib/tanstack-server-startup.test.mjs lib/tanstack-request-security.test.mjs
git add lib/server-bind.ts lib/server-bind.test.mjs src/server.ts lib/tanstack-server-startup.test.mjs
git commit -m "fix: enforce remote bind security in server runtime"
```

---

### Task 6: Pass the proven socket peer to remote password removal

**Files:**
- Modify: `lib/remote-access-http.ts:1-50`
- Modify: `src/routes/api/remote-access.ts:1-12`
- Modify: `lib/remote-access-http.test.mjs`
- Reuse: `src/request-peer.server.ts`

- [ ] **Step 1: Add a failing true-loopback password-clear test**

```js
const cleared = await PUT(localRequest("PUT", {
  allowedHosts: [],
  password: null,
}), { peerAddress: "127.0.0.1" });
assert.equal(cleared.status, 200);
assert.equal((await cleared.json()).passwordConfigured, false);
```

Keep the remote-peer case and pass `{ peerAddress: "192.168.1.8" }`, expecting `403`.

- [ ] **Step 2: Verify RED**

```bash
node --experimental-strip-types --test --test-concurrency=1 lib/remote-access-http.test.mjs lib/request-security.test.mjs
```

Expected: the handler ignores the supplied peer and rejects the real loopback clear.

- [ ] **Step 3: Thread peerAddress from the server route**

```ts
export async function PUT(req: Request, context: { peerAddress?: string } = {}) {
  // ...
  loopbackRequest: isLoopbackApiRequest(req, context.peerAddress),
}
```

```ts
import { requestPeerAddress } from "@/src/request-peer.server";
PUT: ({ request }) => putRemoteAccess(request, { peerAddress: requestPeerAddress() }),
```

Do not read `x-forwarded-for`.

- [ ] **Step 4: Run route/security tests and commit**

```bash
node --experimental-strip-types --test --test-concurrency=1 lib/remote-access-http.test.mjs lib/remote-access-config.test.mjs lib/request-security.test.mjs lib/tanstack-request-security.test.mjs
git add lib/remote-access-http.ts src/routes/api/remote-access.ts lib/remote-access-http.test.mjs
git commit -m "fix: prove loopback before clearing remote password"
```

---

### Task 7: Sanitize the Grok child environment and dispose runtime on shutdown

**Files:**
- Modify: `lib/acp/process.ts`
- Modify: `lib/acp/process.test.mjs`
- Modify: `lib/acp/runtime.ts:897-917,1047-1070`
- Modify: `src/server.ts`

- [ ] **Step 1: Add failing environment tests**

```js
import { grokAgentEnv } from "./process.ts";

test("grok agent env removes web ingress secrets but keeps provider variables", () => {
  const env = grokAgentEnv({
    GROK_WEB_PASSWORD: "web-secret",
    GROK_HOME: "/tmp/grok",
    CPA_API_KEY: "provider-secret",
    PATH: "/bin",
  });
  assert.equal(env.GROK_WEB_PASSWORD, undefined);
  assert.equal(env.GROK_HOME, "/tmp/grok");
  assert.equal(env.CPA_API_KEY, "provider-secret");
  assert.equal(env.PATH, "/bin");
});
```

Add a runtime spawn-boundary assertion that `connectDefault()` passes `env: grokAgentEnv()`.

- [ ] **Step 2: Verify RED**

```bash
node --experimental-strip-types --test --test-concurrency=1 lib/acp/process.test.mjs lib/acp/runtime.test.mjs
```

- [ ] **Step 3: Implement minimal environment sanitization**

```ts
export function grokAgentEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  delete env.GROK_WEB_PASSWORD;
  return env;
}
```

Use it in `spawn(bin, grokAgentArgs(), { stdio, env: grokAgentEnv() })`.

- [ ] **Step 4: Add an idempotent runtime dispose path**

`AgentRuntime.dispose()` aborts active terminals, closes JSON-RPC, terminates its owned child, clears connection subscriptions, and is safe to call twice. Export `disposeAgentRuntime()` for server shutdown without creating a singleton.

Wire the supported Nitro/TanStack shutdown hook in `src/server.ts`; do not register a second competing signal handler inside every request module.

- [ ] **Step 5: Test and commit**

```bash
node --experimental-strip-types --test --test-concurrency=1 lib/acp/process.test.mjs lib/acp/runtime.test.mjs lib/tanstack-server-startup.test.mjs
git add lib/acp/process.ts lib/acp/process.test.mjs lib/acp/runtime.ts src/server.ts
git commit -m "fix: isolate and dispose the Grok child process"
```

---

### Task 8: Forward wrapper shutdown signals

**Files:**
- Modify: `bin/grok-web.js:67-127`
- Modify: `lib/tanstack-cli.test.mjs`
- Modify: `scripts/smoke-installed-package.mjs`

- [ ] **Step 1: Add failing wrapper lifecycle coverage**

In `lib/tanstack-cli.test.mjs`, require `SIGINT`, `SIGTERM`, `child.kill`, and a bounded force timer in the wrapper source.

In `scripts/smoke-installed-package.mjs`, after the installed server is healthy, signal the wrapper PID only, wait for exit, then assert the port closes and no recorded Nitro child remains. Remove the process-group kill as the success path; retain it only in test cleanup.

- [ ] **Step 2: Verify RED against the packaged smoke**

```bash
node --experimental-strip-types --test --test-concurrency=1 lib/tanstack-cli.test.mjs
npm run pack:tanstack
node scripts/smoke-installed-package.mjs
```

Expected: wrapper-only signal leaves the child serving or source expectations fail.

- [ ] **Step 3: Implement one idempotent shutdown function**

```js
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) {
    child.kill("SIGKILL");
    return;
  }
  shuttingDown = true;
  child.kill(signal);
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  timer.unref();
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(signal));
}
```

Clear the timer on child exit and preserve child/signal exit semantics.

- [ ] **Step 4: Run CLI/package tests and commit**

```bash
node --experimental-strip-types --test --test-concurrency=1 lib/tanstack-cli.test.mjs lib/tanstack-output.test.mjs
npm run pack:tanstack
node scripts/smoke-installed-package.mjs
git add bin/grok-web.js lib/tanstack-cli.test.mjs scripts/smoke-installed-package.mjs
git commit -m "fix: forward grok-web shutdown signals"
```

---

### Task 9: Stage A integrated verification

**Files:**
- Modify only if a verification failure identifies a stage A defect.

- [ ] **Step 1: Run all changed-path tests**

```bash
node --experimental-strip-types --test --test-concurrency=1 \
  lib/grok-settings/home-config.test.mjs \
  lib/grok-model-table.test.mjs \
  lib/auth-http.test.mjs \
  lib/provider-credential-store.test.mjs \
  lib/atomic-file.test.mjs \
  lib/session-http.test.mjs \
  lib/session-http.runtime.test.mjs \
  lib/server-bind.test.mjs \
  lib/remote-access-http.test.mjs \
  lib/request-security.test.mjs \
  lib/acp/process.test.mjs \
  lib/acp/runtime.test.mjs \
  lib/tanstack-cli.test.mjs \
  lib/tanstack-server-startup.test.mjs
```

Expected: zero failures.

- [ ] **Step 2: Run complete static and unit gates**

```bash
node --experimental-strip-types --test --test-concurrency=1 "app/**/*.test.mjs" "components/**/*.test.mjs" "hooks/**/*.test.mjs" "lib/**/*.test.mjs" "public/**/*.test.mjs" "src/**/*.test.mjs" "scripts/**/*.test.mjs"
npm run typecheck
npm run lint
git diff --check
```

Expected: zero test/type/lint errors; only the documented existing warnings may remain.

- [ ] **Step 3: Build and smoke the standalone/package outputs**

```bash
GROK_WEB_TANSTACK_OUTPUT_DIR=/tmp/grok-web-stage-a npm run build:tanstack:standalone
node scripts/smoke-tanstack-output.mjs /tmp/grok-web-stage-a
npm run pack:tanstack
node scripts/smoke-installed-package.mjs
```

Expected: all route probes pass, unauthenticated LAN startup fails closed, loopback startup succeeds, and wrapper shutdown leaves no listener/ACP child.

- [ ] **Step 4: Request independent review**

Review against `docs/superpowers/specs/2026-08-22-data-remote-safety-hardening-design.md`, focusing on credential loss, ownership proof, atomicity, secret inheritance, and shutdown races. Fix every Critical/Important finding and rerun affected gates.

- [ ] **Step 5: Commit verification-only fixes, if any**

```bash
git status --short
git log --oneline --decorate -10
```

Do not merge, push, restart the main service, or proceed to stage B until the stage A branch is clean and the user approves integration.