# ACP Workspace Routing and Recovery Design

## Status

Approved during the 2026-08-22 design review. This is stage B and depends on stage A safety hardening.

## Goal

Make workspace-scoped ACP operations deterministic and make active conversations and approvals recoverable after SSE reconnects or a second browser tab, while correcting the false local-only `thinking=off` state.

## Scope

This stage includes:

- exact cwd-to-session routing for MCP, Plugins, and Marketplace operations;
- concurrent per-cwd tool-session initialization deduplication;
- an authoritative SSE session snapshot containing the in-flight message and pending approvals;
- first-response-wins approval resolution across tabs;
- reconnect reconciliation when the terminal event was missed;
- capability-backed thinking levels, including real ACP handling of `off`.

It does not create a second session store, add event-log replay, retain an unbounded event history, implement arbitrary plugin Extension UI, or introduce a process pool.

## Deterministic workspace session routing

Replace the global first-loaded-session fallback with one shared workspace-session helper.

1. Canonicalize the requested cwd using the same path rules as project/file authorization.
2. Reuse a loaded session only when its canonical cwd exactly matches.
3. If no match exists, create one workspace tool session for that cwd and record the mapping.
4. Deduplicate concurrent initialization for the same cwd with one in-flight promise.
5. Never use a session from another cwd as a fallback.

The helper is used by MCP list/toggle/upsert/delete and Plugins/Marketplace list/actions. Sessions created solely for workspace tools remain explicit zero-user-message sessions and are hidden by the existing conservative shared session-index rule. They are not silently deleted as user data.

Runtime recycle clears the in-memory cwd mapping. A later request reconstructs it from loaded sessions or creates a new matching tool session.

## Authoritative session snapshot

The SSE stream keeps the existing listener-before-snapshot ordering. Its first state frame becomes an additive `session_snapshot` event with:

- session ID and current prompt generation;
- busy/running state;
- the current `AcpTurnMapper.snapshot()` partial assistant message;
- queued steering and follow-up items;
- pending permission requests for this session;
- selected model and advertised/selected mode;
- tool presets and context usage already available from runtime state.

The snapshot is bounded to current active state; it is not a transcript copy. Live text, thinking, tool, queue, permission-resolution, and agent-end events follow it.

The client applies the snapshot idempotently. A partial message replaces the current in-flight block for the same prompt generation before later deltas are appended. It must not duplicate already-persisted completed messages.

If reconnect shows the session is no longer busy while the client still believes a turn is active, the client reloads session detail and settles the local prompt. This repairs a missed terminal event without replaying the whole SSE stream.

## Pending approval snapshot

`AcpConnection` exposes a read-only, session-filtered snapshot of unresolved permission requests. Each safe UI record includes request/session IDs, translated title/message/options, and the original expiry time. Reading or reconnecting does not reset the timeout.

Resolution is atomic at the connection layer:

1. The first valid confirm/cancel removes the pending request and responds to ACP.
2. Runtime broadcasts `permission_resolved` for that request to every subscriber.
3. Other tabs close the matching dialog.
4. A later response returns `409 already_resolved`; it never sends a second JSON-RPC response.
5. Timeout follows the same resolved broadcast path with a cancelled result.

No snapshot exposes raw secrets beyond the existing translated permission UI payload.

## Thinking-level semantics

The WebUI no longer invents a selected level that ACP did not accept.

- The model/mode picker only shows levels advertised by ACP/model metadata.
- Every user selection, including `off`, calls ACP `session/set_mode`.
- Success updates runtime and UI state from the ACP result.
- Rejection leaves the prior level selected and displays an explicit capability error.
- Models with no advertised reasoning modes show no mode control.

There is no special `off` short circuit.

## Standard Plan boundary

This stage only transports standard ACP state. Arbitrary plugin widgets, forms, and Extension UI requests remain out of scope. Standard Plan/mode support may consume the same advertised-mode and snapshot mechanisms in stage D; the existing unreachable custom-widget path is not treated as proof of Plan support.

## Error contract

- invalid or unauthorized cwd: `400` or `403` before any session creation;
- ACP authentication/capability failure: explicit `401`/`503` or capability error, with no cross-cwd fallback;
- already-resolved approval: `409 already_resolved`;
- reconnect timeout: preserve the composer draft and offer retry;
- malformed snapshot: reject that frame and continue/reconnect without corrupting persisted history.

## Compatibility

The disk session format is unchanged. SSE adds event types consumed by the same-version frontend and server deployment. Existing delta events remain unchanged. There is no promise of a pi-web-compatible external SSE contract.

## Verification

TDD coverage must prove:

- project A and B operations use different matching ACP sessions;
- a previously loaded unrelated session is never selected;
- simultaneous requests for one new cwd create only one tool session;
- invalid cwd creates no session;
- reconnect snapshot contains and restores a partial text/thinking/tool message;
- listener/snapshot ordering cannot lose an update emitted during connection setup;
- reconnect after a missed agent-end reloads completed history;
- pending approval appears in a new tab without extending its deadline;
- two tabs racing to respond produce one ACP response, one resolution broadcast, and one `409` loser;
- timeout broadcasts the same terminal state;
- `off` calls ACP when advertised and UI rollback occurs on rejection;
- unadvertised levels are absent from the picker.

Stage validation adds a minimal stdio ACP fixture only for the reconnect and multi-workspace browser checks required by this stage. Stage C then promotes and expands that fixture into the complete CI harness. The gate also requires complete single-threaded tests, typecheck, lint, build, route smoke, and a no-empty-sidebar check.

## Release boundary

This stage ships independently after stage A. It does not add new CLI startup flags or the live-test credential workflow.