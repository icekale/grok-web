# Empty Session Sidebar Pollution Fix Design

## Problem

Standalone/package route smoke probes call the successful MCP and plugin list routes with a temporary cwd. Those handlers enter `AgentRuntime.withSession()`, which creates a real Grok ACP session when the fresh smoke server has no loaded session. The smoke process inherits the operator's real `GROK_HOME`, so each run persists an empty session under `~/.grok/sessions` even though the temporary cwd is later removed.

Grok writes these tool-only sessions with no title, no user history, and `num_messages: 0`. The session index currently substitutes `(no messages)` and returns them, so the sidebar discovers and renders every temporary smoke cwd as a project/session row.

Opening Plugins or MCP on a freshly restarted normal server can reach the same tool-session path, so smoke isolation alone is not a complete UI defense.

## Considered Approaches

1. **Change smoke probes only.** Probe MCP and Plugins without `cwd` and expect their documented `400` response. This stops bulk test pollution but still allows normal tool-only sessions to appear.
2. **Hide empty sessions only.** Prevents sidebar clutter but leaves avoidable smoke writes to the operator's real Grok state.
3. **Combined fix — selected.** Make route smoke non-mutating and exclude unmistakably empty tool sessions from the persisted session index.

## Design

### Non-mutating route smoke

In `scripts/tanstack-route-smoke.mjs`, probe `GET /api/mcp` and `GET /api/plugins` without a cwd and expect `400`. The adapter inventory remains covered, while the handlers return before invoking ACP or creating a session.

Successful MCP/plugin behavior remains covered by their focused handler tests; route smoke only verifies that the packaged route is mounted and responds with the documented validation status.

### Empty-session indexing guard

In `lib/session-index.ts`, return no session for a persisted entry only when all of these are true:

- Grok explicitly reports `num_messages: 0`;
- `session_summary` is empty;
- `generated_title` is empty;
- no first user title can be recovered from `updates.jsonl`.

This deliberately keeps:

- sessions with real history even if Grok omitted the summary;
- manually/generated named sessions;
- older summaries that do not contain `num_messages`;
- all normal and subagent sessions with content.

The guard belongs in the shared session index rather than the sidebar component so every session-list consumer receives the same clean persisted view.

## Data and Cleanup

The fix does not delete existing session directories. Automatic deletion would be a data-loss risk and is unnecessary after the user has already removed the visible rows. Empty group directories left behind by Grok are harmless because the index only reads child directories containing a valid `summary.json`.

## Tests

Use test-first changes:

1. Extend the route-smoke source test to require validation-only MCP/plugin GET probes and reject fixture-cwd probes for those routes. Confirm it fails against the current script.
2. Extend `lib/session-index.test.mjs` with an empty tool session (`num_messages: 0`, blank summary/title/history) and assert it is omitted while a zero-message named session remains visible. Confirm it fails against the current index.
3. Apply the minimum production changes and run the focused tests, full single-threaded test suite, typecheck, lint, `git diff --check`, standalone build, and a browser/sidebar check.

## Non-goals

- No ACP protocol changes.
- No new session kind or persistence schema.
- No background cleanup job.
- No deletion of existing Grok sessions.
- No changes to normal new-task or first-prompt behavior.
