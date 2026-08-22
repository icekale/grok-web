# Real ACP Browser E2E Design

## Status

Approved during the 2026-08-22 design review. This is stage C and depends on the stable safety and reconnect contracts from stages A and B.

## Goal

Prove core Grok Web behavior through a real browser, the real HTTP/SSE gateway, and a real stdio child process on every CI run, plus an explicit opt-in path that repeats a bounded subset against an authenticated Grok Build installation.

## Two test layers

### Layer 1: deterministic CI ACP E2E

CI starts:

```text
Playwright Chromium -> real grok-web server -> real stdio child process
```

`GROK_BIN` points to a repository-owned executable fixture. The fixture is a minimal ACP protocol peer, not an imported in-process mock. It implements only methods and event timing required by the scenarios, fails unknown required calls, records method names and safe identifiers, and supports deterministic pauses for reconnect/race tests.

This layer uses a temporary `GROK_HOME`, temporary Git projects, a random port, and no network model call or secret.

Required scenarios:

1. create a session from the New Task flow and send a prompt;
2. render text and thinking deltas and settle a completed message;
3. render a tool call/result;
4. approve and deny a tool request in the browser;
5. disconnect after a partial message, reconnect, apply the snapshot, and finish without duplication;
6. open a second tab during a pending approval and verify first-response-wins behavior;
7. exercise project A/B MCP and Plugin reads and verify distinct session IDs/cwds in the fixture log;
8. switch an advertised thinking mode including `off`, and verify rejection rollback for an unsupported mode;
9. stop a running turn and preserve/restorable prompt state;
10. leave no fixture session visible in the normal project sidebar after cleanup.

The existing shell-load Playwright test remains a fast smoke but is no longer the only browser test.

### Layer 2: opt-in live Grok E2E

The live suite runs only when both are explicitly supplied:

- `GROK_WEB_LIVE_E2E=1`
- `GROK_WEB_LIVE_E2E_HOME=/absolute/path/to/a/dedicated/authenticated/grok-home`

It never falls back to the operator's default `~/.grok`. Invoking the live command without a dedicated home or with an unauthenticated home fails quickly with setup instructions; it is not reported as a passing skip.

The live runner uses the resolved real Grok binary, a random port, and a temporary Git project. It creates one test-owned session and performs a bounded flow:

- browser session creation;
- one minimal model prompt with a deterministic marker;
- streaming text observation;
- one harmless read-only tool request and browser approval when the active model produces it;
- final persisted-history verification;
- safe read-only Plugins/MCP listing when those capabilities are authenticated and advertised;
- basic browser reconnect.

Timing-dependent multi-tab races stay in the deterministic layer. The live test does not install plugins, alter MCP configuration, modify Provider settings, or use an everyday user home.

## Cleanup contract

Every runner tracks only resources it created. In `finally` it:

1. aborts a running test turn;
2. positively closes and deletes the test-owned session through the hardened stage A path;
3. stops browser, server, ACP, and fixture process groups;
4. removes temporary projects and temporary non-secret homes;
5. verifies no test cwd/session remains in the session API.

Cleanup failure fails the test and prints the exact residual path under the dedicated test home. It never deletes a pre-existing session or broad directory.

## Evidence and redaction

On failure, retain:

- Playwright trace and screenshot;
- browser console/page errors;
- route/status chronology;
- ACP method names, safe test IDs, and timing markers;
- server and fixture stderr.

Do not retain API keys, tokens, passwords, complete authentication files, full environment dumps, arbitrary user prompts, or undisguised paths outside the dedicated test roots. Redaction occurs before artifact writes.

## CI and commands

Normal CI installs Chromium and runs the deterministic E2E after unit tests, lint, and typecheck. The live suite is a separate explicit command and is not part of ordinary pull-request CI. A future secret-bearing protected workflow may call it, but this design does not add repository secrets or scheduled paid model calls.

Tests use one worker where shared ACP/process ordering matters. Random ports and temporary homes allow independent jobs without colliding with the developer's service on `30142`.

## Capability handling

The fixture advertises an explicit capability matrix per scenario. The browser must hide or reject unadvertised controls exactly as it would with a real Grok version. The live suite records the detected capabilities and only exercises optional read-only features when advertised, while core authentication/session/prompt failures remain failures.

## Verification

The stage is complete when:

- deterministic browser tests fail when the stdio fixture is absent or the expected ACP method is not called;
- the suite observes actual SSE frames rather than only DOM shell state;
- reconnect and approval-race tests are timing-controlled and non-flaky across repeated runs;
- CI runs the deterministic suite;
- the live command proves its dedicated-home guard before any Grok process starts;
- one documented local live run passes against the supported Grok CLI version;
- success and failure cleanup checks leave zero test session pollution;
- artifacts pass a secret/path redaction test.

## Non-goals

This stage is not a general ACP conformance suite, model-quality benchmark, load test, multi-tenant test, paid nightly workflow, or replacement for focused unit tests.