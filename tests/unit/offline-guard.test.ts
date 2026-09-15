import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

/**
 * The seam between multiplayer and the offline-first app.
 *
 * Everything asserted here is something that breaks silently. A stray import
 * drags the whole feature into the bundle every player downloads and nothing
 * complains; a party origin missing from the Content-Security-Policy only fails
 * in a real browser on a real deployment; a chunk left in the precache manifest
 * just makes the install quietly bigger. None of it shows up in a typecheck, a
 * lint or a passing screen test, so it is checked mechanically instead.
 *
 * The import-graph test is the important one and it is a real graph walk: the
 * TypeScript parser reads every module reachable from `src/main.tsx` by a
 * *static* import, following the same edges the bundler will. Grepping for an
 * import line would miss the case that actually happens — module A is clean,
 * but it imports B, which imports the party client.
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const ENTRY = resolve(ROOT, 'src/main.tsx')

/**
 * The lazily-loaded route is the only door into the feature. It is part of the
 * eager graph by necessity — the generated route tree imports every route — so
 * it is also the file with the most to prove.
 */
const ROUTE_SHELL = resolve(ROOT, 'src/routes/multiplayer.tsx')

/** Build configuration is the source of truth for the chunking rules it declares. */
const viteConfig = (await import(
  /* @vite-ignore */ new URL('../../vite.config.ts', import.meta.url).href
)) as {
  MULTIPLAYER_CHUNK_NAME: string
  EAGER_MULTIPLAYER_MODULE: string
  MULTIPLAYER_MODULE_TEST: RegExp
  workboxOptions: Record<string, unknown>
}

const {
  MULTIPLAYER_CHUNK_NAME,
  EAGER_MULTIPLAYER_MODULE,
  MULTIPLAYER_MODULE_TEST,
  workboxOptions,
} = viteConfig

/** Repo-relative, forward-slashed, so assertions read the same on any platform. */
const rel = (file: string): string => relative(ROOT, file).split('\\').join('/')

const isMultiplayerModule = (path: string): boolean =>
  path.startsWith('src/multiplayer/') || path.startsWith('src/screens/Multiplayer')

type ModuleEdges = {
  /** Specifiers that survive compilation and become real bundler edges. */
  eager: string[]
  /** `import(...)` specifiers, which produce a separate chunk rather than an edge. */
  deferred: string[]
}

const scriptKindOf = (file: string): ts.ScriptKind =>
  file.endsWith('.tsx') || file.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS

/**
 * The import edges of one module.
 *
 * `import type` and `export type` are dropped: they are erased before the
 * bundler ever sees them, so they cost nothing and are not edges. An inline
 * `import { type A, b }` is kept, because that statement does survive.
 */
const edgesOf = (file: string): ModuleEdges => {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.ESNext,
    true,
    scriptKindOf(file),
  )
  const eager: string[] = []
  const deferred: string[] = []

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      if (node.importClause?.isTypeOnly !== true && ts.isStringLiteral(node.moduleSpecifier)) {
        eager.push(node.moduleSpecifier.text)
      }
    } else if (ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier
      if (!node.isTypeOnly && specifier !== undefined && ts.isStringLiteral(specifier)) {
        eager.push(specifier.text)
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments
      if (argument !== undefined && ts.isStringLiteral(argument)) deferred.push(argument.text)
    }
    ts.forEachChild(node, visit)
  }

  visit(source)
  return { eager, deferred }
}

const EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx']
const PARSEABLE = /\.(?:ts|tsx|js|jsx)$/

/** Resolves a relative specifier the way the bundler will, or throws. */
const resolveRelative = (from: string, specifier: string): string => {
  const [bare] = specifier.split('?')
  const base = resolve(dirname(from), bare ?? specifier)
  for (const extension of EXTENSIONS) {
    const candidate = `${base}${extension}`
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  throw new Error(`${rel(from)} imports '${specifier}', which resolves to nothing`)
}

/** Every module the browser loads before it runs a line of application code. */
const walkEagerGraph = (entry: string) => {
  const modules = new Map<string, ModuleEdges>()
  const packages = new Set<string>()
  const queue = [entry]

  while (queue.length > 0) {
    const file = queue.pop()
    if (file === undefined || modules.has(file)) continue
    if (!PARSEABLE.test(file)) {
      // Stylesheets and assets are leaves: real modules, but nothing to follow.
      modules.set(file, { eager: [], deferred: [] })
      continue
    }
    const edges = edgesOf(file)
    modules.set(file, edges)
    for (const specifier of edges.eager) {
      if (specifier.startsWith('.')) queue.push(resolveRelative(file, specifier))
      else packages.add(specifier)
    }
  }

  return { modules, packages }
}

const graph = walkEagerGraph(ENTRY)
const eagerFiles = [...graph.modules.keys()].map(rel)

describe('the multiplayer chunk stays out of the main bundle', () => {
  it('walks a graph big enough to be worth trusting', () => {
    // A resolver bug that quietly stopped at the entry point would make every
    // other assertion in this block pass for the wrong reason.
    expect(eagerFiles).toContain('src/main.tsx')
    expect(eagerFiles).toContain('src/routeTree.gen.ts')
    expect(eagerFiles).toContain('src/screens/HomeScreen.tsx')
    expect(eagerFiles).toContain('src/routes/multiplayer.tsx')
    expect(eagerFiles.length).toBeGreaterThan(20)
  })

  it('reaches no multiplayer module but the connectivity probe', () => {
    const reached = eagerFiles.filter(isMultiplayerModule).sort()
    expect(reached.filter((path) => path !== EAGER_MULTIPLAYER_MODULE)).toEqual([])
  })

  it('keeps the connectivity probe free of dependencies', () => {
    // The probe is what the home screen calls to decide whether to offer
    // multiplayer, so it is the one module allowed onto the critical path, and
    // its import list is the whole budget for that exception. React and nothing
    // else: the moment it reaches for the protocol or the socket, the exception
    // has become the feature.
    expect(edgesOf(resolve(ROOT, EAGER_MULTIPLAYER_MODULE)).eager).toEqual(['react'])
  })

  it('pulls in no socket library', () => {
    const socketPackages = [...graph.packages].filter((name) => name.startsWith('partysocket'))
    expect(socketPackages).toEqual([])
  })

  it('reaches the multiplayer screens only through a dynamic import', () => {
    const shell = graph.modules.get(ROUTE_SHELL)
    expect(shell, 'the route shell is not in the eager graph').toBeDefined()

    const eagerLocal = (shell?.eager ?? [])
      .filter((specifier) => specifier.startsWith('.'))
      .map((specifier) => rel(resolveRelative(ROUTE_SHELL, specifier)))
    expect(eagerLocal.filter(isMultiplayerModule)).toEqual([])

    const deferred = (shell?.deferred ?? []).map((specifier) =>
      rel(resolveRelative(ROUTE_SHELL, specifier)),
    )
    expect(deferred.some(isMultiplayerModule)).toBe(true)
  })

  it('recognises a multiplayer module by its path, and only a multiplayer one', () => {
    // This is the predicate the build uses to decide what counts as a
    // multiplayer chunk, and therefore what the service worker leaves alone.
    // Every file it names is here so that a move — screens into a folder, a
    // second socket package — fails loudly rather than silently widening or
    // narrowing the precache.
    const owned = (path: string): boolean => MULTIPLAYER_MODULE_TEST.test(`/${path}`)

    expect(owned('src/multiplayer/protocol.ts')).toBe(true)
    expect(owned('src/multiplayer/match.ts')).toBe(true)
    expect(owned(EAGER_MULTIPLAYER_MODULE)).toBe(true)
    expect(owned('src/screens/MultiplayerScreen.tsx')).toBe(true)
    expect(owned('node_modules/.pnpm/partysocket@1.3.0/node_modules/partysocket/dist/index.js')) //
      .toBe(true)

    // Shared code must stay shared. A chunk containing any of these is one the
    // main bundle depends on, and naming it `multiplayer-*` would exclude the
    // main bundle's own dependency from the precache.
    expect(owned('src/board/reducer.ts')).toBe(false)
    expect(owned('src/store/useGameStore.ts')).toBe(false)
    expect(owned('src/ui/Board.tsx')).toBe(false)
    expect(owned('src/screens/GameScreen.tsx')).toBe(false)
  })
})

describe('the service worker ignores the party origin', () => {
  const asStrings = (value: unknown): string[] => {
    if (typeof value === 'string') return [value]
    if (value instanceof RegExp) return [value.source]
    if (Array.isArray(value)) return value.flatMap(asStrings)
    if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(asStrings)
    return []
  }

  it('has no runtime caching at all', () => {
    // A generated Workbox worker with no runtime routes can only answer for
    // URLs in its precache manifest, and every one of those is a file this
    // build emitted. A request to the party server therefore matches nothing
    // and goes straight to the network — no interception, no cached reply, no
    // navigation fallback. (A WebSocket upgrade never reaches a service worker
    // at all; this is what lets the party server's HTTP endpoints through.)
    expect(workboxOptions['runtimeCaching']).toBeUndefined()
    expect(workboxOptions['navigateFallback']).toBe('/index.html')
  })

  it('names no origin but our own', () => {
    const foreign = asStrings(workboxOptions).filter((value) => /:\/\/|^wss?:|^https?:/.test(value))
    expect(foreign).toEqual([])
  })

  it('leaves the multiplayer chunk out of the precache manifest', () => {
    // Precaching it would hand every single-player install a copy of code it
    // will never run — the same mistake as bundling it, deferred by a few
    // seconds of background download.
    expect(workboxOptions['globIgnores']).toContain(`**/${MULTIPLAYER_CHUNK_NAME}-*.js`)
  })
})

describe('the Content-Security-Policy allows exactly the party origin', () => {
  const vercelConfig = JSON.parse(readFileSync(resolve(ROOT, 'vercel.json'), 'utf8')) as {
    headers: { source: string; headers: { key: string; value: string }[] }[]
  }

  const csp = vercelConfig.headers
    .flatMap((entry) => entry.headers)
    .find((header) => header.key === 'Content-Security-Policy')?.value

  const directive = (name: string): string[] => {
    const found = (csp ?? '')
      .split(';')
      .map((part) => part.trim())
      .find((part) => part === name || part.startsWith(`${name} `))
    return found === undefined ? [] : found.split(/\s+/).slice(1)
  }

  const connectSrc = directive('connect-src')
  const origins = connectSrc.filter((source) => source !== "'self'")
  const hostsFor = (scheme: string): string[] =>
    origins.filter((o) => o.startsWith(`${scheme}://`)).map((o) => o.slice(scheme.length + 3))

  it('is still there and still restrictive', () => {
    expect(csp).toBeDefined()
    expect(directive('default-src')).toEqual(["'self'"])
    expect(directive('script-src')).toEqual(["'self'"])
    expect(directive('frame-ancestors')).toEqual(["'none'"])
  })

  it('keeps self and adds only concrete origins', () => {
    expect(connectSrc[0]).toBe("'self'")
    expect(origins.length).toBeGreaterThan(0)
    for (const origin of origins) {
      // A scheme-only source (`wss:`), a wildcard host or a path would each
      // allow more than the one server we mean.
      expect(origin, `${origin} is not a concrete https:// or wss:// origin`).toMatch(
        /^(?:https|wss):\/\/[a-z0-9.-]+(?::\d+)?$/,
      )
      expect(origin).not.toContain('*')
    }
  })

  it('allows the health probe and the socket to the same hosts', () => {
    // The client fetches /health over https and then opens a wss socket to the
    // same host. Allowing one without the other is a connection that dies
    // halfway through joining a room.
    expect(hostsFor('wss').sort()).toEqual(hostsFor('https').sort())
  })

  it('does not ship a development host to production', () => {
    for (const host of hostsFor('https')) {
      expect(host).not.toMatch(/^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::|$)/)
    }
  })

  it('widens connect-src and nothing else', () => {
    for (const host of hostsFor('https')) {
      const mentions = (csp ?? '').split(host).length - 1
      expect(mentions, `${host} appears outside connect-src`).toBe(2)
    }
  })

  it('is documented where somebody changing the host will look', () => {
    // The policy cannot be widened by an environment variable, so the host is
    // written down twice and the two have to be changed together.
    const readme = readFileSync(resolve(ROOT, 'README.md'), 'utf8')
    for (const host of hostsFor('https')) expect(readme).toContain(host)

    const example = readFileSync(resolve(ROOT, '.env.example'), 'utf8')
    expect(example).toContain('VITE_PARTY_HOST')
  })
})

/**
 * What the build actually emitted. Skipped when there is no build to look at,
 * so this is a check on `pnpm build && pnpm test`, not a reason for `pnpm test`
 * alone to fail on a clean checkout.
 */
const DIST = resolve(ROOT, 'dist')
const built = existsSync(resolve(DIST, 'index.html')) && existsSync(resolve(DIST, 'sw.js'))

describe.skipIf(!built)('the built output', () => {
  const chunkPrefix = `${MULTIPLAYER_CHUNK_NAME}-`

  it('emits one multiplayer chunk', () => {
    const assets = readdirSync(resolve(DIST, 'assets'))
    const chunks = assets.filter((name) => name.startsWith(chunkPrefix) && name.endsWith('.js'))
    expect(chunks.length).toBe(1)
  })

  it('does not preload it from the document', () => {
    // Vite writes a modulepreload link for every chunk the entry statically
    // depends on. The multiplayer chunk appearing there would mean something
    // eager reached it, whatever the import graph said.
    const html = readFileSync(resolve(DIST, 'index.html'), 'utf8')
    expect(html).not.toContain(chunkPrefix)
  })

  it('does not precache it', () => {
    const serviceWorker = readFileSync(resolve(DIST, 'sw.js'), 'utf8')
    expect(serviceWorker).not.toContain(chunkPrefix)
  })
})
