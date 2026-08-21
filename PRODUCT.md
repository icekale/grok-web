# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary users already run Grok Build from the TUI (`grok` CLI) and keep their work in `~/.grok`. They open grok-web when they want the same sessions in a browser: pick a project, continue or start a chat, watch the agent, preview files and Git, and change settings.

Published at [icekale/grok-web](https://github.com/icekale/grok-web) so other Grok TUI users can run the same app locally. LAN access is a same-trust, optional extra (another machine, same person or a trusted peer on the LAN), not a hosted team product.

## Product Purpose

grok-web is the local browser workspace for Grok Build. It does not replace Grok. It sits in front of one long-lived `grok agent stdio` process and the existing `~/.grok` home, so TUI and web can continue the same sessions.

Success: a Grok TUI user can do their coding-agent work in the browser without a second session store, and another person can clone and run the repo the same way.

## Positioning

A single-operator, local Grok workspace in the browser, wired through official ACP — not a new agent, not a cloud Grok, and not a multi-tenant host. Neighboring chat UIs cannot truthfully claim they share Grok Build’s on-disk sessions and one `grok agent stdio` process.

## Operating Context

- Runs on the user’s machine (default `127.0.0.1:30142`). `npm run dev` / `npm run dev:lan` or `bin/grok-web.js`.
- Sessions, auth, config, skills, and MCP live under `~/.grok` (overridable with `GROK_HOME`). App-only metadata lives in `~/.grok/grok-web/`.
- Browser talks HTTP/SSE to the local Node gateway only. The gateway owns ACP. The browser never spawns Grok, never speaks ACP, and does not implement Pi coding-agent RPC.
- Typical loop: pick project → open or resume session → prompt → approve tools → inspect files/Git → adjust models, skills, MCP, or remote password in Settings.
- TUI may be open on the same home. If a session is busy or `session/load` fails, the web stays read-only or offers a new session rather than overwriting the TUI.

## Capabilities and Constraints

Confirmed:

- One long-lived `grok agent stdio` multiplexes browser sessions (`session/new`, `session/load`, `session/prompt`).
- Loopback needs no login. Non-loopback bind requires a remote password; Basic username is `grok`.
- No multi-tenant cloud, no sandbox farm, no browser-direct ACP, no rewrite of Grok itself.
- Node `>= 22.19.0`. Stack already in repo: Vite, TanStack Start, local Node gateway. Env prefix `GROK_WEB_`.
- Chat, session index, files, Git (including stage/discard/commit via ACP when available), worktrees, settings, auth, MCP, skills, subagent tree, compact, feedback, recap, prompt history.
- Conversation protocol is Grok ACP. grok-web HTTP/SSE is the browser wire for this app, not a pi-web SSE compatibility contract.
- Composer `!` is a normal prompt. Users run shell commands through the agent's terminal tool, same as the TUI.
- Missing ACP methods surface as explicit errors. Local git/fs fallback is read-only.
- Prompt images are sent as ACP `image` content blocks on `session/prompt`. Tool presets (`none|read-only|default|full`) are ACP `configOptions` ids. Extension custom UI is unsupported.
- Custom providers in Settings can import and test models against an OpenAI-compatible base URL; the live chat model list still comes from Grok ACP.

Distribution (0.x preview):

- Channel: GitHub [icekale/grok-web](https://github.com/icekale/grok-web). Clone and `npm run dev`, or `npm run pack:tanstack` for a tarball. Not an xAI official release.
- Versioning: semver starting at `0.10.0`. While the major version is `0`, breaking changes may land without a major bump.
- Support: best-effort. No compatibility contract with other web UIs, including pi-web SSE.
- Chrome: the current workspace shell may evolve after publish. It is not a hard lock to the first pi-web-shaped layout.

## Brand Commitments

- Product name: **grok-web**. Remote-auth username: **grok**.
- User-facing identity is Grok, not Pi. Settings/login realm and chrome must not say “Pi Web”.
- License in-repo: MIT. Do not invent other legal marks.
- UI copy is localized (en, zh-CN); current operator locale is Chinese.

## Evidence on Hand

- Running app and source: this repository ([icekale/grok-web](https://github.com/icekale/grok-web))
- Locked design notes: `docs/superpowers/specs/2026-08-18-grok-web-design.md` and later phase specs under `docs/superpowers/`
- Icons and PWA assets: `public/icons/`, `public/manifest.webmanifest`
- No customer quotes, benchmarks, press, or pricing exist. Future work must not fabricate them.

## Product Principles

1. One Grok home. Web never forks a second session universe.
2. Local by default, LAN only with a password; never pretend to be a cloud.
3. The gateway adapts Grok ACP; the browser uses grok-web HTTP/SSE. Do not promise compatibility with pi-web SSE.
4. Prefer an explicit error over a silent no-op when Grok cannot do the thing.
5. Publish as a tool others can run, but do not grow multi-tenant scope to look “ready for the internet.”

## Accessibility & Inclusion

The original design spec targets WCAG 2.1 AA, matching the pi-web surface this UI was cloned from. No additional product-specific access needs were recorded in this interview.
