import { readFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'
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
 * The module the document loads, and the root of everything every install
 * downloads before it runs a line of application code.
 */
export const APP_ENTRY = 'src/main.tsx'

/**
 * The lazily-imported module the whole multiplayer feature hangs off — the
 * target of the single `import(...)` in `src/routes/multiplayer.tsx`.
 *
 * Ownership of the feature is derived from this one file by walking the
 * bundler's own module graph, rather than from a list of paths. A path list has
 * to be edited every time a file moves, and when it is not, the failure is
 * silent: modules quietly stop being recognised, the chunk falls back to a
 * different name and the service worker precaches the lot. A graph walk cannot
 * drift, because it asks the same question the bundler does.
 */
export const MULTIPLAYER_ENTRY = 'src/screens/MultiplayerScreen.tsx'

/**
 * A module graph, expressed as the two questions ownership depends on. Modelled
 * as functions so the rule below is a pure function of a graph and can be
 * exercised on a synthetic one, rather than only by running a build.
 */
export type ImportGraph = {
  /** Entry modules. Everything statically reachable from one ships eagerly. */
  entries: readonly string[]
  /** Roots of the feature being isolated; each is reached only by `import(...)`. */
  featureEntries: readonly string[]
  /** Ids imported with a static `import`, which are edges within a chunk graph. */
  staticImportsOf: (id: string) => readonly string[]
  /** Ids imported at all, statically or dynamically. */
  allImportsOf: (id: string) => readonly string[]
}

/** Every id reachable from `roots` by following `next`. */
const closure = (
  roots: readonly string[],
  next: (id: string) => readonly string[],
): Set<string> => {
  const seen = new Set<string>()
  const queue = [...roots]
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
    if (seen.has(id)) continue
    seen.add(id)
    queue.push(...next(id))
  }
  return seen
}

/**
 * The modules that belong to the feature and to nothing else.
 *
 * Defined by subtraction: everything reachable from the feature's lazy entry,
 * minus everything already reachable from an entry point by a static import.
 * That subtraction is what keeps shared code shared — the board core, the game
 * store, `src/ui`, React itself and the connectivity probe on the home screen
 * are all in the eager closure, so a multiplayer session imports them from the
 * main chunk instead of carrying a second copy. The walk stops at an eager
 * module rather than descending through it, because a module the main bundle
 * already has brings its own dependencies with it.
 */
export const featureOwnedModules = (graph: ImportGraph): ReadonlySet<string> => {
  const eager = closure(graph.entries, graph.staticImportsOf)
  const shared = (id: string): boolean => eager.has(id)
  return closure(
    graph.featureEntries.filter((id) => !shared(id)),
    (id) => graph.allImportsOf(id).filter((imported) => !shared(imported)),
  )
}

/** Module ids are absolute paths, Windows-separated on Windows and often suffixed. */
const modulePath = (id: string): string => {
  const [bare] = id.split('\\').join('/').split('?')
  return bare ?? ''
}

const isModule = (id: string, repoRelative: string): boolean =>
  modulePath(id).endsWith(`/${repoRelative}`)

/**
 * Computes multiplayer's ownership from the graph the bundler just built, and
 * answers whether a chunk is wholly multiplayer's.
 *
 * "Wholly" is deliberate, and stricter than "contains any": a chunk mixing
 * feature code with shared code is one the main bundle has to import, and
 * renaming it would hide that rather than fix it. Such a chunk keeps the
 * default name and gets precached, which is wrong but loudly wrong — the
 * offline guard fails on it instead of quietly shipping a broken install.
 */
const multiplayerOwnership = (): {
  plugin: Plugin
  isMultiplayerChunk: (moduleIds: readonly string[]) => boolean
} => {
  let owned: ReadonlySet<string> = new Set()

  const plugin: Plugin = {
    name: 'meowdoku:multiplayer-ownership',
    buildEnd() {
      const ids = [...this.getModuleIds()]

      // Web workers are bundled by a separate pass over the same plugin list,
      // and that pass contains neither entry. It has nothing to classify, and
      // must not clear a classification the application pass established.
      if (!ids.some((id) => isModule(id, APP_ENTRY))) return

      const featureEntries = ids.filter((id) => isModule(id, MULTIPLAYER_ENTRY))
      if (featureEntries.length === 0) {
        throw new Error(
          `${MULTIPLAYER_ENTRY} is not in the module graph, so no chunk can be recognised as ` +
            'multiplayer and the service worker would precache the feature for every ' +
            'single-player install. Point MULTIPLAYER_ENTRY at the module the multiplayer ' +
            'route lazily imports.',
        )
      }

      owned = featureOwnedModules({
        entries: ids.filter((id) => this.getModuleInfo(id)?.isEntry === true),
        featureEntries,
        staticImportsOf: (id) => this.getModuleInfo(id)?.importedIds ?? [],
        allImportsOf: (id) => {
          const info = this.getModuleInfo(id)
          return [...(info?.importedIds ?? []), ...(info?.dynamicallyImportedIds ?? [])]
        },
      })
    },
  }

  return {
    plugin,
    isMultiplayerChunk: (moduleIds) =>
      moduleIds.length > 0 && moduleIds.every((id) => owned.has(id)),
  }
}

const multiplayer = multiplayerOwnership()

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
    multiplayer.plugin,
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
    // One stylesheet, and splitting it would not change that. Tailwind compiles
    // the whole scanned utility surface into the single sheet `src/main.tsx`
    // imports, so there is nothing per-chunk to separate: turning code splitting
    // on emits the same file, byte for byte. The multiplayer-only utilities in
    // it are worth roughly 0.7 kB gzipped of a ~7.9 kB sheet, and prising them
    // out would mean a second stylesheet and a second request for a saving
    // smaller than one HTTP round trip. tests/unit/offline-guard.test.ts caps
    // the sheet so that "small enough to ignore" has to stay true.
    cssCodeSplit: false,
    reportCompressedSize: true,
    rollupOptions: {
      output: {
        chunkFileNames: (chunk) =>
          multiplayer.isMultiplayerChunk(chunk.moduleIds)
            ? `assets/${MULTIPLAYER_CHUNK_NAME}-[hash].js`
            : 'assets/[name]-[hash].js',
      },
    },
  },
})
