# Grok Web

Local browser workspace for [Grok Build](https://grok.com). It sits in front of one long-lived `grok agent` ACP process and the existing `~/.grok` home, so the TUI and the web UI continue the same sessions.

This is a community 0.x preview for a single operator on your machine. It is **not** an official xAI product, not affiliated with xAI, and not a hosted multi-tenant Grok. The browser never speaks ACP.

Source: [github.com/icekale/grok-web](https://github.com/icekale/grok-web). Chinese readme: [README.zh-CN.md](README.zh-CN.md).

![Grok Web operate shell](docs/images/operate-shell.png)

## Requirements

- Node.js `>= 22.19.0`
- The `grok` CLI on `PATH` ([Grok Build](https://x.ai/news/grok-build-cli)). grok-web does not pin a CLI version; use a recent Grok Build that speaks ACP.

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

## Environment

| Variable | Purpose |
| --- | --- |
| `GROK_HOME` | Override the Grok home (default `~/.grok`) |
| `GROK_WEB_PASSWORD` | Remote password; wins over the stored hash |
| `GROK_WEB_HOSTNAME` | Bind / advertised hostname |
| `GROK_WEB_ALLOWED_HOSTS` | Extra comma-separated Host allowlist |
| `GROK_WEB_NO_OPEN` | Set to skip opening a browser |

## Data

Sessions, auth, models, skills, and MCP live under `~/.grok`. App-only metadata lives in `~/.grok/grok-web/`. Remote-access config is `~/.grok/grok-web.json` (a leftover `pi-web.json` is copied once).

## Architecture

```
Browser UI  --HTTP/SSE-->  local Node gateway  --ACP stdio-->  grok agent
                                      |
                                      +-->  ~/.grok
```

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| `grok` not found | Install Grok Build and confirm `grok` is on `PATH` |
| Unsupported Node | Need `>= 22.19.0` (`node -v`) |
| Port in use | Stop the other process on `30142`, or pass `-p` |
| LAN bind refused | Set `GROK_WEB_PASSWORD` (12+ characters) or bind `127.0.0.1` |
| Session stays read-only | The TUI may already own that session; open a new one or retry |

```bash
npm test
npm run lint
npm run typecheck
npx playwright install chromium
npm run test:e2e
```

`npm test` stays process-free. `npm run test:e2e` starts the Vite app and checks that the operate shell loads against a live `grok` on `PATH`.

## Publish

```bash
npm run pack:tanstack
```

builds the TanStack server, stages a package that includes the CLI, and packs a tarball in a temporary directory. Do not `npm publish` from the repository root.

## Support

0.x is best-effort. Breaking changes can land without a major bump. There is no compatibility contract with other web UIs.

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The workspace chrome was adapted from [pi-web](https://github.com/icekale/pi-web).
