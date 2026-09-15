import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
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
 * Two of these assertions are graph walks rather than pattern matches, and that
 * is deliberate. The eager walk parses every module reachable from
 * `src/main.tsx` by a *static* import, following the same edges the bundler
 * will, because grepping for an import line would miss the case that actually
 * happens: module A is clean, but it imports B, which imports the party client.
 * The built-output walk identifies multiplayer code in the emitted bundle by
 * strings lifted out of the multiplayer sources, because matching a filename
 * convention only proves the convention — a guard that greps for
 * `multiplayer-*.js` passes just as happily when the chunk has been renamed to
 * something else and precached in full.
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
  MULTIPLAYER_ENTRY: string
  APP_ENTRY: string
  featureOwnedModules: (graph: {
    entries: readonly string[]
    featureEntries: readonly string[]
    staticImportsOf: (id: string) => readonly string[]
    allImportsOf: (id: string) => readonly string[]
  }) => ReadonlySet<string>
  workboxOptions: Record<string, unknown>
}

const {
  MULTIPLAYER_CHUNK_NAME,
  EAGER_MULTIPLAYER_MODULE,
  MULTIPLAYER_ENTRY,
  APP_ENTRY,
  featureOwnedModules,
  workboxOptions,
} = viteConfig

/** Repo-relative, forward-slashed, so assertions read the same on any platform. */
const rel = (file: string): string => relative(ROOT, file).split('\\').join('/')

/**
 * Every place multiplayer source lives. Used only to check what the *eager*
 * graph reaches — what the build owns is decided by walking the module graph,
 * not by these paths, precisely so that a file moving between them cannot
 * change what gets precached.
 */
const MULTIPLAYER_DIRECTORIES = [
  'src/multiplayer/',
  'src/screens/multiplayer/',
  'src/ui/multiplayer/',
] as const

const isMultiplayerModule = (path: string): boolean =>
  path === MULTIPLAYER_ENTRY || MULTIPLAYER_DIRECTORIES.some((dir) => path.startsWith(dir))

type ModuleEdges = {
  /** Specifiers that survive compilation and become real bundler edges. */
  eager: string[]
  /** `import(...)` specifiers, which produce a separate chunk rather than an edge. */
  deferred: string[]
}

const scriptKindOf = (file: string): ts.ScriptKind =>
  file.endsWith('.tsx') || file.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS

const parse = (file: string): ts.SourceFile =>
  ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.ESNext,
    true,
    scriptKindOf(file),
  )

/**
 * The import edges of one module.
 *
 * `import type` and `export type` are dropped: they are erased before the
 * bundler ever sees them, so they cost nothing and are not edges. An inline
 * `import { type A, b }` is kept, because that statement does survive.
 */
const edgesOf = (file: string): ModuleEdges => {
  const source = parse(file)
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
    expect(deferred).toContain(MULTIPLAYER_ENTRY)
  })
})

describe('ownership is derived from the module graph, not from a path pattern', () => {
  /**
   * A miniature of this repo's real shape: the entry, the route shell that
   * holds the one dynamic import, the connectivity probe the home screen loads
   * eagerly, feature modules spread across three differently-cased directories,
   * the socket library, and shared code reached from both sides.
   *
   * The differently-cased directories are the whole point. The rule this
   * exercises replaced a path pattern that recognised `src/multiplayer/` and
   * `src/screens/Multiplayer` and nothing else, so `src/screens/multiplayer/`
   * and `src/ui/multiplayer/` went unowned, the chunk lost its name, and the
   * service worker precached the feature for every single-player install.
   */
  const SYNTHETIC: Record<string, { static?: string[]; dynamic?: string[] }> = {
    'src/main.tsx': { static: ['src/routeTree.gen.ts'] },
    'src/routeTree.gen.ts': { static: ['src/routes/multiplayer.tsx', 'src/routes/index.tsx'] },
    'src/routes/index.tsx': { static: ['src/screens/HomeScreen.tsx'] },
    'src/screens/HomeScreen.tsx': { static: ['src/multiplayer/connection.ts', 'src/ui/Board.tsx'] },
    'src/multiplayer/connection.ts': {},
    'src/routes/multiplayer.tsx': {
      static: ['src/ui/chrome.tsx'],
      dynamic: ['src/screens/MultiplayerScreen.tsx'],
    },
    'src/screens/MultiplayerScreen.tsx': {
      static: ['src/screens/multiplayer/RoomScreen.tsx', 'src/multiplayer/store.ts'],
    },
    'src/screens/multiplayer/RoomScreen.tsx': {
      static: ['src/ui/multiplayer/ProgressRace.tsx', 'src/ui/Board.tsx'],
    },
    'src/ui/multiplayer/ProgressRace.tsx': { static: ['src/board/rules.ts'] },
    'src/multiplayer/store.ts': {
      static: ['src/multiplayer/client.ts', 'src/multiplayer/match.ts'],
    },
    'src/multiplayer/client.ts': { static: ['node_modules/partysocket/dist/index.js'] },
    'src/multiplayer/match.ts': {},
    'node_modules/partysocket/dist/index.js': {},
    'src/ui/Board.tsx': { static: ['src/board/rules.ts'] },
    'src/ui/chrome.tsx': {},
    'src/board/rules.ts': {},
  }

  const owned = featureOwnedModules({
    entries: ['src/main.tsx'],
    featureEntries: ['src/screens/MultiplayerScreen.tsx'],
    staticImportsOf: (id) => SYNTHETIC[id]?.static ?? [],
    allImportsOf: (id) => [...(SYNTHETIC[id]?.static ?? []), ...(SYNTHETIC[id]?.dynamic ?? [])],
  })

  it('owns every module the feature reaches, in whatever directory', () => {
    expect([...owned].sort()).toEqual([
      'node_modules/partysocket/dist/index.js',
      'src/multiplayer/client.ts',
      'src/multiplayer/match.ts',
      'src/multiplayer/store.ts',
      'src/screens/MultiplayerScreen.tsx',
      'src/screens/multiplayer/RoomScreen.tsx',
      'src/ui/multiplayer/ProgressRace.tsx',
    ])
  })

  it('leaves shared code and the eager probe to the main chunk', () => {
    // A chunk containing any of these is one the main bundle depends on, and
    // naming it `multiplayer-*` would exclude the main bundle's own dependency
    // from the precache — an install that cannot start offline.
    expect(owned.has('src/board/rules.ts')).toBe(false)
    expect(owned.has('src/ui/Board.tsx')).toBe(false)
    expect(owned.has('src/ui/chrome.tsx')).toBe(false)
    expect(owned.has(EAGER_MULTIPLAYER_MODULE)).toBe(false)
    expect(owned.has(APP_ENTRY)).toBe(false)
  })

  it('stops owning a module the moment the main bundle reaches it', () => {
    // The rule is subtraction, so a single new static import from the eager
    // side has to hand the module back rather than leave two copies of it.
    const captured = featureOwnedModules({
      entries: ['src/main.tsx'],
      featureEntries: ['src/screens/MultiplayerScreen.tsx'],
      staticImportsOf: (id) =>
        id === 'src/screens/HomeScreen.tsx'
          ? [...(SYNTHETIC[id]?.static ?? []), 'src/multiplayer/store.ts']
          : (SYNTHETIC[id]?.static ?? []),
      allImportsOf: (id) => [...(SYNTHETIC[id]?.static ?? []), ...(SYNTHETIC[id]?.dynamic ?? [])],
    })

    expect(captured.has('src/multiplayer/store.ts')).toBe(false)
    // And everything below it, which the main bundle now also has.
    expect(captured.has('node_modules/partysocket/dist/index.js')).toBe(false)
  })

  it('names a lazy entry point that exists and is the one the route imports', () => {
    // The build throws when this file is missing, but only at build time. Here
    // it fails in the unit suite, where a rename is being made.
    expect(existsSync(resolve(ROOT, MULTIPLAYER_ENTRY))).toBe(true)
    expect(existsSync(resolve(ROOT, APP_ENTRY))).toBe(true)
  })

  it('covers all three real multiplayer directories from that entry point', () => {
    // The synthetic graph above is only worth something if the real feature has
    // the shape it models. Walking the actual sources from the lazy entry must
    // reach code in every directory multiplayer occupies.
    const reached = new Set<string>()
    const queue = [resolve(ROOT, MULTIPLAYER_ENTRY)]
    while (queue.length > 0) {
      const file = queue.pop()
      if (file === undefined || reached.has(file) || !PARSEABLE.test(file)) continue
      reached.add(file)
      const edges = edgesOf(file)
      for (const specifier of [...edges.eager, ...edges.deferred]) {
        if (specifier.startsWith('.')) queue.push(resolveRelative(file, specifier))
      }
    }

    const paths = [...reached].map(rel)
    for (const directory of MULTIPLAYER_DIRECTORIES) {
      expect(
        paths.some((path) => path.startsWith(directory)),
        `nothing under ${directory} is reachable from ${MULTIPLAYER_ENTRY}`,
      ).toBe(true)
    }
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

  it('excludes the multiplayer chunk name from the precache glob', () => {
    // This only states the intent. Whether the intent was carried out is a
    // question about the emitted files, and is answered below by reading them.
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
  /**
   * Every file the service worker will download and keep, read out of the
   * generated worker rather than predicted from the glob patterns.
   */
  const precachedUrls = (): string[] => {
    const serviceWorker = readFileSync(resolve(DIST, 'sw.js'), 'utf8')
    return [...serviceWorker.matchAll(/\{\s*url\s*:\s*"([^"]+)"/g)].flatMap((match) =>
      match[1] === undefined ? [] : [match[1]],
    )
  }

  const gzipped = (file: string): number => gzipSync(readFileSync(file)).length

  const distFiles = (): string[] => {
    const walk = (directory: string): string[] =>
      readdirSync(directory).flatMap((name) => {
        const path = join(directory, name)
        return statSync(path).isDirectory() ? walk(path) : [path]
      })
    return walk(DIST).map((path) => relative(DIST, path).split('\\').join('/'))
  }

  /**
   * String literals that occur in multiplayer source and nowhere else.
   *
   * This is how a chunk is identified as containing multiplayer code without
   * trusting its name — which is the only identification worth making, because
   * the name is exactly what broke last time. String data survives
   * minification: class lists, copy and cue names come out of the bundler
   * intact even though every identifier around them has been renamed.
   *
   * Module specifiers are skipped because the bundler rewrites or erases them,
   * and the connectivity probe is skipped because it is deliberately part of
   * the main chunk.
   */
  const signaturesByFile = (): Map<string, string[]> => {
    const sources = (directory: string): string[] => {
      const full = resolve(ROOT, directory)
      if (!existsSync(full)) return []
      return readdirSync(full).flatMap((name) => {
        const path = join(full, name)
        if (statSync(path).isDirectory()) return sources(join(directory, name))
        return PARSEABLE.test(path) ? [rel(path)] : []
      })
    }

    const multiplayerFiles = [
      MULTIPLAYER_ENTRY,
      ...MULTIPLAYER_DIRECTORIES.flatMap((directory) => sources(directory)),
    ].filter((path) => path !== EAGER_MULTIPLAYER_MODULE)

    const otherSources = [...sources('src'), ...sources('party')]
      .filter((path) => !multiplayerFiles.includes(path))
      .map((path) => readFileSync(resolve(ROOT, path), 'utf8'))
      .join('\n')

    const literalsOf = (file: string): string[] => {
      const found: string[] = []
      const visit = (node: ts.Node): void => {
        // Import and export statements hold only module specifiers, which the
        // bundler rewrites or erases, so nothing under them survives as data.
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return
        if (
          (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
          node.text.length >= 20
        ) {
          found.push(node.text)
        }
        ts.forEachChild(node, visit)
      }
      visit(parse(resolve(ROOT, file)))
      return found
    }

    const byFile = new Map<string, string[]>()
    for (const file of multiplayerFiles) {
      const unique = [...new Set(literalsOf(file))].filter(
        (literal) => !otherSources.includes(literal),
      )
      if (unique.length > 0) byFile.set(file, unique)
    }
    return byFile
  }

  const signatures = signaturesByFile()
  const allSignatures = [...signatures.values()].flat()

  /** Emitted scripts, mapped to whether they carry any multiplayer code. */
  const scripts = distFiles()
    .filter((path) => path.endsWith('.js'))
    .map((path) => {
      const text = readFileSync(resolve(DIST, path), 'utf8')
      return { path, carries: allSignatures.filter((signature) => text.includes(signature)) }
    })

  it('has signatures that actually identify the emitted feature code', () => {
    // Without this, every assertion below passes on an empty signature set —
    // the same vacuous pass that let a renamed chunk sit in the precache
    // manifest unnoticed. Both files named here are ones a path pattern once
    // failed to recognise.
    expect(signatures.size).toBeGreaterThanOrEqual(8)
    expect([...signatures.keys()]).toContain('src/screens/multiplayer/RoomScreen.tsx')
    expect([...signatures.keys()]).toContain('src/ui/multiplayer/ProgressRace.tsx')

    const located = new Set(
      scripts.flatMap((script) => (script.carries.length > 0 ? script.carries : [])),
    )
    const missing = [...signatures.keys()].filter((file) =>
      (signatures.get(file) ?? []).every((signature) => !located.has(signature)),
    )
    expect(missing, 'multiplayer source that no emitted script contains').toEqual([])

    expect(precachedUrls().length).toBeGreaterThan(10)
  })

  it('precaches no script containing multiplayer code', () => {
    // The assertion that matters, and the one stated positively: not "no file
    // called multiplayer-* is precached" but "nothing the service worker
    // downloads contains the feature". A rename, a lost chunk name or a stray
    // import all fail here, because none of them changes what the bytes say.
    const precached = new Set(precachedUrls())
    const offenders = scripts
      .filter((script) => script.carries.length > 0 && precached.has(script.path))
      .map((script) => `${script.path} (${script.carries.length} multiplayer strings)`)
    expect(offenders).toEqual([])
  })

  it('keeps the feature in one chunk that is fetched on demand', () => {
    const carriers = scripts.filter((script) => script.carries.length > 0).map((s) => s.path)
    expect(carriers.length).toBe(1)
    expect(carriers[0]).toMatch(
      new RegExp(`^assets/${MULTIPLAYER_CHUNK_NAME}-[A-Za-z0-9_-]+\\.js$`),
    )

    // Vite writes a modulepreload link for every chunk the entry statically
    // depends on. The multiplayer chunk appearing there would mean something
    // eager reached it, whatever the import graph said.
    const html = readFileSync(resolve(DIST, 'index.html'), 'utf8')
    expect(html).not.toContain(carriers[0] ?? 'assets/')
  })

  it('keeps the main chunk inside its budget', () => {
    const main = distFiles().filter((path) => /^assets\/index-[^/]+\.js$/.test(path))
    expect(main.length).toBe(1)
    const size = gzipped(resolve(DIST, main[0] ?? ''))

    // The budget for the script every install downloads is 150 kB gzipped.
    expect(size).toBeLessThanOrEqual(150 * 1024)
    // Measured at 124,587 bytes gzipped. The tighter bound is the one that
    // notices multiplayer leaking back in: the whole feature is 28,521 bytes
    // gzipped, so even a fraction of it returning would clear the budget above
    // and still be a regression worth stopping.
    expect(size).toBeLessThanOrEqual(132 * 1024)
  })

  it('keeps the single stylesheet small enough that not splitting it is fine', () => {
    // `cssCodeSplit` is off and one sheet is emitted, so the multiplayer-only
    // Tailwind utilities are downloaded by every install. Splitting would not
    // help: Tailwind compiles the whole scanned utility surface into the one
    // sheet `src/main.tsx` imports, and turning code splitting on emits the
    // same bytes under a different name. Measured, the multiplayer-only rules
    // are 4,242 bytes raw and ~740 gzipped of a 7,862-byte sheet — smaller than
    // the round trip a second stylesheet would cost. This cap is what stops
    // "negligible" quietly becoming untrue.
    const sheets = distFiles().filter((path) => path.endsWith('.css'))
    expect(sheets.length).toBe(1)
    expect(gzipped(resolve(DIST, sheets[0] ?? ''))).toBeLessThanOrEqual(9 * 1024)
  })

  it('keeps the precache small enough to install over a bad connection', () => {
    const urls = precachedUrls()
    const present = new Set(distFiles())
    for (const url of urls) {
      expect(present.has(url), `${url} is precached but was not emitted`).toBe(true)
    }

    // 16 entries, of which the three icons are listed twice — once from the glob
    // and once from the web app manifest — so the download is 13 distinct files
    // and 581,658 bytes. Fonts and icons are most of it; the multiplayer chunk
    // that used to be here was another 87,877. The cap leaves less headroom than
    // that chunk, so its return cannot pass unnoticed.
    const total = [...new Set(urls)].reduce(
      (sum, url) => sum + statSync(resolve(DIST, url)).size,
      0,
    )
    expect(total).toBeLessThanOrEqual(600 * 1024)
  })
})
