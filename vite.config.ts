import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import { VitePWA } from 'vite-plugin-pwa'

const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as {
  version: string
}

/**
 * The name every wholly-multiplayer chunk is emitted under.
 *
 * Multiplayer is reached through one dynamic import, so the bundler splits it
 * out on its own — but into a filename derived from whatever module happened to
 * be the import target. That name is not something the service worker can be
 * told about in advance, and the service worker has to be told: a precached
 * multiplayer chunk is downloaded by every single-player install, which is the
 * same mistake as bundling it, deferred by a few seconds. So the name is
 * assigned from the chunk's contents instead of inherited from a filename, and
 * the precache manifest excludes it by that name.
 */
export const MULTIPLAYER_CHUNK_NAME = 'multiplayer'

/**
 * The one multiplayer module the main menu may load eagerly.
 *
 * The menu has to decide whether to offer multiplayer before the player has
 * asked for it, so the reachability probe is unavoidably on the home screen's
 * critical path. It is a URL builder and a `fetch` with no imports of its own,
 * which is the only reason the exception is affordable — and it stays that way
 * because tests/unit/offline-guard.test.ts refuses to let anything else in the
 * feature become reachable from the entry point.
 */
export const EAGER_MULTIPLAYER_MODULE = 'src/multiplayer/connection.ts'

/**
 * Module ids that belong to the multiplayer feature: its own source, its
 * screens, and the WebSocket client it is the only consumer of. `[\\/]` rather
 * than `/` so the patterns hold when the build runs on Windows.
 *
 * Nothing shared with single-player appears here, and that is the point. The
 * board core, the reducer, the store and `src/ui` stay in the main chunk where
 * they already are; a multiplayer session imports them from there rather than
 * carrying a second copy of the game.
 */
export const MULTIPLAYER_MODULE_TEST =
  /[\\/](?:src[\\/]multiplayer[\\/]|src[\\/]screens[\\/]Multiplayer|partysocket[\\/])/

/**
 * True when every module in a chunk belongs to multiplayer.
 *
 * Deliberately not "any module": a chunk that mixed feature code with shared
 * code would be one the main bundle has to import, and renaming it would hide
 * that rather than fix it. Such a chunk should fail the offline guard, not be
 * quietly excluded from the precache.
 */
const isMultiplayerChunk = (moduleIds: readonly string[]): boolean =>
  moduleIds.length > 0 && moduleIds.every((id) => MULTIPLAYER_MODULE_TEST.test(id))

/**
 * Service worker generation, exported so it can be asserted on.
 *
 * Two properties matter beyond the caching behaviour itself and both are
 * checked by tests/unit/offline-guard.test.ts:
 *
 *   - No entry here names a foreign origin, and there is no `runtimeCaching` at
 *     all. A generated Workbox service worker with no runtime routes can only
 *     answer for URLs in its precache manifest, every one of which is a file
 *     this build emitted. A request to the party server therefore matches no
 *     route and goes straight to the network. (A WebSocket upgrade never
 *     reaches a service worker in the first place; the party server's plain
 *     HTTP endpoints do, and this is what lets them through untouched.)
 *
 *   - The multiplayer chunk is not precached. Precaching it would hand every
 *     single-player install a copy of code it will never run, which is the same
 *     mistake as bundling it — just deferred by a few seconds.
 */
export const workboxOptions = {
  globPatterns: ['**/*.{js,css,html,png,svg,woff2,json,ico}'],
  globIgnores: [`**/${MULTIPLAYER_CHUNK_NAME}-*.js`, `**/${MULTIPLAYER_CHUNK_NAME}-*.js.map`],
  skipWaiting: false,
  clientsClaim: false,
  cleanupOutdatedCaches: true,
  navigateFallback: '/index.html',
  navigateFallbackDenylist: [/^\/assets\//, /^\/icons\//, /^\/fonts\//],
}

export default defineConfig({
  define: {
    // Surfaced in Settings so a player can quote a build when reporting a problem.
    __APP_VERSION__: JSON.stringify(version),
  },
  plugins: [
    tanstackRouter({ target: 'react', autoCodeSplitting: false }),
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: null,
      manifest: {
        name: 'Meowdoku',
        short_name: 'Meowdoku',
        description:
          'A cosy logic puzzle. Place one cat per colour, row and column — and never let them touch.',
        start_url: '/?source=pwa',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#F5F0EB',
        theme_color: '#F5F0EB',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icons/maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: workboxOptions,
      devOptions: { enabled: false },
    }),
  ],
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    cssCodeSplit: false,
    reportCompressedSize: true,
    rollupOptions: {
      output: {
        chunkFileNames: (chunk) =>
          isMultiplayerChunk(chunk.moduleIds)
            ? `assets/${MULTIPLAYER_CHUNK_NAME}-[hash].js`
            : 'assets/[name]-[hash].js',
      },
    },
  },
})
