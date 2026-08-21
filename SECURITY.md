# Security

Grok Web is a single-operator local app. By default it binds `127.0.0.1` and does not require a password. Binding a non-loopback address requires a password and still uses HTTP Basic Auth.

## Report a vulnerability

Please use [GitHub Security Advisories](https://github.com/icekale/grok-web/security/advisories) on [icekale/grok-web](https://github.com/icekale/grok-web).

Do not open a public issue for a vulnerability that could expose a remote password, session data, or local files.

## What to include

- Grok Web version (`package.json` or Settings → About)
- Node.js version
- Bind address (`127.0.0.1` vs LAN)
- Whether `GROK_WEB_PASSWORD` or a stored password was set
- Steps to reproduce, without real secrets

## Deployment notes

- Keep the default loopback bind unless you trust every peer on that network.
- If the password will cross an untrusted network, put HTTPS or a trusted VPN in front. This app does not terminate TLS.
- The browser talks only to the local gateway. The gateway owns the `grok agent` ACP process and can reach whatever that agent can reach on your machine.
