# Data and Remote Safety Hardening Design

## Status

Approved during the 2026-08-22 design review. This is stage A of the risk-first Grok Web interactive-capability program.

## Goal

Remove known credential-loss, session-deletion, interrupted-write, remote-bind, child-secret, and shutdown hazards without changing the public `~/.grok` storage formats or removing password-protected LAN operation.

## Scope

This stage includes:

- isolating the official Grok/xAI API key from custom Provider model keys;
- making managed model sections repairable on settings save;
- making `auth.json` and session summary writes atomic;
- requiring positive ACP ownership and close before physical session deletion;
- enforcing non-loopback authentication in the server runtime, not only the CLI wrapper;
- removing Grok Web ingress secrets from the `grok agent` environment;
- forwarding termination signals through the CLI wrapper;
- fixing localhost password removal to use the proven socket peer.

It does not migrate storage formats, recover credentials already deleted by an older release, delete old sessions, remove `start:lan`, add multi-tenant isolation, or change ACP wire behavior.

## Credential ownership boundary

### Official Grok/xAI key

The official API key is only the top-level `api_key` in the TOML preamble before the first section header.

- `hasGrokApiKey()` only examines the preamble.
- `writeGrokApiKey()` only updates the preamble.
- `clearGrokApiKey()` only removes the preamble key.
- Grok logout and xAI API-key deletion must never inspect or mutate section-local keys.

### Custom Provider keys

An `api_key` inside `[model."provider/model"]` or another model section belongs to that model/provider configuration. It is not evidence of official Grok authentication and is never removed by official logout.

Saving Models settings must upsert only sections that can be proven to be managed by the current `models.json` configuration. Unknown, native Grok, plugin-owned, and manually-authored sections remain byte-for-byte outside the targeted section. The upsert repairs a managed section whose key was removed by an older release when the user saves that Provider again.

No automatic migration guesses a missing secret. Environment references remain references and literal keys retain the existing storage behavior.

## Atomic writes

Use the existing atomic-file helpers rather than adding a second file transaction abstraction.

- Credential updates retain the existing `proper-lockfile` critical section, write a complete temporary file with mode `0600`, then atomically replace `auth.json` before releasing the lock.
- Session rename writes a complete replacement `summary.json` atomically in the same directory.
- Existing atomic writes for `config.toml` remain the model.
- A failed write leaves the previous complete file in place and returns an error; it must not report success from an in-memory mutation.

## Physical session deletion

Archiving remains the non-destructive way to hide a session. Physical deletion follows this algorithm:

1. Resolve the canonical indexed session and its directory.
2. If the local runtime already owns it, reject with `409 session_busy` when the session is busy.
3. If the local runtime does not own it, call ACP `session/load` for the exact session and cwd to acquire ownership.
4. Any load failure, including external TUI/Web ownership, missing authentication, unsupported capability, or ambiguous state, returns `409 session_in_use` and leaves disk untouched.
5. Call ACP `session/close` and require the promise to resolve successfully.
6. Only after successful close remove the indexed session directory and invalidate the session index.

A close failure never falls through to disk deletion. The UI does not expose force delete. The error directs the user to close the session in the owning Grok process or archive it instead.

## Remote runtime boundary

The CLI wrapper remains a convenience layer, not the security boundary.

- Server startup validates the effective bind host and password before accepting requests. Direct execution of Nitro on a non-loopback host without a valid password fails closed.
- Loopback remains the default. Password-protected `start:lan` remains supported.
- Existing Host, peer, Basic Auth, and CSRF checks remain centralized in request security.
- Local password removal receives the actual socket peer from the request dispatcher. Forwarded headers never prove loopback.
- The documentation continues to require HTTPS termination or a trusted VPN for untrusted networks.

## Child process environment

The child environment starts from the current process environment because custom Providers can legitimately reference environment variables. Before spawning `grok agent`, it removes Grok Web ingress-only secrets, at minimum `GROK_WEB_PASSWORD`, and any future variable explicitly classified as a Web authentication secret.

It retains `GROK_HOME`, provider environment variables, locale, PATH, and normal process variables. Runtime profile data must not contain API keys, passwords, or tokens.

## Process lifecycle

The CLI wrapper forwards `SIGINT`, `SIGTERM`, and platform-equivalent shutdown to the Nitro child, waits for a bounded grace period, then force-terminates only if the child remains alive. The wrapper exits with the child status or conventional signal status. Repeated signals shorten the wait rather than spawning another shutdown path.

Nitro shutdown must dispose the singleton ACP runtime so `grok agent` and active terminals do not remain orphaned.

## Error contract

- `409 session_busy`: the local session is actively running.
- `409 session_in_use`: ownership or close could not be positively established.
- `401`: remote authentication failed.
- startup failure: an unauthenticated non-loopback bind or invalid remote configuration.
- `500`: an atomic write failed while the old complete file remains intact.

No error path may continue with session deletion, broad model-section key removal, or success UI state.

## Compatibility and migration

`config.toml`, `models.json`, `auth.json`, remote-access configuration, and session directory formats remain unchanged. There is no startup migration and no background cleanup. A user whose custom key was already removed must re-enter or re-save it; the new managed-section upsert then repairs the Grok model section.

## Verification

TDD coverage must prove:

- official key detection ignores every model-section key;
- official logout and xAI deletion preserve multiple unrelated custom Provider sections;
- saving a managed Provider repairs its targeted section without rewriting unknown sections;
- interrupted credential and summary writes preserve the previous file;
- busy, externally owned, unauthenticated, and close-failing sessions return `409` and remain on disk;
- an owned idle session closes before deletion;
- direct Nitro non-loopback startup without a password fails;
- authenticated loopback and LAN modes retain their expected behavior;
- `grok agent` cannot read `GROK_WEB_PASSWORD` from its environment;
- wrapper signals terminate both server and ACP descendants;
- localhost password removal uses the socket peer and succeeds only for true loopback.

The stage gate also requires the complete single-threaded suite, typecheck, lint, standalone build, safe route smoke, and temporary-home lifecycle probes.

## Release boundary

This stage is implemented, reviewed, merged, deployed, and verified independently before stage B starts. It must not add new Grok feature controls.