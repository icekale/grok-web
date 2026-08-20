# Grok Web

Local browser workspace for [Grok Build](https://grok.com). It sits in front of one long-lived `grok agent` ACP process and the existing `~/.grok` home, so the TUI and the web UI continue the same sessions.

This is a single-operator app for your machine. It is not a hosted multi-tenant Grok, and the browser never speaks ACP.

## Requirements

- Node.js `>= 22.19.0`
- The `grok` CLI on `PATH`

## Run

```bash
npm install
npm run dev
```

The app listens on `http://127.0.0.1:30142` by default. Loopback needs no login.

```bash
npm run start
```

starts the packaged server the same way. `npm run dev:lan` / `npm run start:lan` bind `0.0.0.0` for same-trust LAN use.

## Remote access

Non-loopback binds require a password. Set `GROK_WEB_PASSWORD` or configure it in Settings. Basic Auth username is `grok`.

Use HTTPS or a trusted VPN if the password will cross an untrusted network.

## Data

Sessions, auth, models, skills, and MCP live under `~/.grok` (`GROK_HOME` overrides). App-only metadata lives in `~/.grok/grok-web/`.

## Publish

```bash
npm run pack:tanstack
```

builds the TanStack server, stages a package that includes the CLI (`bin/grok-web.js` plus the `lib/` files it imports), and packs a tarball via a temporary directory. Do not point publication scripts at a repo-local output folder.

## License

MIT. See [LICENSE](LICENSE). Chinese readme: [README.zh-CN.md](README.zh-CN.md).
