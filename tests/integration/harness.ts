/**
 * A scriptable multiplayer client, for tests that need more than one of them.
 *
 * These tests talk to a party server that is actually running: `pnpm party:dev`
 * in one terminal, `pnpm test:integration` in another. Nothing here is mocked,
 * because the things worth proving about multiplayer — who the server says won,
 * whether a reconnecting player gets their seat back, whether two hosts can be
 * handed the same room code — are all properties of the server, and a fake
 * server would only ever agree with the assumptions that built it.
 *
 * The client below is deliberately NOT `src/multiplayer/client.ts`. That module
 * exists to keep a phone connected through a tunnel: it reconnects on its own
 * schedule, heartbeats, and decides for itself when a refusal is final. All of
 * that is helpful in a game and ruinous in a test, where a socket has to do
 * exactly what the script says and nothing else. What is shared with the real
 * client is the part that must not diverge: the wire format, the room code
 * rules, and the level generator that turns a level number into the one
 * solution the server will accept.
 *
 * TIME. Every assertion about who won is an assertion about the server's clock,
 * so the scripts below order finishes by sending them in order with real gaps
 * between them, rather than by claiming a time. A client cannot claim a time
 * here any more than it can in the app.
 */

import { generateLevel } from '../../src/board/generator/index'
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type LevelSpec,
  type PlayerId,
  type RoomSettings,
  type RoomState,
  type ServerMessage,
  parseServerMessage,
} from '../../src/multiplayer/protocol'

/**
 * Where the party server is.
 *
 * Defaults to the host `.env.example` documents for local development, so a
 * plain `pnpm party:dev` needs no configuration. `PARTY_HOST` overrides it,
 * which is what a second server on another port needs.
 */
const rawHost = process.env['PARTY_HOST'] ?? '127.0.0.1:8787'

export const PARTY_HOST = rawHost
  .trim()
  .replace(/^[a-z]+:\/\//i, '')
  .replace(/\/+$/, '')

/** Loopback is served over plain HTTP, exactly as the app's own host rule has it. */
const isLoopback = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?$/i.test(PARTY_HOST)

export const HTTP_BASE = `${isLoopback ? 'http' : 'https'}://${PARTY_HOST}`
export const WS_BASE = `${isLoopback ? 'ws' : 'wss'}://${PARTY_HOST}`

/** How long any single wait is allowed to sit before the test is declared stuck. */
export const DEFAULT_WAIT_MS = 15_000

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Whether a party server is answering, and speaking this protocol.
 *
 * A wrong protocol version is treated as "not reachable" rather than as a
 * failure: it means the running server is from a different checkout, and every
 * assertion below would be about the wrong thing.
 */
export const probeParty = async (): Promise<boolean> => {
  try {
    const response = await fetch(`${HTTP_BASE}/health`, {
      signal: AbortSignal.timeout(2_500),
    })
    if (!response.ok) return false
    const body = (await response.json()) as { ok?: unknown; protocol?: unknown }
    return body.ok === true && body.protocol === PROTOCOL_VERSION
  } catch {
    return false
  }
}

/**
 * Settled once, at import, so every suite can decide whether to run.
 *
 * A missing server skips these tests rather than failing them: they are a
 * multi-process integration suite, and someone running `pnpm test` on a laptop
 * with no worker running has not broken anything. The reason is printed by
 * ./globalSetup, which runs where console output is actually shown.
 */
export const partyReachable = await probeParty()

/**
 * The one solution of a level, generated the same way the server generates it.
 *
 * Cached because a suite plays the same handful of levels repeatedly and
 * generation is the only expensive thing in the file.
 */
const solutions = new Map<number, readonly number[]>()

export const solutionFor = (levelNumber: number): number[] => {
  const cached = solutions.get(levelNumber)
  if (cached) return [...cached]
  const solution = generateLevel(levelNumber).solution
  solutions.set(levelNumber, solution)
  return [...solution]
}

/** One attempt at a room code, refusals included. */
export const tryAllocateRoom = async (): Promise<{ status: number; code: string | null }> => {
  const response = await fetch(`${HTTP_BASE}/rooms`, { method: 'POST' })
  const body = (await response.json()) as { code?: unknown }
  return { status: response.status, code: typeof body.code === 'string' ? body.code : null }
}

/**
 * Asks the lobby for a room code, exactly as the app's create-room screen does.
 *
 * Room creation is rationed per caller, and every client in this suite is the
 * same caller: one address, on one machine. A test that deliberately floods the
 * lobby would otherwise leave every later test unable to open a room at all.
 * Waiting out a refusal is also what the app does, so the retry is not a
 * concession to the tests — it is the behaviour being relied on.
 */
export const allocateRoom = async (timeoutMs = DEFAULT_WAIT_MS): Promise<string> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const attempt = await tryAllocateRoom()
    if (attempt.code !== null) return attempt.code
    if (attempt.status !== 429 || Date.now() >= deadline) {
      throw new Error(`POST /rooms answered ${attempt.status}`)
    }
    await sleep(250)
  }
}

/** Whether the registry considers a code live. */
export const roomExists = async (code: string): Promise<boolean> => {
  const response = await fetch(`${HTTP_BASE}/rooms/${code}`)
  const body = (await response.json()) as { exists?: unknown }
  return body.exists === true
}

export type CloseInfo = { code: number; reason: string }

export type WaitOptions = {
  /** Index into the received log to start scanning from. See `TestClient.mark`. */
  from?: number | undefined
  timeoutMs?: number | undefined
}

/** Narrows the received log to one message kind. */
type OfKind<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>

/** Every client this module has opened, so a test can drop them all at once. */
const live = new Set<TestClient>()

/**
 * One scripted player.
 *
 * Everything the server has sent is kept in `received`, and every wait is a
 * scan over that log rather than a listener registered at the moment of asking.
 * That distinction is the whole reason these tests are not flaky: a `result`
 * broadcast can easily arrive while the test is still awaiting the `accepted`
 * that caused it, and a listener registered afterwards would wait forever for a
 * message that has already been and gone.
 */
export class TestClient {
  readonly sessionId: string
  readonly room: string
  readonly received: ServerMessage[] = []
  playerId: PlayerId | null = null
  /**
   * The seat token this client was issued, if it has been admitted.
   *
   * The only thing that gets a client back into its own seat. Deliberately
   * separate from `playerId`, which every client in the room is shown and which
   * proves nothing — see tests/integration/identity.test.ts.
   */
  token: string | null = null
  closed: CloseInfo | null = null

  #socket: WebSocket
  #wakes = new Set<() => void>()

  constructor(room: string, sessionId: string) {
    this.room = room
    this.sessionId = sessionId
    this.#socket = new WebSocket(
      `${WS_BASE}/parties/room/${room}?_pk=${encodeURIComponent(sessionId)}&v=${PROTOCOL_VERSION}`,
    )
    // Waiters are woken by events rather than polled, so every event that can
    // change what a waiter is looking at has to wake them — including the open,
    // which is what `ready` is waiting for.
    this.#socket.addEventListener('open', () => {
      this.#wake()
    })
    this.#socket.addEventListener('message', (event: MessageEvent) => {
      const message = parseServerMessage(event.data)
      if (message === null) return
      if (message.t === 'welcome') {
        this.playerId = message.you
        this.token = message.token
      }
      this.received.push(message)
      this.#wake()
    })
    this.#socket.addEventListener('close', (event: CloseEvent) => {
      this.closed = { code: event.code, reason: event.reason }
      this.#wake()
    })
    this.#socket.addEventListener('error', () => {
      // A close always follows, and that is where the outcome is recorded.
    })
    live.add(this)
  }

  #wake(): void {
    for (const wake of [...this.#wakes]) wake()
  }

  get open(): boolean {
    return this.#socket.readyState === this.#socket.OPEN
  }

  /** Where the log currently ends. Pass it as `from` to ignore earlier messages. */
  mark(): number {
    return this.received.length
  }

  /** The most recent room snapshot this client has been sent. */
  get state(): RoomState | null {
    for (let i = this.received.length - 1; i >= 0; i--) {
      const message = this.received[i] as ServerMessage
      if (message.t === 'state') return message.state
      if (message.t === 'welcome') return message.state
    }
    return null
  }

  /** My own row in the room, by player id. */
  get me(): RoomState['players'][number] | null {
    return this.state?.players.find((player) => player.id === this.playerId) ?? null
  }

  send(message: ClientMessage): void {
    this.#socket.send(JSON.stringify(message))
  }

  /** Resolves once the socket is open, or rejects if it closed before opening. */
  async ready(timeoutMs = DEFAULT_WAIT_MS): Promise<void> {
    if (this.open) return
    await this.#until(() => this.open || this.closed !== null, timeoutMs, 'socket to open')
    if (!this.open) throw new Error(`socket closed before opening: ${this.closed?.code}`)
  }

  /**
   * The first message of a kind, waiting for it if it has not arrived yet.
   *
   * `where` narrows further — the same kind arrives many times in a match, and
   * a test almost always means a specific one.
   */
  async waitFor<T extends ServerMessage['t']>(
    type: T,
    where: (message: OfKind<T>) => boolean = () => true,
    options: WaitOptions = {},
  ): Promise<OfKind<T>> {
    const from = options.from ?? 0
    const find = (): OfKind<T> | null => {
      for (let i = from; i < this.received.length; i++) {
        const message = this.received[i] as ServerMessage
        if (message.t === type && where(message as OfKind<T>)) return message as OfKind<T>
      }
      return null
    }
    const found = find()
    if (found) return found
    await this.#until(() => find() !== null, options.timeoutMs ?? DEFAULT_WAIT_MS, `a ${type}`)
    return find() as OfKind<T>
  }

  /** A room snapshot satisfying a predicate, from either a `welcome` or a `state`. */
  async waitForState(
    where: (state: RoomState) => boolean,
    options: WaitOptions = {},
  ): Promise<RoomState> {
    const from = options.from ?? 0
    const find = (): RoomState | null => {
      for (let i = from; i < this.received.length; i++) {
        const message = this.received[i] as ServerMessage
        if (message.t !== 'state' && message.t !== 'welcome') continue
        if (where(message.state)) return message.state
      }
      return null
    }
    const found = find()
    if (found) return found
    await this.#until(() => find() !== null, options.timeoutMs ?? DEFAULT_WAIT_MS, 'a room state')
    return find() as RoomState
  }

  /**
   * Waits until the room's LATEST snapshot satisfies a predicate.
   *
   * Distinct from `waitForState`, which scans the whole log for a snapshot that
   * ever matched. Use this one whenever the condition is where the room has
   * settled — a phase, a host, who is connected — because acting on a state the
   * room has already left is how a test hangs: `ready` sent for an interlude
   * that ended reaches a room that has stopped listening for it.
   */
  async waitUntilState(
    where: (state: RoomState) => boolean,
    options: { timeoutMs?: number; describe?: string } = {},
  ): Promise<RoomState> {
    const describe = options.describe ?? 'the room to settle'
    await this.#until(
      () => this.state !== null && where(this.state),
      options.timeoutMs ?? DEFAULT_WAIT_MS,
      describe,
    )
    return this.state as RoomState
  }

  async waitForPhase(phase: RoomState['phase'], timeoutMs = DEFAULT_WAIT_MS): Promise<RoomState> {
    return this.waitUntilState((state) => state.phase === phase, {
      timeoutMs,
      describe: `phase ${phase}`,
    })
  }

  async waitForClose(timeoutMs = DEFAULT_WAIT_MS): Promise<CloseInfo> {
    await this.#until(() => this.closed !== null, timeoutMs, 'the socket to close')
    const closed = this.closed
    if (closed === null) throw new Error('the socket did not close')
    return closed
  }

  /**
   * Claims the solution to a scheduled level.
   *
   * The claimed time is deliberately settable and deliberately ignored by the
   * server; the `timing authority` suite in ./race.test.ts is the proof.
   */
  solve(levelIndex: number, schedule: readonly LevelSpec[], clientMs = 0): void {
    const spec = schedule[levelIndex]
    if (!spec) throw new Error(`no level at index ${levelIndex}`)
    this.send({
      t: 'solved',
      claim: { levelIndex, cols: solutionFor(spec.levelNumber) },
      clientMs,
    })
  }

  close(): void {
    live.delete(this)
    try {
      this.#socket.close()
    } catch {
      // Already closing; there is nothing to do about it.
    }
  }

  #until(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const wake = (): void => {
        if (!predicate()) return
        finish()
        resolve()
      }
      const timer = setTimeout(() => {
        finish()
        reject(new Error(`timed out after ${timeoutMs}ms waiting for ${what}`))
      }, timeoutMs)
      const finish = (): void => {
        clearTimeout(timer)
        this.#wakes.delete(wake)
      }
      this.#wakes.add(wake)
      wake()
    })
  }
}

export type ConnectOptions = {
  /**
   * The `_pk` on the socket URL.
   *
   * PartyServer would take a connection's id from it; the Worker in front of
   * the rooms overwrites it, so it identifies nothing. Settable because tests
   * exist to prove exactly that.
   */
  sessionId?: string
  /**
   * A seat token from a previous `welcome`, to be recognised as a returning
   * player rather than a new one. Nothing else in the protocol does that.
   */
  token?: string
  /** Sent in the join frame; the room may make it unique within the room. */
  name?: string
  /** False to return before the room has admitted the player — for refusals. */
  admit?: boolean
  timeoutMs?: number
}

let sessionCounter = 0

/**
 * Opens a socket, joins, and by default waits to be admitted.
 *
 * `admit: false` is for the cases where being refused is the point: a full
 * room, or a match already under way.
 */
export const connect = async (room: string, options: ConnectOptions = {}): Promise<TestClient> => {
  const sessionId =
    options.sessionId ?? `t${++sessionCounter}-${Math.random().toString(36).slice(2, 8)}`
  const client = new TestClient(room, sessionId)
  await client.ready(options.timeoutMs)
  client.send({
    t: 'join',
    v: PROTOCOL_VERSION,
    name: options.name ?? sessionId,
    ...(options.token === undefined ? {} : { token: options.token }),
  })
  if (options.admit !== false) {
    await client.waitFor('welcome', () => true, { timeoutMs: options.timeoutMs })
  }
  return client
}

/** A room with `count` players in it, the first of which is the host. */
export const openRoom = async (
  names: readonly string[],
): Promise<{
  code: string
  clients: TestClient[]
}> => {
  const code = await allocateRoom()
  const clients: TestClient[] = []
  // Sequential, not parallel: join order decides seat order, host succession and
  // the fallback names, and a test that asserts any of those needs it fixed.
  for (const name of names) clients.push(await connect(code, { name }))
  const host = clients[0] as TestClient
  await host.waitForState((state) => state.players.length === names.length)
  return { code, clients }
}

/** Sets the mode and starts, returning the schedule the server published. */
export const startMatch = async (
  host: TestClient,
  settings: RoomSettings,
): Promise<LevelSpec[]> => {
  const from = host.mark()
  host.send({ t: 'settings', settings })
  await host.waitForState((state) => state.settings.mode === settings.mode, { from })
  host.send({ t: 'start' })
  const match = await host.waitFor('match', () => true, { from })
  return match.schedule
}

/** Closes every client this module has opened. Call it from `afterEach`. */
export const closeAllClients = (): void => {
  for (const client of [...live]) client.close()
  live.clear()
}

/** Player names in podium order, for an assertion that reads like the screen. */
export const podiumNames = (
  podium: readonly { playerId: PlayerId }[],
  state: RoomState | null,
): string[] =>
  podium.map(
    (entry) =>
      state?.players.find((player) => player.id === entry.playerId)?.name ?? entry.playerId,
  )
