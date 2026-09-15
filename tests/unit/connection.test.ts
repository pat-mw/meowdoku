import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CONNECTIVITY_FAILURE_TTL_MS,
  CONNECTIVITY_TTL_MS,
  type ConnectivityResult,
  cachedConnectivity,
  checkConnectivity,
  configureParty,
  connectivitySnapshot,
  ensureConnectivity,
  invalidateConnectivity,
  isMultiplayerConfigured,
  partyHost,
  partyOrigin,
  partyUrl,
  resetConnectivity,
  subscribeConnectivity,
} from '../../src/multiplayer/connection'

/**
 * The gate's whole job is to be harder to fool than `navigator.onLine`, so the
 * cases that matter are the ones where the interface says everything is fine:
 * a captive portal answering 200 with its own page, a proxy returning an error
 * document, a host that accepts the connection and then says nothing.
 */

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const healthy = (serverTime = 1_700_000_000_000): Response =>
  json({ ok: true, protocol: 1, serverTime })

/** A captive portal: a perfectly successful request for something else entirely. */
const portal = (): Response =>
  new Response('<html><body>Sign in to Cafe Wi-Fi</body></html>', {
    status: 200,
    headers: { 'content-type': 'text/html' },
  })

const stubFetch = (...responses: Array<() => Response | Promise<Response>>) => {
  let call = 0
  return vi.fn(async () => {
    const make = responses[Math.min(call, responses.length - 1)]
    call += 1
    if (!make) throw new Error('no response configured')
    return make()
  }) as unknown as typeof fetch
}

const online = () => true
const offline = () => false

beforeEach(() => {
  resetConnectivity()
  configureParty('party.example.test')
})

afterEach(() => {
  resetConnectivity()
  configureParty(null)
  vi.restoreAllMocks()
})

describe('party host configuration', () => {
  it('normalises a host written as a URL', () => {
    configureParty('wss://rooms.meowdoku.dev/')
    expect(partyHost()).toBe('rooms.meowdoku.dev')
    expect(partyOrigin()).toBe('https://rooms.meowdoku.dev')
    expect(partyUrl('/health')).toBe('https://rooms.meowdoku.dev/health')
  })

  it('serves a local development host over plain http', () => {
    configureParty('127.0.0.1:1999')
    expect(partyOrigin()).toBe('http://127.0.0.1:1999')
    configureParty('localhost:1999')
    expect(partyOrigin()).toBe('http://localhost:1999')
  })

  it('reports a build with no party server as unconfigured', () => {
    configureParty(null)
    expect(partyHost()).toBeNull()
    expect(partyOrigin()).toBeNull()
    expect(partyUrl('/health')).toBeNull()
    expect(isMultiplayerConfigured()).toBe(false)
  })

  it('treats whitespace and an empty string as no host at all', () => {
    configureParty('   ')
    expect(partyHost()).toBeNull()
  })
})

describe('checkConnectivity', () => {
  it('reports available when the party server answers with its own payload', async () => {
    let clock = 1_000
    const fetchImpl = stubFetch(() => healthy(9_999))
    const result = await checkConnectivity({
      fetchImpl,
      online,
      now: () => (clock += 20),
    })
    expect(result.status).toBe('available')
    expect(result.serverTime).toBe(9_999)
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    expect(cachedConnectivity()).toEqual(result)
  })

  it('does not put a request on the wire when the interface is down', async () => {
    const fetchImpl = stubFetch(() => healthy())
    const result = await checkConnectivity({ fetchImpl, online: offline })
    expect(result.status).toBe('unavailable-offline')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('calls a captive portal what it is rather than believing its 200', async () => {
    const result = await checkConnectivity({ fetchImpl: stubFetch(portal), online })
    // Emphatically not `unavailable-offline`: the interface is up, and telling
    // the player to check their connection would send them somewhere useless.
    expect(result.status).toBe('unavailable-server-down')
  })

  it('rejects JSON that does not carry a protocol version', async () => {
    const result = await checkConnectivity({
      fetchImpl: stubFetch(() => json({ ok: true, status: 'fine' })),
      online,
    })
    expect(result.status).toBe('unavailable-server-down')
  })

  it('rejects a payload that never claims to be ok', async () => {
    const result = await checkConnectivity({
      fetchImpl: stubFetch(() => json({ protocol: 1, serverTime: 1 })),
      online,
    })
    expect(result.status).toBe('unavailable-server-down')
  })

  it('rejects an error status even with a well-formed body', async () => {
    const result = await checkConnectivity({
      fetchImpl: stubFetch(() => json({ ok: true, protocol: 1, serverTime: 1 }, 503)),
      online,
    })
    expect(result.status).toBe('unavailable-server-down')
  })

  it('reports the protocol version the server speaks without enforcing it', async () => {
    const result = await checkConnectivity({
      fetchImpl: stubFetch(() => json({ ok: true, protocol: 99, serverTime: 5 })),
      online,
    })
    // An app too old for the server is a reload, not an outage; the room says
    // so properly on join, and hiding multiplayer here would say the wrong thing.
    expect(result.status).toBe('available')
    expect(result.protocol).toBe(99)
  })

  it('gives up on a host that accepts the request and then says nothing', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    ) as unknown as typeof fetch
    const result = await checkConnectivity({ fetchImpl, online, timeoutMs: 10 })
    expect(result.status).toBe('unavailable-server-down')
  })

  it('blames the network when the interface drops mid-request', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    const result = await checkConnectivity({ fetchImpl, online: offline })
    expect(result.status).toBe('unavailable-offline')
  })

  it('blames the server when the request fails but the interface is up', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    const result = await checkConnectivity({ fetchImpl, online })
    expect(result.status).toBe('unavailable-server-down')
  })

  it('reports a build with no party host as unavailable without probing', async () => {
    configureParty(null)
    const fetchImpl = stubFetch(() => healthy())
    const result = await checkConnectivity({ fetchImpl, online })
    expect(result.status).toBe('unavailable-server-down')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('probes the health route on the party origin', async () => {
    const fetchImpl = stubFetch(() => healthy())
    await checkConnectivity({ fetchImpl, online })
    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0] as [string, RequestInit]
    expect(url).toBe('https://party.example.test/health')
    expect(init.cache).toBe('no-store')
    expect(init.credentials).toBe('omit')
  })

  it('shares one probe between concurrent callers', async () => {
    const fetchImpl = stubFetch(() => healthy())
    const [a, b, c] = await Promise.all([
      checkConnectivity({ fetchImpl, online }),
      checkConnectivity({ fetchImpl, online }),
      checkConnectivity({ fetchImpl, online }),
    ])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
    expect(b).toBe(c)
  })
})

describe('ensureConnectivity', () => {
  it('trusts a fresh answer instead of re-probing', async () => {
    let clock = 1_000
    const fetchImpl = stubFetch(() => healthy())
    await ensureConnectivity({ fetchImpl, online, now: () => clock })
    clock += CONNECTIVITY_TTL_MS - 1
    await ensureConnectivity({ fetchImpl, online, now: () => clock })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('re-probes once the answer is stale', async () => {
    let clock = 1_000
    const fetchImpl = stubFetch(() => healthy())
    await ensureConnectivity({ fetchImpl, online, now: () => clock })
    clock += CONNECTIVITY_TTL_MS
    await ensureConnectivity({ fetchImpl, online, now: () => clock })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('retries a failure sooner than it would refresh a success', async () => {
    let clock = 1_000
    const fetchImpl = stubFetch(portal, healthy)
    const first = await ensureConnectivity({ fetchImpl, online, now: () => clock })
    expect(first.status).toBe('unavailable-server-down')

    clock += CONNECTIVITY_FAILURE_TTL_MS - 1
    await ensureConnectivity({ fetchImpl, online, now: () => clock })
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    clock += 1
    const recovered = await ensureConnectivity({ fetchImpl, online, now: () => clock })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(recovered.status).toBe('available')
  })

  it('re-probes after the cache is invalidated', async () => {
    const fetchImpl = stubFetch(() => healthy())
    await ensureConnectivity({ fetchImpl, online })
    invalidateConnectivity()
    expect(connectivitySnapshot().status).toBe('checking')
    await ensureConnectivity({ fetchImpl, online })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('forgets its answer when the party host changes', async () => {
    const fetchImpl = stubFetch(() => healthy())
    await ensureConnectivity({ fetchImpl, online })
    expect(cachedConnectivity()?.status).toBe('available')
    configureParty('other.example.test')
    expect(cachedConnectivity()).toBeNull()
  })
})

describe('the snapshot the menu renders', () => {
  it('starts as checking with nothing measured', () => {
    expect(connectivitySnapshot()).toEqual({ status: 'checking', result: null, checking: false })
  })

  it('keeps its identity while nothing changes', async () => {
    await checkConnectivity({ fetchImpl: stubFetch(() => healthy()), online })
    expect(connectivitySnapshot()).toBe(connectivitySnapshot())
  })

  it('tells subscribers when a probe starts and when it settles', async () => {
    const seen: Array<{ status: string; checking: boolean }> = []
    const stop = subscribeConnectivity(() => {
      const snapshot = connectivitySnapshot()
      seen.push({ status: snapshot.status, checking: snapshot.checking })
    })
    await checkConnectivity({ fetchImpl: stubFetch(() => healthy()), online })
    stop()
    expect(seen).toEqual([
      { status: 'checking', checking: true },
      { status: 'available', checking: false },
    ])
  })

  it('stops telling a subscriber that has unsubscribed', async () => {
    const seen: ConnectivityResult[] = []
    const stop = subscribeConnectivity(() => {
      const result = cachedConnectivity()
      if (result) seen.push(result)
    })
    stop()
    await checkConnectivity({ fetchImpl: stubFetch(() => healthy()), online })
    expect(seen).toHaveLength(0)
  })
})
