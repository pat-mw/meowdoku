# Meowdoku

An ad-free, installable web clone of a Star-Battle/Queens-style logic puzzle,
with cats.

Place exactly one cat in every row, every column and every colour region, and
never let two cats touch — not even diagonally. Every puzzle has exactly one
solution and can be solved by pure deduction.

- **No ads, no accounts, no analytics, no backend.** Nothing leaves the device.
- **Fully offline** after the first load, and installable to the home screen on
  iOS and Android.
- **Unbounded levels.** Level _N_ is a deterministic pure function of _N_, so
  every player sees the same puzzle at level 4,812, forever.

## Getting started

```bash
pnpm install
pnpm dev
```

| Script           | What it does                                    |
| ---------------- | ----------------------------------------------- |
| `pnpm dev`       | Vite dev server                                 |
| `pnpm build`     | Typecheck, then production build to `dist/`     |
| `pnpm typecheck` | `tsc -b --noEmit`                               |
| `pnpm lint`      | ESLint, including the React Compiler hook rules |
| `pnpm test`      | Vitest unit suite                               |
| `pnpm test:e2e`  | Playwright, iPhone 13 and Pixel 5 profiles      |

## Layout

```
src/
  board/        pure game core — types, rules, reducer, hints, scoring
    generator/  seeded level generation, solvers, tier table
  input/        pointer and keyboard gesture handling
  routes/       TanStack Router file routes
  screens/      the screens those routes render
  store/        Zustand stores, persistence and migrations
  ui/           components, design tokens, palette
  pwa/          install prompt, update flow, service worker registration
handover/       the source spec, stack doc and design export
```

`src/board` never imports React and never touches the DOM. It is the shared core
for the app, the generator Web Worker and the tests.

See [DECISIONS.md](DECISIONS.md) for choices the source documents left open.
