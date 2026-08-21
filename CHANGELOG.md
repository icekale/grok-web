# Changelog

All notable changes to this project are documented in this file.

This project follows [Semantic Versioning](https://semver.org/). While the major version is `0`, the public API may change without a major bump.

## 0.10.0

First public 0.x release of Grok Web: a local browser workspace in front of one `grok agent` ACP process and `~/.grok`.

- Chat, sessions, files, Git, worktrees, settings, MCP, skills, plugins, and subagents
- Loopback needs no login; non-loopback binds require a password
- English and zh-CN UI
- Pack with `npm run pack:tanstack` (do not publish from the repository root)
- `npm run typecheck` is clean (`tsc --noEmit`)
- Playwright smoke (`npm run test:e2e`) loads the operate shell against a live `grok`
