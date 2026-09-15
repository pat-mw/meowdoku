# Meowdoku

**Play it: [meowdoku-mu.vercel.app](https://meowdoku-mu.vercel.app)** — add it to
your home screen and it works offline.

An ad-free, installable web clone of a Star-Battle/Queens-style logic puzzle,
with cats.

Place exactly one cat in every row, every column and every colour region, and
never let two cats touch — not even diagonally. Every puzzle has exactly one
solution and can be solved by pure deduction.

- **No ads, no accounts, no analytics.** Nothing leaves the device unless you
  join a multiplayer room, and nothing is stored when you do.
- **Fully offline** after the first load, and installable to the home screen on
  iOS and Android.
- **Unbounded levels.** Level _N_ is a deterministic pure function of _N_, so
  every player sees the same puzzle at level 4,812, forever.
- **Optional multiplayer.** Five-character room codes, up to eight players, and
  a separate server that single-player never talks to or downloads.

## Getting started

```bash
pnpm install
pnpm dev
```

| Script                 | What it does                                             |
| ---------------------- | -------------------------------------------------------- |
| `pnpm dev`             | Vite dev server                                          |
| `pnpm build`           | Typecheck, then production build to `dist/`              |
| `pnpm typecheck`       | `tsc -b --noEmit` — the app and the build config         |
| `pnpm lint`            | ESLint, including the React Compiler hook rules          |
| `pnpm test`            | Vitest unit suite                                        |
| `pnpm test:e2e`        | Playwright, iPhone 13 and Pixel 5 profiles               |
| `pnpm party:dev`       | The room server locally, on `wrangler`                   |
| `pnpm party:typecheck` | The room server — a separate project, checked on its own |
| `pnpm party:deploy`    | Publish the room server to Cloudflare                    |

## Layout

```
src/
  board/        pure game core — types, rules, reducer, hints, scoring
    generator/  seeded level generation, solvers, tier table
  input/        pointer and keyboard gesture handling
  multiplayer/  wire protocol, match rules, room codes, party client
  routes/       TanStack Router file routes
  screens/      the screens those routes render
  store/        Zustand stores, persistence and migrations
  ui/           components, design tokens, palette
  pwa/          install prompt, update flow, service worker registration
party/          the room server — a Cloudflare Worker, deployed separately
handover/       the source spec, stack doc and design export
```

`src/board` never imports React and never touches the DOM. It is the shared core
for the app, the generator Web Worker and the tests.

See [DECISIONS.md](DECISIONS.md) for choices the source documents left open.

## Multiplayer

Rooms, three race modes, and a live progress bar. It is deliberately bolted to
the side of the single-player app rather than woven through it, and the seam is
held by [tests/unit/offline-guard.test.ts](tests/unit/offline-guard.test.ts):

- **Nothing multiplayer ships in the main bundle.** The whole feature — screens,
  protocol, match rules, `partysocket` — lives in one `multiplayer-*.js` chunk
  behind a lazy route, and is not in the service worker's precache manifest
  either, so a single-player install never downloads it in the foreground or
  the background. The single exception, enforced by the test, is
  `src/multiplayer/connection.ts`: a dependency-free reachability probe the home
  screen needs to decide whether to offer multiplayer at all.
- **Rooms broadcast level numbers, not boards.** Level _N_ is deterministic, so
  every player generates the same puzzle locally and the server verifies claimed
  solutions by generating it too. No puzzle is ever stored or transmitted.
- **Losing the connection cannot disturb single-player.** Multiplayer never
  writes to the save, never runs at boot, and launching with no network behaves
  exactly as it did before any of this existed.

### Running it locally

```bash
cp .env.example .env.local
pnpm party:dev    # the room server on :8787
pnpm dev          # the app, in a second terminal
```

`VITE_PARTY_HOST` is the only setting, and it is read at build time. Leave it
unset and multiplayer is not offered — the rest of the app is untouched. Use
`pnpm dev` rather than `vercel dev` against a local party server: `vercel dev`
applies the Content-Security-Policy below, which does not allow loopback.

### Deploying

The app is a Vercel project; the room server is a Cloudflare Worker, built from
`party/` by `wrangler.toml` and deployed on its own with `pnpm party:deploy`.
Three settings have to agree about the two origins:

1. `VITE_PARTY_HOST` in the Vercel project's environment variables, for
   Production and Preview. Changing it requires a redeploy.
2. `connect-src` in the `Content-Security-Policy` in
   [vercel.json](vercel.json), which names the same host twice —
   `https://meowdoku-party.pre0.workers.dev` for the health probe and
   `wss://meowdoku-party.pre0.workers.dev` for the game socket. A
   Content-Security-Policy is a security boundary and is reviewed as source, so
   it is edited rather than configured; no wildcard, and no other origin. Point
   the Worker somewhere else and this line has to be edited in the same commit
   or every connection is blocked in the browser.
3. `ALLOWED_ORIGINS` in `wrangler.toml`, which is the same agreement from the
   other side: the Worker refuses sockets from origins it does not recognise,
   so it has to be told the frontend's. Leave it unset for local development,
   where the dev server's port moves around.
