# grok-web: Grok Build Web Companion Positioning Design

Date: 2026-08-22
Status: Approved for planning

## Goal

Reposition `grok-web` as **the web companion for Grok Build** and make that identity consistent across project documentation, package metadata, PWA metadata, and key user-facing product copy.

This is a product-positioning pass, not a protocol change or visual redesign.

## Product Identity

Product name remains **grok-web**. User-facing application name remains **Grok Web**.

Primary English positioning:

> The web companion for Grok Build.

Primary Chinese positioning:

> Grok Build 的 Web 伴侣。

Supporting message:

> Continue the same Grok Build projects, sessions, tools, and settings in the browser, using the existing `~/.grok` home.

The project remains an independent community project. README introductions should keep that relationship visible as secondary information without making the disclaimer the main product message. Support and legal sections must continue to avoid implying xAI ownership or endorsement.

## Audience And Product Boundary

The primary user already uses Grok Build through the `grok` CLI and wants a browser interface over the same local Grok environment.

`grok-web` is exclusive to the Grok Build workflow:

- It requires a recent Grok Build CLI with ACP support.
- It uses Grok ACP through the local Node gateway.
- It reuses the existing `~/.grok` sessions, authentication, models, skills, plugins, and MCP configuration.
- It does not create a second session store, agent runtime, or generic model backend.
- It remains local-first and single-operator; optional LAN access stays within the existing password-protected model.

## Custom Provider Capability

Custom provider support remains complete.

The product should explain this feature as management of **Grok Build provider configuration**, not as an independent provider system owned by `grok-web`. Existing provider creation, editing, import, model discovery, connection testing, and persistence behavior must remain available.

The live chat model list continues to come from Grok ACP. The web UI must not imply that its own provider configuration bypasses or replaces Grok Build's runtime model selection.

## Scope

### Documentation

Update:

- `README.md`
- `README.zh-CN.md`
- `PRODUCT.md`

The README first viewport should lead with the approved positioning, the shared `~/.grok` relationship, and the Grok Build requirement. The current pi-web attribution and one-time migration notes remain where technically relevant, but they must not compete with the product identity.

`PRODUCT.md` should state the Grok Build-exclusive boundary directly and split the current run-on capability statement into scannable product rules.

### Package And PWA Metadata

Update the descriptive metadata in:

- `package.json`
- `public/manifest.webmanifest`
- route/page metadata that currently describes Grok Web generically

The name stays `grok-web` / Grok Web. Descriptions should use “web companion for Grok Build” rather than “web interface for a coding agent.”

### Application Copy

Keep the existing compact workspace. Do not add a landing or marketing page.

Adjust only key user-facing copy where needed:

- empty and setup states;
- missing-Grok or installation guidance;
- Models settings explanations;
- custom provider descriptions;
- other prominent text that currently presents the app as a generic agent UI.

Copy must make clear that users are operating Grok Build and its provider configuration.

### Cleanup Included

Remove dead localization keys confirmed by the cleanup review:

- `sidebar.exportSession`
- `sidebar.renameCommand`
- `sidebar.deleteCommand`
- `chat.commandName`

Remove orphaned `.codex-worktree-create` CSS rules left after the worktree-create UI was deleted.

These deletions are included because they are concrete dead code in the same changed product surface.

## Compatibility And Internal Names

Do not rename internal `codex-*` CSS classes or components solely for branding purity. They are implementation details and renaming them adds risk without changing user-facing identity.

Keep:

- one-time `pi-web` migration keys and migration comments;
- pi-web attribution required by project history;
- existing ACP, HTTP/SSE, session, auth, provider, and storage behavior.

Internal compatibility history may mention pi-web where technically necessary. User-facing chrome must not present the product as Pi Web or a generic Codex UI.

## Error Handling

Preserve explicit failure signals:

- missing or unsupported `grok` CLI;
- ACP methods unavailable in the installed Grok Build version;
- provider import, discovery, connection, or persistence failures;
- local session conflicts or read-only fallback.

The positioning pass must not replace these errors with vague defaults or silent fallbacks.

## Validation

The implementation is complete when:

1. English and Chinese README introductions use the approved companion positioning.
2. Project documentation, package metadata, PWA metadata, and prominent application copy consistently identify Grok Build as the product host.
3. No prominent description presents `grok-web` as a generic coding-agent web UI.
4. The community-project relationship remains visible without dominating the first message.
5. Grok login, ACP models, and the complete custom provider workflow remain available.
6. Session, ACP, storage, auth, provider, and LAN behavior remain unchanged.
7. Dead localization keys and orphaned worktree-create CSS are removed.
8. `npm test`, `npm run lint`, and `npm run typecheck` pass.
9. Any changed visible empty/setup state is checked at desktop and mobile widths.

## Out Of Scope

- Renaming `grok-web` or Grok Web.
- A visual redesign, landing page, or new marketing surface.
- Renaming internal CSS classes or components.
- Removing or reducing custom provider support.
- Changing ACP, HTTP/SSE, session storage, authentication, or model-selection behavior.
- Cloud hosting, multi-tenancy, browser-direct ACP, or a new agent runtime.
- Unrelated cleanup-review suggestions such as extracting session deletion, sharing tools-section constants, or optimizing `loadTools` state requests.
