# Web-only Hooks and Memory Design

## Status

Draft for operator review. Scope approved 2026-08-25: daily Grok Build without opening the TUI. Rewind is already in the product (user-message “edit from here” / branch navigate → `navigate_tree` → `_x.ai/rewind/execute`). `/imagine` stays out.

## Goal

A Grok Build operator can list, add, remove, and trust hooks, and can enable memory, browse stored files, and save a remember note, entirely from grok-web. After these land, those two jobs must not require the TUI.

## Non-goals

- TUI pager chrome: vim, compact, minimal/fullscreen, Agent Dashboard, `/theme`.
- `/imagine` / `/imagine-video`.
- `/dream` unless ACP already advertises it as an available command.
- Inventing undeclared `_x.ai/hooks*` or `_x.ai/memory*` RPCs. Interactive-parity still forbids probing private methods.
- A JSON/TOML hook editor, Claude/Cursor import UI, or per-hook session-only Space-toggle (TUI runtime disable with no documented file).
- Writing grok-web’s `project-trust.json` as a substitute for Grok folder-trust.
- Replacing `grok agent` memory tools (`memory_search` / `memory_get`). The model keeps those when memory is on.

## Product boundary

grok-web remains a companion: browser HTTP/SSE → Node gateway → one `grok agent stdio`. Hooks and memory live under `~/.grok` (and project `.grok/hooks` when trusted). The gateway reads Grok’s own files and `grok inspect --json`; it does not grow a second hook runner.

User-owned writes are explicit companion writes (same class as uploads): they mutate Grok home files, then recycle the ACP process so the running agent reloads. Plugin, managed, and requirements hooks are visible and read-only.

## Architecture

```
Settings tools pane  +  /hooks /memory /remember [/flush if advertised]
        │
        ▼
  GET/POST /api/hooks    GET/POST /api/memory
        │
        ├── grok inspect --json   (list hooks, projectTrusted)
        ├── ~/.grok/hooks/*.json  (add/remove user hooks)
        ├── ~/.grok/trusted_folders.toml  (folder-trust; same file as /hooks-trust)
        ├── ~/.grok/config.toml [memory]
        └── ~/.grok/memory/**     (browse, remember append, delete session logs)
        │
        ▼
  AgentRuntime.recycleProcess() when trust, hook files, or [memory] enabled change
```

Slash commands only open the matching Settings tools section or run a small confirm dialog. They do not send `/hooks` as a model prompt.

Implementation order: Hooks (list, add, remove, trust, recycle) → Memory (enable, browse, remember). Each ships with tests before the next starts.

---

## 1. Hooks

### List

`GET /api/hooks?cwd=` runs `grok inspect --json` in that cwd (reuse the existing capability-probe exec helper, not a new spawn stack). Parse the `hooks` array already returned today:

| Field | Use |
| --- | --- |
| `event` | Row label (plugin file sources may be `"(plugin)"`) |
| `hookType` | `file` / command / http when present |
| `target` | Path or URL |
| `matcher` | Optional |
| `source.type` | `plugin` / project / global / config — group the list |
| `source.plugin_name` / `source.path` | Read-only provenance |

Also return `projectTrusted` (boolean from inspect) and `projectRoot`.

Cwd must pass existing file-root allowlist. Missing grok binary → 503 with the existing grok-missing message.

### Add (user global only)

`POST /api/hooks` `{ action: "add", cwd, event, type: "command"|"http", command?, url?, matcher?, timeout? }`.

Write one file `~/.grok/hooks/<slug>.json` in Grok’s documented JSON shape (`hooks.<Event>` → matcher group → handlers). Slug is derived from event + short id, filesystem-safe, no path traversal.

Allowed events: the documented Grok set (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionDenied`, `Stop`, `StopFailure`, `StopCancelled`, `Notification`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, `SessionEnd`). Unknown event → 400.

`type: command` requires `command` string (no shell interpolation in the gateway). `type: http` requires `url` starting with `https:` (or `http:` only for loopback). Timeout is a positive integer seconds, default omitted so Grok’s default applies.

Do not write into plugin dirs, `managed_config.toml`, or `requirements.toml`.

After a successful write, recycle the ACP process.

### Remove

`POST /api/hooks` `{ action: "remove", cwd, target }`.

`target` must be a real path under `~/.grok/hooks/` (resolved, no symlink escape). Plugin and project paths → 403. Then recycle.

### Trust

`POST /api/hooks` `{ action: "trust"|"untrust", cwd }`.

Write Grok’s unified folder-trust store `~/.grok/trusted_folders.toml` (same file `/hooks-trust` uses). Do **not** use `~/.grok/grok-web/project-trust.json`.

The on-disk schema is whatever Grok already reads: implementation must make a subsequent `grok inspect --json` in that cwd report `projectTrusted: true` after trust and `false` after untrust (unless folder-trust is globally disabled). Capture the format from an existing file or from Grok’s documented store; add a fixture test. If `[folder_trust] enabled = false` or `GROK_FOLDER_TRUST=0`, the UI shows that project hooks are ungated and hides the trust button.

Trust/untrust recycles the ACP process so project hooks actually load.

### Reload

`POST /api/hooks` `{ action: "reload", cwd }` recycles the process and re-lists. There is no mid-session hook reload RPC.

### UI

Settings **tools** variant (skills / plugins / mcp) gains a **Hooks** section. `/hooks` is a builtin slash that calls `onOpenSettings("hooks")`, same as `/skills`.

Layout matches Skills/Plugins density: grouped list (Global / Project / Plugin / Config), event, target (mono, shortened path), matcher, read-only badge for non-user sources. Primary actions: Trust project, Add hook, Reload. Remove only on user `~/.grok/hooks` rows.

Add hook is a small dialog (not a JSON editor): event select, type, command or URL, optional matcher, optional timeout.

i18n: `en` + `zh-CN` keys, catalogs stay in parity.

---

## 2. Memory

### Enable

Memory is off by default in Grok. Settings → tools **Memory** section shows an enable toggle that pins `[memory] enabled = true` (or `false`) on the user `~/.grok/config.toml` using the same atomic private-file write as other Grok home edits. Then recycle ACP.

If `GROK_MEMORY` is set in the process environment, it wins over TOML (Grok precedence). The toggle still writes TOML but the UI shows a warning that env overrides the file and the running agent will not change until that env is unset.

Do not implement `/memory on|off` as a session-only ACP toggle unless inspect later exposes a session flag. Companion enable is process-wide via config + recycle.

### Browse

`GET /api/memory?cwd=` lists files under `~/.grok/memory/` grouped:

- Global: `MEMORY.md`
- Workspace: `<project-slug>-<hash8>/MEMORY.md` whose slug/hash matches the cwd’s git origin or path, as Grok documents
- Sessions: that workspace’s `sessions/` files, newest first

Read-only preview of the selected file (text). Opening in the existing FileViewer is allowed for files inside grok home. Delete is allowed only for session log files, never `MEMORY.md`.

If memory is disabled, GET still returns `{ enabled: false, files: [] }` plus the toggle state so the section can render.

### Remember

`POST /api/memory` `{ action: "remember", cwd, text, scope: "workspace"|"global" }`.

Append a dated markdown note to the chosen `MEMORY.md` (create the file and parents if needed, mode 0o600). Confirm in the UI before POST. Default scope is workspace when cwd is a project, else global.

This is a companion write. Grok’s file watcher reindexes; recycle is not required for remember-only, but is required when enabling memory.

`/remember [text]` opens the confirm dialog with the argument prefilled. Empty `/remember` opens the empty dialog.

### Flush

Do not invent Grok’s LLM flush format.

If ACP `availableCommands` includes `flush` (or `compact` already uses a dedicated RPC — flush has none today), `/flush` uses the existing `run_command` path only when that command is advertised. If it is not advertised, `/flush` is omitted from builtins and the Memory section copy says flush remains a TUI command until Grok ACP lists it.

`/dream` follows the same rule (default: omit).

### UI

Settings tools section **Memory**: enable toggle, then (when enabled) file list + preview + Remember + delete session file. `/memory` opens this section.

---

## 3. Shared rules

- New routes: `/api/hooks` GET+POST, `/api/memory` GET+POST. Register in `src/api-methods.ts`, TanStack route files, route inventory, and smoke list.
- Recycle uses the existing runtime recycle path (same as runtime-profile apply): terminate child, respawn, reload recoverable sessions.
- Fail closed on path jail, missing cwd, and writes outside `grokHome()` / the trusted cwd.
- Tests first: inspect parse fixture, add/remove hook file, trust round-trip vs inspect `projectTrusted`, remember append, slash source contracts (`/hooks`, `/memory`, `/remember`), i18n parity.
- No new npm dependency.

## Verification

- With only grok-web: open `/hooks`, see inspect-listed plugin hooks, add a global `SessionStart` echo hook, reload, confirm the file exists under `~/.grok/hooks/` and inspect lists it.
- Trust a temp project that contains `.grok/hooks`, confirm inspect `projectTrusted` flips, then untrust.
- Enable memory, `/remember` a note, see it in Global or Workspace `MEMORY.md` from the Memory section.
- User-message “edit from here” still rewinds (no regression).
- `npm test` green; i18n catalogs stay in key parity.

## Out of this spec

Rewind UI, imagine, dream, TUI-identical extensions modal, hook JSON editor, session-only hook disable, grok-web project-trust as folder-trust.
