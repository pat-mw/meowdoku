/**
 * Where the party server lives, and whether it can actually be reached.
 *
 * Two jobs, deliberately in one module, because they are the only part of
 * multiplayer the main menu is allowed to load eagerly.
 *
 * The menu has to decide whether to offer multiplayer at all before the player
 * has expressed any interest in it, so whatever answers that question is on the
 * critical path of the home screen. This file therefore imports nothing: no
 * socket library, no protocol, no store. It is a URL builder and a `fetch`.
 * Everything with weight — `partysocket`, the wire format, the match rules —
 * hangs off `./client` and `./store`, which only a multiplayer route ever
 * pulls in.
 *
 * `navigator.onLine` is not the question being asked. It reports whether a
 * network interface is up, which on a cafe captive portal, a hotel Wi-Fi
 * splash page or a phone with a dead data allowance is enthusiastically true
 * while nothing whatsoever is reachable. The gate therefore performs a real,
 * time-boxed round trip to the party host and insists on recognising what comes
 * back: a portal that answers 200 with its own login page fails the check for
 * the same reason a dead server does, because from the player's point of view
 * they are the same thing.
 *
 * Nothing here ever runs at import time. A launch with no network reaches the
 * home screen exactly as it does today, and the first probe happens only once
 * something renders that cares about the answer.
 */

import { useEffect, useSyncExternalStore } from 'react'

/**
 * The party a room socket belongs to.
 *
 * Room sockets live at `/parties/room/<CODE>`; everything else the server
 * offers is a plain HTTP route at the origin root.
 */
export const PARTY_ROOM_PARTY = 'room'

/** Liveness, protocol version and the server's clock. */
export const PARTY_HEALTH_PATH = '/health'

/** Allocates a room code. */
export const PARTY_ROOMS_PATH = '/rooms'

/**
 * How long a good answer is trusted.
 *
 * Long enough that walking between menu screens does not re-probe, short enough
 * that a player who has just walked out of signal is told so before they try to
 * host a match.
 */
export const CONNECTIVITY_TTL_MS = 30_000

/** A bad answer is retried sooner, since recovery is what the player is waiting for. */
export const CONNECTIVITY_FAILURE_TTL_MS = 5_000

/**
 * The probe's budget.
 *
 * This is a gate on a menu button, not a load-bearing request. A party server
 * that cannot answer a static JSON blob within two and a half seconds cannot
 * run a race either, so a slow answer and no answer are treated alike.
 */
export const CONNECTIVITY_TIMEOUT_MS = 2_500

/**
 * What the menu renders.
 *
 * The two unavailable cases are kept apart because they call for different
 * words: being offline is the player's problem to fix and worth re-checking as
 * soon as the network returns, while the server being down is nobody's problem
 * to fix from here.
 */
export type ConnectivityStatus =
  'checking' | 'available' | 'unavailable-offline' | 'unavailable-server-down'

/** A settled connectivity verdict. `checking` is a state, never a result. */
export type ConnectivityResult = {
  status: Exclude<ConnectivityStatus, 'checking'>
  /** Local epoch ms at which the probe settled. */
  checkedAt: number
  /** Round trip in milliseconds, or null when nothing came back. */
  latencyMs: number | null
  /** The server's clock as reported by the health endpoint, for an early skew estimate. */
  serverTime: number | null
  /**
   * The protocol version the server speaks, or null when it did not answer.
   *
   * Reported rather than enforced: a mismatch is an app that needs reloading,
   * not a server that is down, and the room says so properly on join.
   */
  protocol: number | null
}

/** The snapshot the menu subscribes to. Identity changes only when something changed. */
export type ConnectivitySnapshot = {
  status: ConnectivityStatus
  /** Null until the first probe settles. */
  result: ConnectivityResult | null
  /** True while a probe is in flight, including a refresh of a known-good result. */
  checking: boolean
}

export type ConnectivityOptions = {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  now?: () => number
  /** Overrides `navigator.onLine`; the tests use it, nothing else should. */
  online?: () => boolean
}

const env = import.meta.env as unknown as Record<string, string | undefined>

let hostOverride: string | null = null

/**
 * Trims a configured host down to `host[:port]`.
 *
 * The same value has to serve both a `fetch` URL and `partysocket`'s `host`
 * option, and the two want it written differently, so a scheme or a trailing
 * slash in the environment variable is forgiven rather than fatal.
 */
const normaliseHost = (raw: string | undefined): string | null => {
  if (typeof raw !== 'string') return null
  const trimmed = raw
    .trim()
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/\/+$/, '')
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Points the client at a party host, replacing whatever the build configured.
 *
 * Exists for tests and for a local development server on a port that is not
 * known at build time. Passing null restores the configured host.
 */
export const configureParty = (host: string | null): void => {
  hostOverride = normaliseHost(host ?? undefined)
  invalidateConnectivity()
}

/** The party host as `host[:port]`, or null when this build has no party server. */
export const partyHost = (): string | null => hostOverride ?? normaliseHost(env['VITE_PARTY_HOST'])

/**
 * True when the build knows where the party server is.
 *
 * A build without a party host is a single-player build: the menu should hide
 * multiplayer outright rather than offer a button that can only ever fail.
 */
export const isMultiplayerConfigured = (): boolean => partyHost() !== null

/** Loopback is served over plain HTTP; everything else is assumed to be TLS. */
const isLoopback = (host: string): boolean =>
  /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?$/i.test(host)

/** `https://host` or `http://host`, or null when no party host is configured. */
export const partyOrigin = (): string | null => {
  const host = partyHost()
  if (host === null) return null
  return `${isLoopback(host) ? 'http' : 'https'}://${host}`
}

/** An absolute URL for one of the server's HTTP routes, or null with no host. */
export const partyUrl = (path = ''): string | null => {
  const origin = partyOrigin()
  if (origin === null) return null
  return `${origin}${path}`
}

let snapshot: ConnectivitySnapshot = { status: 'checking', result: null, checking: false }
let inFlight: Promise<ConnectivityResult> | null = null
const listeners = new Set<() => void>()

const publish = (next: ConnectivitySnapshot): void => {
  snapshot = next
  for (const listener of listeners) listener()
}

const setChecking = (checking: boolean): void => {
  if (snapshot.checking === checking) return
  publish({ ...snapshot, checking })
}

const settle = (result: ConnectivityResult): ConnectivityResult => {
  publish({ status: result.status, result, checking: false })
  return result
}

/** The last settled verdict, or null if nothing has been measured yet. */
export const cachedConnectivity = (): ConnectivityResult | null => snapshot.result

/** The current snapshot. Stable by identity until something about it changes. */
export const connectivitySnapshot = (): ConnectivitySnapshot => snapshot

/** Drops the cached verdict so the next `ensureConnectivity` re-probes. */
export const invalidateConnectivity = (): void => {
  if (snapshot.result === null) return
  publish({ status: 'checking', result: null, checking: snapshot.checking })
}

/** Forgets everything, including subscriptions. Tests only. */
export const resetConnectivity = (): void => {
  inFlight = null
  snapshot = { status: 'checking', result: null, checking: false }
  detachWindowListeners()
  listeners.clear()
}

const defaultOnline = (): boolean =>
  typeof navigator === 'undefined' || typeof navigator.onLine !== 'boolean' || navigator.onLine

/** What `/health` says when the party server is the thing that answered. */
type Health = { protocol: number; serverTime: number | null }

/**
 * Reads the health payload without trusting it.
 *
 * Anything that is not the server's own JSON — a portal's login page, a proxy's
 * error document, a body that never finishes arriving — means the party server
 * is not on the other end of this connection. The shape being demanded is
 * `{ ok: true, protocol: <number> }`, which is specific enough that no portal
 * passes it by accident and does not require importing the wire format into a
 * module the home screen loads.
 */
const readHealth = async (response: Response): Promise<Health | null> => {
  if (!response.ok) return null
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return null
  }
  if (typeof body !== 'object' || body === null) return null
  const payload = body as { ok?: unknown; protocol?: unknown; serverTime?: unknown }
  if (payload.ok !== true || typeof payload.protocol !== 'number') return null
  return {
    protocol: payload.protocol,
    serverTime: typeof payload.serverTime === 'number' ? payload.serverTime : null,
  }
}

/**
 * Measures the party server, ignoring any cached verdict.
 *
 * Concurrent callers share one probe: the home screen mounting, a visibility
 * change and the network coming back can all land in the same instant, and
 * three probes would answer the same question three times.
 */
export const checkConnectivity = (
  options: ConnectivityOptions = {},
): Promise<ConnectivityResult> => {
  if (inFlight) return inFlight
  const probe = runCheck(options).finally(() => {
    inFlight = null
  })
  inFlight = probe
  return probe
}

const runCheck = async (options: ConnectivityOptions): Promise<ConnectivityResult> => {
  const now = options.now ?? Date.now
  const online = options.online ?? defaultOnline
  const doFetch = options.fetchImpl ?? (typeof fetch === 'function' ? fetch : null)
  const url = partyUrl(PARTY_HEALTH_PATH)

  const fail = (
    status: Exclude<ConnectivityStatus, 'checking' | 'available'>,
  ): ConnectivityResult =>
    settle({ status, checkedAt: now(), latencyMs: null, serverTime: null, protocol: null })

  // No host and no fetch are both "this build cannot do multiplayer", which is
  // indistinguishable from the server being down as far as the menu cares.
  if (url === null || doFetch === null) return fail('unavailable-server-down')
  // Asking the interface first costs nothing and is the one case where a
  // negative answer is trustworthy: the browser will not let the request out.
  if (!online()) return fail('unavailable-offline')

  setChecking(true)
  const startedAt = now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? CONNECTIVITY_TIMEOUT_MS)
  try {
    const response = await doFetch(url, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      mode: 'cors',
      signal: controller.signal,
    })
    const health = await readHealth(response)
    // A portal answers, so the interface is plainly up; what is missing is the
    // party server, and saying "you are offline" here would send the player to
    // check a connection that is working.
    if (health === null) return fail('unavailable-server-down')
    return settle({
      status: 'available',
      checkedAt: now(),
      latencyMs: Math.max(0, now() - startedAt),
      serverTime: health.serverTime,
      protocol: health.protocol,
    })
  } catch {
    // A thrown fetch is a transport failure: either the network died between
    // the two checks, or the host is unreachable.
    return fail(online() ? 'unavailable-server-down' : 'unavailable-offline')
  } finally {
    clearTimeout(timer)
  }
}

/** True when a result is old enough to be worth re-measuring. */
const isStale = (result: ConnectivityResult, at: number): boolean => {
  const ttl = result.status === 'available' ? CONNECTIVITY_TTL_MS : CONNECTIVITY_FAILURE_TTL_MS
  return at - result.checkedAt >= ttl
}

/**
 * The cached verdict, probing only if there is not a fresh one.
 *
 * This is what a screen calls. `checkConnectivity` is what a retry button calls.
 */
export const ensureConnectivity = (
  options: ConnectivityOptions = {},
): Promise<ConnectivityResult> => {
  const now = options.now ?? Date.now
  const cached = snapshot.result
  if (cached !== null && !isStale(cached, now())) return Promise.resolve(cached)
  return checkConnectivity(options)
}

let windowListenersAttached = false

const handleOnline = (): void => {
  invalidateConnectivity()
  void checkConnectivity()
}

const handleOffline = (): void => {
  settle({
    status: 'unavailable-offline',
    checkedAt: Date.now(),
    latencyMs: null,
    serverTime: null,
    protocol: null,
  })
}

const handleVisibility = (): void => {
  if (typeof document === 'undefined' || document.visibilityState !== 'visible') return
  void ensureConnectivity()
}

const attachWindowListeners = (): void => {
  if (windowListenersAttached || typeof window === 'undefined') return
  windowListenersAttached = true
  window.addEventListener('online', handleOnline)
  window.addEventListener('offline', handleOffline)
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibility)
  }
}

const detachWindowListeners = (): void => {
  if (!windowListenersAttached || typeof window === 'undefined') return
  windowListenersAttached = false
  window.removeEventListener('online', handleOnline)
  window.removeEventListener('offline', handleOffline)
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', handleVisibility)
  }
}

/**
 * Watches the verdict.
 *
 * The window listeners are attached with the first subscriber and dropped with
 * the last, so a single-player session never has a connectivity listener bound
 * to it at all.
 */
export const subscribeConnectivity = (listener: () => void): (() => void) => {
  listeners.add(listener)
  attachWindowListeners()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) detachWindowListeners()
  }
}

/**
 * The connectivity snapshot, as a hook.
 *
 * `useSyncExternalStore` rather than state plus an effect: the verdict is
 * module state that outlives any one screen, and reading it through the store
 * API means a screen that mounts after a probe has already settled renders the
 * answer on its first frame instead of flashing "checking".
 */
export const useConnectivity = (): ConnectivitySnapshot => {
  const current = useSyncExternalStore(
    subscribeConnectivity,
    connectivitySnapshot,
    connectivitySnapshot,
  )
  useEffect(() => {
    void ensureConnectivity()
  }, [])
  return current
}
