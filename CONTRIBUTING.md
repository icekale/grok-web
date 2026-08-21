# Contributing

Grok Web is a local browser workspace for [Grok Build](https://grok.com). It is published at [icekale/grok-web](https://github.com/icekale/grok-web).

## Requirements

- Node.js `>= 22.19.0`
- `grok` on `PATH` if you want to run the live app (unit tests do not spawn it)

## Setup

```bash
npm install
npm run dev
```

The app listens on `http://127.0.0.1:30142`.

## Checks

```bash
npm test
npm run lint
npm run typecheck
```

Tests live next to the code as `*.test.mjs` and run with `node --test`. Do not add a real `grok` process or a live model call to the default suite.

```bash
npx playwright install chromium
npm run test:e2e
```

starts Vite on `127.0.0.1:30143` and checks that the operate shell loads. It needs `grok` on `PATH`. It does not send a model prompt. Refresh the README screenshot with `npm run shot`. That uses an isolated Grok home so personal sessions stay out of the image.

## Pull requests

- Keep the product local-first. Do not grow multi-tenant hosting.
- User-facing copy should say Grok Web, not Pi Web.
- Do not commit `.env*`, `.impeccable/`, `.omg/`, or `*.tsbuildinfo`.
- Match the existing TypeScript / React / `node --test` style.

## Publishing

Do not `npm publish` from the repository root. Use `npm run pack:tanstack`, then publish the staged tarball.
