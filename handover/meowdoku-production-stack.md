# Meowdoku — Production Stack

Companion to `meowdoku-spec.md`. This document is for the implementation agent and covers *how* the app is built, packaged, stored, shipped, and updated. Product behaviour lives in the spec; where the two disagree, the spec wins on behaviour and this document wins on technology.

## 1. Hard constraints

1. **Installable on iOS and Android without any app store.** Delivered as a Progressive Web App over HTTPS. On Android this means a real install prompt and a standalone window; on iOS it means "Add to Home Screen" from Safari, which launches full-screen with its own icon.
2. **No accounts, no login, no server-side user state.** Ever. There is no backend at all in v1.
3. **Progress persists on the device** across refreshes, relaunches, OS restarts, and app updates.
4. **Fully offline** after the first visit. No network calls during play.
5. **No ads, no trackers, no third-party scripts.**

## 2. Stack summary

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript (strict) | Board logic and level format benefit from types; both agents already work in TS. |
| Build | Vite (latest 6/7) | Fast, first-class PWA plugin, static output. |
| UI | **React 19.2** (latest stable 19.2.x) + **React Compiler** (`babel-plugin-react-compiler`, stable 1.0) | Latest React; the compiler auto-memoises so the board never needs hand-written `memo`/`useMemo`. `ref` is a plain prop; do not use `forwardRef`. |
| Routing | **TanStack Router** (file-based, `@tanstack/react-router` + `@tanstack/router-plugin` for Vite) | Fully type-safe routes and params (`/play/$levelNumber` typed end-to-end). **Not** TanStack Start — see §2.1. |
| State | Zustand + `persist` middleware | Tiny, testable outside React, built-in persistence hook. |
| Storage | IndexedDB via `idb-keyval` (adapter for Zustand persist) | See §4 for why not `localStorage` alone. |
| Styling | Tailwind CSS + CSS variables for design tokens | Design agent's tokens map 1:1 to CSS vars; Tailwind keeps the phone-first layout terse. |
| PWA | `vite-plugin-pwa` (Workbox under the hood) | Generates manifest + service worker with precaching and update flow. |
| Tests | Vitest (unit), Playwright (mobile-viewport e2e), Lighthouse CI | Matches §13 of the spec. |
| Hosting | Cloudflare Pages (or Netlify) | Free tier, global CDN, automatic HTTPS, atomic deploys, preview URLs per branch. |
| CI | GitHub Actions | Lint → typecheck → unit → e2e → Lighthouse → deploy. |
| Level tooling | Node script in `/scripts`, run in CI on demand | Generator/solver never ships to the client. |

### 2.1 Why TanStack Router rather than TanStack Start

Start was evaluated and would work in its SPA mode (prerendered `_shell.html`, CDN-only deploy, no server). It was rejected for v1 because:

- Its prerender step runs an SSR build; any root-route code touching `window`, `localStorage`, or IndexedDB must be guarded. Our persistence is entirely client-side, so this is pure risk with no payoff.
- Its value is server functions/routes, which v1 explicitly has none of.
- It adds bundle weight and build complexity that the type-safe routing (the part we actually want) does not require.

**Upgrade path (documented, not built):** if a backend is ever wanted (daily puzzle endpoint, optional sync), migrate to Start in SPA mode. TanStack Router routes port unchanged. When doing so: (1) wrap all storage access in `typeof window !== 'undefined'` guards or move it out of the root route into a client-only effect; (2) configure `vite-plugin-pwa` to precache `_shell.html` and make the host's SPA rewrite target the shell rather than `index.html`; (3) keep `navigateOnHydrate`/shell flash handled per Start docs.

Dependencies must stay small. Target < 150 kB gzipped total JS. No component libraries, no animation libraries beyond CSS (Framer Motion is allowed only if the design pass calls for gestures CSS can't do; default is CSS transitions + Web Animations API).

## 3. Repository layout

```
meowdoku/
  public/
    icons/            # 192, 512, maskable-512, apple-touch-icon-180, favicon
    levels/pack-01.json
  src/
    routes/           # TanStack Router file routes: __root.tsx, index.tsx, levels.tsx,
                      #   play.$levelNumber.tsx, settings.tsx (routeTree.gen.ts is generated)
    screens/          # screen components used by the routes
    board/            # pure logic: types, reducer, rules, hint solver  ← no React imports
    input/            # pointer/gesture handling (tap, drag, long-press, pinch)
    store/            # zustand stores + persistence + migrations
    ui/               # cells, pills, buttons, overlays, tokens.css
    pwa/              # install prompt logic, update toast, sw registration
  scripts/
    generate-levels.ts
    validate-levels.ts
  tests/
    unit/  e2e/
  vite.config.ts  tailwind.config.ts  playwright.config.ts
```

`src/board` is the core asset. It must have zero DOM dependencies so the level generator, the hint solver, and the tests share it.

## 4. On-device persistence

### 4.1 What is stored

```ts
type SaveFileV1 = {
  schemaVersion: 1;
  currentLevel: number;
  completed: Record<string, { stars: 0|1|2|3; score: number; completedAt: number }>;
  inProgress: null | {
    levelId: string;
    cells: number[];          // flat N*N array of CellState enum
    lives: number;
    revealsLeft: number;
    hintsLeft: number;
    startedAt: number;
  };
  settings: {
    sound: boolean; haptics: boolean; colorBlind: boolean;
    autoX: boolean; reducedMotion: 'system'|'on'|'off'; catSkin: string;
  };
  lifetimeScore: number;
};
```

Write on **every** board mutation (debounced ≤ 100 ms) and on `visibilitychange → hidden`, so backgrounding the app mid-drag loses nothing.

### 4.2 Where it is stored — and the iOS problem

- **Primary: IndexedDB** (via `idb-keyval`, ~600 bytes). Larger quota than `localStorage`, async, and survives better on iOS.
- **Mirror: `localStorage`** holding the same JSON. On boot, load both; take whichever has the newer `savedAt`. This double-write is cheap (< 5 kB) and protects against one store being cleared.
- **Call `navigator.storage.persist()`** on first launch and after install. Where granted (Chrome/Android reliably; Safari partially) the browser won't evict the origin's data under storage pressure.
- **iOS caveat the agent must handle:** Safari can purge script-writable storage for origins the user hasn't visited in 7 days *when browsing in the Safari tab*. An installed home-screen web app has its own storage container and is not subject to that timer in practice, but the user may play in the Safari tab before installing. Therefore:
  - Prompt install early (after the first completed level) — see §5.
  - Provide **Export / Import progress** in Settings (copy a compact base64 string; also offer `navigator.share` where available). This is the user's guaranteed backup path and costs nothing to build.
- **Schema migrations:** `schemaVersion` gate with a migration chain (`v1 → v2 → …`) run on load. Never drop unknown keys; never fail to boot because of a bad save — fall back to a fresh save and keep the corrupt blob under a `backup:` key.

### 4.3 What is *not* stored
Nothing leaves the device. No sync, no analytics, no crash reporting in v1. If crash reporting is ever wanted, it must be opt-in and self-hosted.

## 5. PWA specifics

### 5.1 Manifest (`vite-plugin-pwa` config)

```json
{
  "name": "Meowdoku",
  "short_name": "Meowdoku",
  "start_url": "/?source=pwa",
  "scope": "/",
  "display": "standalone",
  "orientation": "portrait",
  "background_color": "#F5F0EB",
  "theme_color": "#F5F0EB",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/icons/maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

`?source=pwa` lets the app know it was launched from the home screen (for skipping the install nudge) without any tracking.

### 5.2 iOS `<head>` additions (the manifest alone is not enough on iOS)

```html
<link rel="apple-touch-icon" href="/icons/apple-touch-icon-180.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="Meowdoku">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1, user-scalable=no">
```

- `viewport-fit=cover` + `env(safe-area-inset-*)` padding so the top bar clears the notch/Dynamic Island and the toolbar clears the home indicator in standalone mode.
- `user-scalable=no` prevents accidental page zoom on double-tap (which would otherwise fire on cat placement). Board zoom for N ≥ 13 is implemented in-app with CSS transforms, so this does not remove needed functionality.
- Disable pull-to-refresh and rubber-banding on the game screen: `overscroll-behavior: none` on `html, body`, `touch-action: none` on the board.
- Standalone iOS has no back button; every screen needs an in-app back affordance (the spec already has one).

### 5.3 Install flow

- **Android / desktop Chrome:** capture `beforeinstallprompt`, suppress the default, show a custom "Install Meowdoku" card on the Home screen and after the first win. Call `prompt()` on tap. Hide once `appinstalled` fires or `display-mode: standalone` matches.
- **iOS Safari:** no API. Detect `navigator.standalone === false` and iOS UA, then show a small instruction sheet: "Tap Share → Add to Home Screen". Show it at most once per week unless the user opens it from Settings.
- Never block play behind installation.

### 5.4 Service worker & offline

- `registerType: 'prompt'` with `workbox.globPatterns` covering `**/*.{js,css,html,png,svg,woff2,json}` — this precaches the entire app **and all level packs**. Total precache should stay under ~2 MB.
- Runtime caching is unnecessary; there are no runtime requests.
- Font files self-hosted (no Google Fonts CDN) so the offline bundle is complete and no third-party request is made.

### 5.5 Update flow

- SW is generated with `skipWaiting: false`. When a new build is detected, show a non-blocking toast "New version ready — Reload". On tap: post `SKIP_WAITING`, then `location.reload()` once `controllerchange` fires.
- **Never reload mid-puzzle without consent.** The toast is deferred while `inProgress !== null` and the Game screen is active; it surfaces on the next screen change.
- Progress is stored outside the app shell, so updates never touch it. Migrations (§4.2) handle format changes.
- Version string from `package.json` shown in Settings for support.

## 6. Routing & URLs

TanStack Router, history mode, with a SPA fallback rule on the host (`/* → /index.html`). File routes: `/` (`index.tsx`), `/levels`, `/play/$levelNumber` (param validated as a positive integer via `validateSearch`/`params.parse`, so the Game screen receives a typed `number`), `/settings`. Deep-linking to a level is harmless: a `beforeLoad` guard redirects locked levels to `/levels`. Use `<Link>` with typed `to`/`params` everywhere — no string URLs in components. Route tree generation runs via the Vite plugin; commit `routeTree.gen.ts`. `start_url` stays `/` so the app resumes via the store's `currentLevel`, not the URL.

## 7. Performance budgets

| Metric | Budget |
|---|---|
| First load (cold, 4G) | LCP < 1.5 s |
| JS gzipped | < 150 kB |
| Board render 15×15 | < 16 ms per frame during drag-paint |
| Time to interactive from home-screen icon (warm) | < 500 ms |
| Lighthouse PWA / Performance / Accessibility | ≥ 90 each, enforced in CI |

Techniques: cells are plain `div`s with class toggles (no per-cell React re-render on drag — the board reducer batches paint sets and the grid re-renders once per animation frame via `requestAnimationFrame`); region colours via CSS variables; level packs lazy-loaded per pack but precached. The React Compiler handles memoisation — do not add manual `memo`/`useCallback`; if a profile shows a hot path the compiler missed, fix the component so it is compiler-eligible (check `eslint-plugin-react-hooks` compiler rules) rather than hand-memoising.

## 8. Security & privacy

- Static site, no forms, no cookies, no storage of anything identifying.
- Content-Security-Policy header: `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; manifest-src 'self'`. (Tailwind emits static CSS; `unsafe-inline` for style is only needed if the WAAPI sets inline styles — try to drop it.)
- `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `Permissions-Policy` denying everything the app doesn't use.
- Import-progress parsing must be defensive: validate against the schema (Zod or a hand-written guard), reject anything else.

## 9. CI/CD

```
on push / PR:
  pnpm install --frozen-lockfile
  pnpm lint && pnpm typecheck   # lint includes eslint-plugin-react-hooks v7 compiler rules
  pnpm test            # Vitest incl. validate-levels (uniqueness of every shipped level)
  pnpm build
  pnpm test:e2e        # Playwright, iPhone 13 + Pixel 5 profiles
  lighthouse-ci        # against the built output
on main: deploy to Cloudflare Pages (production)
on PR:   deploy preview URL, comment on PR
```

Level generation is a manual workflow (`workflow_dispatch`) that commits a new pack; it is never run on every push.

## 10. Release checklist (v1)

- [ ] Installs on iOS 16+ Safari and Android Chrome; launches standalone with correct icon, splash colour, and safe-area padding.
- [ ] Airplane-mode test: kill the app, disable network, relaunch from the home screen, play a full level.
- [ ] Progress survives: refresh, force-quit, device reboot, and an app update deployed mid-puzzle.
- [ ] Export → wipe site data → Import restores everything.
- [ ] Double-tap on a cell never triggers page zoom on iOS.
- [ ] Drag-paint on a 15×15 board holds 60 fps on a mid-range Android device.
- [ ] `navigator.storage.persist()` requested; result logged in Settings ("Storage: persistent / best-effort").
- [ ] No network requests after load (verify with DevTools offline + network log).
- [ ] Lighthouse ≥ 90 across PWA, Performance, Accessibility.

## 11. Explicitly deferred

Cloud sync (would require accounts), push notifications, App Store / Play Store wrapping (Capacitor/TWA — possible later without changing this stack, but violates the no-store-review goal), server-side level generation, telemetry.
