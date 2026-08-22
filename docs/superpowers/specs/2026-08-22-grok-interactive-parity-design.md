# Grok Interactive Capability Parity Design

## Status

Approved during the 2026-08-22 design review. This is stage D and depends on stages A-C.

## Goal

Expose Grok Build capabilities that matter in an interactive browser workflow—Sandbox, permission policy, Agent selection/profile, standard Plan/modes, and safe restore-code—without reproducing terminal presentation, headless automation formats, arbitrary plugin Extension UI, or a multi-process per-project Agent pool.

## Product boundary

Included:

- one global Grok Web Runtime Profile;
- discovered Agent selection and a validated Agent profile path option;
- Sandbox profile;
- permission mode plus allow/deny rules;
- Web Search and Subagent enable/disable controls;
- max turns and extra rules;
- standard ACP-advertised Plan/modes;
- restore-code into a new worktree;
- capability-based UI and explicit unsupported states.

Excluded:

- fullscreen/minimal/alternate-screen TUI behavior;
- shell completion and terminal doctor;
- headless `output-format`, streaming wire formats, and JSON Schema automation;
- arbitrary plugin widgets/forms/custom Extension UI;
- per-project or per-session Agent process pools;
- probing arbitrary undeclared private RPC methods beyond the narrow restore-code exception below;
- multi-tenant or remote sandbox infrastructure.

## Runtime Profile

The only new persistent file is `~/.grok/grok-web/runtime-profile.json`. Absence preserves today's default `grok agent stdio` behavior.

Version 1 stores non-secret values equivalent to:

```json
{
  "version": 1,
  "agent": null,
  "agentProfilePath": null,
  "sandbox": null,
  "permissionMode": "default",
  "allow": [],
  "deny": [],
  "disableWebSearch": false,
  "disableSubagents": false,
  "maxTurns": null,
  "rules": null
}
```

`agent` is a name returned by `grok inspect --json`. `agentProfilePath`, when used instead, must be an existing regular file inside `GROK_HOME` or an explicitly trusted project root. The two fields are mutually exclusive. Rule arrays are bounded strings with duplicate/conflict validation. `maxTurns` is a positive bounded integer. The profile never stores credentials, Provider keys, remote passwords, or arbitrary environment values.

## Capability discovery

Capability discovery is cached per resolved Grok binary version/mtime and combines:

- `grok --help` for global options such as sandbox, permission mode, allow/deny, rules, max turns, restore-code, worktree, Web Search, and Subagent switches;
- `grok agent --help` for Agent-level options such as Agent profile and leader behavior;
- `grok agent stdio --help` for stdio-level options;
- `grok inspect --json` for discovered Agents and configuration sources;
- ACP initialize, model metadata, and config options for session-level model/mode/tools/worktree/fork capabilities.

Parsing only recognizes exact known option tokens and validated JSON fields. An absent capability hides or disables its control with “current Grok version does not support this capability.” The only private-RPC exception is the existing, contract-tested restore path described below; the implementation does not discover or call any other undeclared private method.

## Process argument construction

Arguments preserve CLI command hierarchy:

```text
grok [validated global flags]
  agent [validated agent flags]
  stdio [validated stdio flags]
```

Arguments are a structured argv, never a shell string. Values are passed as separate argv entries. Conflicting flags are rejected before persistence.

## Applying a Runtime Profile

1. Validate the request, discovered capabilities, paths, bounds, and flag conflicts.
2. If any session or terminal is busy, return `409 runtime_busy` and do not write.
3. Atomically save the candidate profile while retaining the old in-memory value.
4. Gracefully stop the old ACP process.
5. Start and initialize a candidate process with the new argv.
6. On success, reload recoverable idle sessions and publish the new capability state.
7. On failure, atomically restore the previous profile and restart the previous argv.
8. If rollback also fails, expose a degraded state with the exact sanitized startup error; never claim the candidate is active.

The UI shows a restart-required confirmation and never force-aborts active work to apply settings.

## Settings UI

Add an Agent Runtime settings destination using existing settings navigation and form patterns. Controls appear only when supported:

- Agent selector from inspect output;
- optional trusted Agent profile file;
- Sandbox profile;
- permission mode;
- repeatable allow and deny rules;
- disable Web Search and disable Subagents;
- max turns;
- extra rules;
- detected Grok version and capability summary;
- Save and safely restart ACP.

Validation is inline and server-authoritative. Advanced controls explain that they affect all Grok Web sessions, not the TUI process already running elsewhere.

## Standard Plan/mode support

Plan is exposed only when ACP advertises a standard mode/config option that Grok Web can set and read back. It uses the same capability-backed mode state and reconnect snapshot as stage B. Existing custom widget consumers are not treated as a generic Extension UI implementation.

If the backend does not advertise Plan, the WebUI states that the current Grok version does not expose Web-compatible Plan mode rather than showing a non-functional panel.

## Safe restore-code flow

Restore-code is an explicit session action and always targets a new worktree.

1. Read the historical session's indexed cwd, git root, head commit/branch, and capability state.
2. Require a valid Git project and advertised CLI restore/worktree support. Run the existing read-only `_x.ai/git/worktree/list` contract as the ACP worktree capability check.
3. Ask for confirmation and propose a collision-safe `restore/<session-short-id>` worktree name.
4. Use only the existing, explicitly allowlisted and contract-tested `_x.ai/git/worktree/create` method to create the worktree from the historical session. Do not reconstruct or reinterpret `rewind_points.jsonl` in Grok Web.
5. Use only the existing, explicitly allowlisted and contract-tested `_x.ai/session/fork` method to continue the conversation in the returned worktree cwd. A method-not-found response is treated as unsupported, not as a reason to probe alternatives.
6. Register the worktree as an allowed root and navigate to the new session.
7. Never modify the original cwd, even when it is clean.

On failure, remove only a worktree positively identified as created by this request and safe to remove. Otherwise return the exact residual path for manual recovery. Missing capabilities produce an unsupported response before filesystem mutation.

## Authentication interaction

Runtime capability display may work before login, but creating/loading sessions and authenticated Plugins/MCP still report the Grok authentication requirement. A visible model from custom Provider configuration is not presented as proof that the Agent runtime is authenticated. The workspace provides a direct route to Grok login when session initialization returns authentication-required.

## Error contract

- `400`: invalid profile field, conflicting rule, invalid worktree name, or unsupported path;
- `403`: untrusted Agent profile or restore path;
- `409 runtime_busy`: active work prevents restart;
- `409 worktree_conflict`: target already exists;
- capability error: known feature absent from current Grok version;
- `503`: candidate ACP initialization failed and rollback status is included;
- authentication-required: explicit login action, not a generic send failure.

## Compatibility and rollback

There is no migration when the Runtime Profile file is absent. The profile is versioned and atomically written. Unknown future fields are ignored on read but preserved only when explicitly supported by the current schema writer; invalid versions fail closed to defaults with an actionable warning.

Restore-code creates new resources only after confirmation. No existing worktree, branch, session, or user file is overwritten.

## Verification

TDD and browser coverage must prove:

- capability parsing for supported, missing, malformed, and changed CLI help/inspect output;
- exact argv ordering and shell-free value handling;
- invalid/untrusted profile paths and conflicting flags are rejected;
- Runtime Profile never accepts secret fields;
- busy sessions prevent persistence/restart;
- successful restart reloads idle sessions;
- failed candidate startup restores old config/process;
- rollback failure surfaces degraded state;
- UI controls follow detected capabilities and save errors roll back visually;
- standard Plan is shown only when advertised and read back;
- restore-code never modifies the original cwd;
- missing CLI capability or failed read-only worktree capability check performs no worktree mutation;
- method-not-found from the allowlisted create/fork path is reported as unsupported and triggers only request-owned cleanup;
- successful restore creates a new worktree and navigates to a forked/resumed session;
- failure cleanup only touches the request-owned worktree;
- authentication-required presents a login path even when custom models are visible.

The stage gate includes the complete suite, typecheck, lint, standalone build, route smoke, deterministic ACP browser E2E, and an opt-in live Grok run against a dedicated authenticated test home.

## Release boundary

This stage completes the approved browser-interactive parity target. Further CLI parity—JSON Schema, headless output formats, generic Extension UI, and process pools—requires a new design and is not implied by this program.