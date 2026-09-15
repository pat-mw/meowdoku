import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CLOSE_REJECTED,
  type PartyClient,
  type PartyClientEvent,
  createPartyClient,
  createRoom,
  lookupRoom,
  rejectionMessage,
} from '../../src/multiplayer/client'
import { configureParty, resetConnectivity } from '../../src/multiplayer/connection'
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type RoomCode,
  type RoomState,
  type ServerMessage,
  encodeMessage,
} from '../../src/multiplayer/protocol'

/**
 * The transport is tested against a fake socket rather than a server.
 *
 * `partysocket` accepts a `WebSocket` constructor, so injecting one exercises
 * the real reconnection machinery — backoff, retry counting, the
 * `shouldReconnectOnClose` verdict — while nothing opens a real connection and
 * every open, message and close is driven from the test.
 */

type Listener = (event: Event) => void

class FakeSocket {
  static instances: FakeSocket[] = []

  static reset(): void {
    FakeSocket.instances = []
  }

  static get latest(): FakeSocket {
    const socket = FakeSocket.instances.at(-1)
    if (!socket) throw new Error('no socket was constructed')
    return socket
  }

  readonly url: string
  readyState = 0
  binaryType = 'blob'
  /** Every frame the client has written, in order. */
  readonly sent: string[] = []
  closedWith: { code: number; reason: string } | null = null

  private readonly listeners = new Map<string, Set<Listener>>()

  constructor(url: string) {
    this.url = url
    FakeSocket.instances.push(this)
  }

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>()
    set.add(listener)
    this.listeners.set(type, set)
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.closedWith = { code, reason }
  }

  // ---- test drivers ----------------------------------------------------

  private dispatch(event: Event): void {
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) listener(event)
  }

  /** The handshake completing. */
  open(): void {
    this.readyState = 1
    this.dispatch(new Event('open'))
  }

  /** A frame arriving from the server. */
  deliver(message: ServerMessage): void {
    this.dispatch(new MessageEvent('message', { data: encodeMessage(message) }))
  }

  /** Raw text, for the malformed-frame case. */
  deliverRaw(data: string): void {
    this.dispatch(new MessageEvent('message', { data }))
  }

  /** The far end going away. */
  serverClose(code: number, reason = ''): void {
    this.readyState = 3
    const event = new Event('close') as Event & { code: number; reason: string }
    Object.assign(event, { code, reason })
    this.dispatch(event)
  }

  /** Every frame this socket was sent, decoded. */
  get frames(): ClientMessage[] {
    return this.sent.map((raw) => JSON.parse(raw) as ClientMessage)
  }

  framesOfType<T extends ClientMessage['t']>(type: T): Extract<ClientMessage, { t: T }>[] {
    return this.frames.filter(
      (frame): frame is Extract<ClientMessage, { t: T }> => frame.t === type,
    )
  }
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/** Lets partysocket's promise chain and its zero-delay backoff timer run. */
const flush = async (rounds = 6): Promise<void> => {
  for (let i = 0; i < rounds; i++) await wait(1)
}

const ROOM = 'H3K9M' as RoomCode

const roomState = (overrides: Partial<RoomState> = {}): RoomState => ({
  code: ROOM,
  phase: 'lobby',
  hostId: 'p1',
  settings: { mode: 'steady', levelCount: 5, difficulty: 'standard' },
  players: [],
  levelCount: 5,
  schedule: null,
  levelIndex: -1,
  phaseStartedAt: 0,
  phaseEndsAt: null,
  results: [],
  podium: null,
  serverTime: 1_000_000,
  ...overrides,
})

/**
 * The seat token a room issues in its welcome.
 *
 * Deliberately unlike the player id in the same frame: the id is public and
 * grants nothing, the token is the secret that resumes the seat, and a client
 * that confused the two would hand the wrong one back on a reconnect.
 */
const SEAT_TOKEN = 'seat-6f1c2b'

const welcome = (token: string = SEAT_TOKEN): ServerMessage => ({
  t: 'welcome',
  v: PROTOCOL_VERSION,
  you: 'p1',
  token,
  state: roomState(),
})

/** A client wired to the fake socket, with the heartbeat and backoff out of the way. */
const connect = async (
  options: Partial<Parameters<typeof createPartyClient>[0]> = {},
): Promise<{ client: PartyClient; events: PartyClientEvent[] }> => {
  const client = createPartyClient({
    room: ROOM,
    name: 'Pat',
    sessionId: 'session-1',
    socket: FakeSocket as unknown as new (url: string) => unknown,
    heartbeatMs: 0,
    retry: { minDelayMs: 0, maxDelayMs: 0 },
    ...options,
  })
  const events: PartyClientEvent[] = []
  client.subscribe((event) => events.push(event))
  await flush()
  return { client, events }
}

let open: PartyClient[] = []

const track = (client: PartyClient): PartyClient => {
  open.push(client)
  return client
}

beforeEach(() => {
  FakeSocket.reset()
  resetConnectivity()
  configureParty('party.example.test')
  open = []
})

afterEach(() => {
  for (const client of open) client.close()
  open = []
  configureParty(null)
  resetConnectivity()
  vi.restoreAllMocks()
})

describe('createPartyClient', () => {
  it('refuses to open a socket when the build has no party host', async () => {
    configureParty(null)
    const { client } = await connect()
    track(client)
    expect(client.status()).toBe('rejected')
    expect(client.rejection()?.code).toBe('no-party-host')
    expect(FakeSocket.instances).toHaveLength(0)
  })

  it('opens the room socket on the main party with a stable session id', async () => {
    const { client } = await connect()
    track(client)
    const url = new URL(FakeSocket.latest.url)
    expect(url.protocol).toBe('wss:')
    expect(url.host).toBe('party.example.test')
    expect(url.pathname).toBe(`/parties/room/${ROOM}`)
    expect(url.searchParams.get('_pk')).toBe('session-1')
    expect(url.searchParams.get('v')).toBe(String(PROTOCOL_VERSION))
  })

  it('stays connecting until the room says welcome', async () => {
    const { client, events } = await connect()
    track(client)
    expect(client.status()).toBe('connecting')

    FakeSocket.latest.open()
    // Open is not admitted: a socket the room has not answered yet is nothing
    // the player can act on.
    expect(client.status()).toBe('connecting')

    FakeSocket.latest.deliver(welcome())
    expect(client.status()).toBe('connected')
    expect(events.filter((event) => event.kind === 'status').at(-1)).toEqual({
      kind: 'status',
      status: 'connected',
      rejection: null,
    })
  })

  it('sends a join carrying the protocol version and the name', async () => {
    const { client } = await connect({ name: '  Whisker  Face  ' })
    track(client)
    FakeSocket.latest.open()
    expect(FakeSocket.latest.framesOfType('join')).toEqual([
      { t: 'join', v: PROTOCOL_VERSION, name: '  Whisker  Face  ' },
    ])
  })

  it('round-trips messages in both directions', async () => {
    const { client, events } = await connect()
    track(client)
    FakeSocket.latest.open()
    FakeSocket.latest.deliver(welcome())

    expect(client.send({ t: 'progress', cats: 3 })).toBe(true)
    expect(FakeSocket.latest.framesOfType('progress')).toEqual([{ t: 'progress', cats: 3 }])

    FakeSocket.latest.deliver({ t: 'accepted', levelIndex: 0, elapsedMs: 4200 })
    const received = events
      .filter((event) => event.kind === 'message')
      .map((event) => event.message)
    expect(received.at(-1)).toEqual({ t: 'accepted', levelIndex: 0, elapsedMs: 4200 })
  })

  it('drops a send made while the socket is not open rather than queueing it', async () => {
    const { client, events } = await connect()
    track(client)
    // A progress tick buffered across a disconnect would describe a board state
    // that has since moved on, so nothing is enqueued at all.
    expect(client.send({ t: 'progress', cats: 2 })).toBe(false)
    expect(FakeSocket.latest.sent).toHaveLength(0)
    expect(events.filter((event) => event.kind === 'message')).toHaveLength(0)
  })

  it('ignores a frame it cannot parse', async () => {
    const { client, events } = await connect()
    track(client)
    FakeSocket.latest.open()
    FakeSocket.latest.deliverRaw('not json at all')
    FakeSocket.latest.deliverRaw(JSON.stringify({ t: 'nonsense' }))
    expect(events.filter((event) => event.kind === 'message')).toHaveLength(0)
  })

  it('reconnects after an unexpected close and re-asserts the join', async () => {
    const { client, events } = await connect()
    track(client)
    FakeSocket.latest.open()
    FakeSocket.latest.deliver(welcome())

    const first = FakeSocket.latest
    first.serverClose(1006, 'dropped')
    expect(client.status()).toBe('reconnecting')

    await flush()
    expect(FakeSocket.instances.length).toBeGreaterThan(1)
    const second = FakeSocket.latest
    expect(second).not.toBe(first)

    second.open()
    // Resuming, not restarting. The seat token from the first welcome is what
    // does it: the room has no other way to tell this socket from a stranger's,
    // and the player id it broadcast to everybody must not be usable here.
    expect(second.framesOfType('join')).toEqual([
      { t: 'join', v: PROTOCOL_VERSION, name: 'Pat', token: SEAT_TOKEN },
    ])

    second.deliver(welcome())
    expect(client.status()).toBe('connected')
    const statuses = events.filter((event) => event.kind === 'status').map((event) => event.status)
    expect(statuses).toContain('reconnecting')
  })

  it('comes back from a clean close, which is what a redeploy looks like', async () => {
    const { client } = await connect()
    track(client)
    FakeSocket.latest.open()
    FakeSocket.latest.deliver(welcome())

    FakeSocket.latest.serverClose(1000, 'going away')
    await flush()
    // Only the 4000 range is a refusal. A worker cycling should cost the player
    // a moment, not their match.
    expect(FakeSocket.instances.length).toBeGreaterThan(1)
    expect(client.status()).toBe('reconnecting')
  })

  it('reports disconnected once the retries are exhausted', async () => {
    const { client } = await connect({ retry: { maxAttempts: 2, minDelayMs: 0, maxDelayMs: 0 } })
    track(client)
    FakeSocket.latest.open()
    FakeSocket.latest.deliver(welcome())

    for (let attempt = 0; attempt < 4; attempt++) {
      FakeSocket.latest.serverClose(1006)
      await flush()
    }
    expect(client.status()).toBe('disconnected')
  })

  it('treats a fatal error frame as a rejection and stops retrying', async () => {
    const { client } = await connect()
    track(client)
    FakeSocket.latest.open()
    const socket = FakeSocket.latest
    socket.deliver({ t: 'error', code: 'room-full', message: 'That room is full.' })

    expect(client.status()).toBe('rejected')
    expect(client.rejection()).toEqual({ code: 'room-full', message: 'That room is full.' })
    expect(socket.closedWith?.code).toBe(1000)

    const before = FakeSocket.instances.length
    await flush()
    expect(FakeSocket.instances).toHaveLength(before)
  })

  it('leaves a non-fatal error frame to the caller', async () => {
    const { client, events } = await connect()
    track(client)
    FakeSocket.latest.open()
    FakeSocket.latest.deliver({ t: 'error', code: 'invalid-solution', message: 'Nope.' })
    expect(client.status()).toBe('connecting')
    expect(events.filter((event) => event.kind === 'message').at(-1)?.message).toEqual({
      t: 'error',
      code: 'invalid-solution',
      message: 'Nope.',
    })
  })

  it.each(['room-full', 'match-in-progress', 'version-mismatch', 'rate-limited'] as const)(
    'reads %s out of a refusing close, for a client that never saw the error frame',
    async (expected) => {
      const { client } = await connect()
      track(client)
      FakeSocket.latest.open()
      FakeSocket.latest.serverClose(CLOSE_REJECTED, expected)
      await flush(2)

      expect(client.status()).toBe('rejected')
      expect(client.rejection()).toEqual({ code: expected, message: rejectionMessage(expected) })
      // A refusal is final: nothing may retry into a room that said no.
      expect(FakeSocket.instances).toHaveLength(1)
    },
  )

  it('treats a refusing close with an unknown reason as a server problem', async () => {
    const { client } = await connect()
    track(client)
    FakeSocket.latest.open()
    FakeSocket.latest.serverClose(CLOSE_REJECTED, 'join timeout')
    await flush(2)
    expect(client.status()).toBe('rejected')
    expect(client.rejection()).toEqual({ code: 'server-error', message: 'join timeout' })
  })

  it('does not call the room refusing a deliberate exit a rejection', async () => {
    const { client } = await connect()
    track(client)
    FakeSocket.latest.open()
    FakeSocket.latest.deliver(welcome())
    FakeSocket.latest.serverClose(CLOSE_REJECTED, 'left')
    await flush(2)
    expect(client.status()).toBe('disconnected')
    expect(client.rejection()).toBeNull()
    expect(FakeSocket.instances).toHaveLength(1)
  })

  it('closes deliberately, announcing the exit first', async () => {
    const { client } = await connect()
    track(client)
    FakeSocket.latest.open()
    FakeSocket.latest.deliver(welcome())

    const socket = FakeSocket.latest
    client.close({ leave: true })
    expect(socket.framesOfType('leave')).toEqual([{ t: 'leave' }])
    expect(client.status()).toBe('disconnected')

    await flush()
    expect(FakeSocket.instances).toHaveLength(1)
  })

  it('estimates the server clock from a pong', async () => {
    let clock = 10_000
    const { client, events } = await connect({ now: () => clock })
    track(client)
    FakeSocket.latest.open()

    clock = 10_100
    FakeSocket.latest.deliver({ t: 'pong', at: 10_000, serverTime: 50_000 })

    // 100 ms round trip, so the server's timestamp was taken about 50 ms ago:
    // 50_000 + 50 - 10_100.
    expect(client.clock()).toEqual({ offsetMs: 39_950, rttMs: 100 })
    expect(events.filter((event) => event.kind === 'clock')).toHaveLength(1)
  })

  it('pings a quiet connection and reconnects one that has gone silent', async () => {
    let clock = 0
    const { client } = await connect({ heartbeatMs: 10, now: () => clock })
    track(client)
    FakeSocket.latest.open()
    FakeSocket.latest.deliver(welcome())

    await wait(40)
    expect(FakeSocket.latest.framesOfType('ping').length).toBeGreaterThan(0)

    // A socket that is open but delivering nothing is indistinguishable from a
    // dead one, and only a reconnect gets the player back into the race.
    const before = FakeSocket.instances.length
    clock = 10_000
    await wait(40)
    expect(FakeSocket.instances.length).toBeGreaterThan(before)
  })

  it('stops the heartbeat once the client is closed', async () => {
    let clock = 0
    const { client } = await connect({ heartbeatMs: 5, now: () => clock })
    track(client)
    FakeSocket.latest.open()
    client.close()

    const before = FakeSocket.instances.length
    clock = 10_000
    await wait(40)
    expect(FakeSocket.instances).toHaveLength(before)
  })

  it('delivers nothing to a listener that has unsubscribed', async () => {
    const { client } = await connect()
    track(client)
    const seen: PartyClientEvent[] = []
    const stop = client.subscribe((event) => seen.push(event))
    stop()
    FakeSocket.latest.open()
    FakeSocket.latest.deliver(welcome())
    expect(seen).toHaveLength(0)
  })
})

describe('registry endpoints', () => {
  const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })

  it('mints a room code through the lobby party', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 'H3K9M' }))
    const result = await createRoom({ fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(result).toEqual({ ok: true, code: 'H3K9M' })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://party.example.test/rooms')
    expect(init.method).toBe('POST')
  })

  it('reports a registry that cannot mint a code as a server problem', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'no codes' }, 503))
    const result = await createRoom({ fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(result).toEqual({
      ok: false,
      reason: 'server-error',
      message: rejectionMessage('server-error'),
    })
  })

  it('answers room-not-found for a code nobody is using', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ exists: false }))
    const result = await lookupRoom('QQQQQ' as RoomCode, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result).toEqual({
      ok: false,
      reason: 'room-not-found',
      message: rejectionMessage('room-not-found'),
    })
  })

  it('accepts a code the registry says is live', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ exists: true, code: ROOM }))
    const result = await lookupRoom(ROOM, { fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(result).toEqual({ ok: true, code: ROOM })
    const [url] = fetchImpl.mock.calls[0] as unknown as [string]
    expect(url).toBe(`https://party.example.test/rooms/${ROOM}`)
  })

  it('accepts the 201 the registry answers a fresh allocation with', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 'H3K9M' }, 201))
    const result = await createRoom({ fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(result).toEqual({ ok: true, code: 'H3K9M' })
  })

  it('treats an unreachable registry as a server problem rather than a missing room', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down')
    })
    const result = await lookupRoom(ROOM, { fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(result.ok === false && result.reason).toBe('server-error')
  })
})
