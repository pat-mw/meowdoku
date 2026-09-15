/**
 * The client's end of the wire.
 *
 * Everything above this module — the store, and the screens above that —
 * exchanges typed `ClientMessage`s and `ServerMessage`s and never touches a
 * socket. What lives here is the part that is about transport rather than about
 * the game: when a connection counts as established, which failures are worth
 * retrying, which ones mean "this room will never let you in", and how to come
 * back from a dropped connection without losing the level in progress.
 *
 * Reconnection is `partysocket`'s, configured rather than reimplemented. Two
 * things are added on top of it.
 *
 * The first is being able to come back. The room issues a seat token in its
 * `welcome` and this module keeps it for the tab, presenting it on every
 * subsequent join, so the server sees a player returning rather than a stranger
 * arriving and the player's seat, score and position in the match are still
 * there when they get back. The token is the only thing that does that: the
 * player id in the same frame is public, is broadcast to the whole room, and
 * proves nothing. Keeping the token per tab rather than per browser is
 * deliberate — two tabs are two players — and it is kept in `sessionStorage` so
 * it survives a reload of a live match. The board itself is local and untouched
 * by any of this: a connection that drops mid-level costs the player nothing
 * but the progress bar going quiet.
 *
 * The second is knowing the difference between a connection that is down and
 * one that is merely silent. A WebSocket through a sleeping phone, a dying
 * cellular link or a proxy that has quietly stopped forwarding stays `OPEN`
 * indefinitely and delivers nothing. A heartbeat turns that into a reconnect
 * instead of a player staring at a frozen race.
 *
 * This module imports `partysocket`, so it must only ever be reached from a
 * lazily-loaded multiplayer route. `./connection`, which the menu loads
 * eagerly, deliberately does not import it.
 */

import { PartySocket } from 'partysocket'
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type RoomCode,
  type RoomErrorCode,
  type SeatToken,
  type ServerMessage,
  encodeMessage,
  parseServerMessage,
} from './protocol'
import { PARTY_ROOMS_PATH, PARTY_ROOM_PARTY, partyHost, partyUrl } from './connection'

/**
 * Where a connection is, as far as the UI is concerned.
 *
 * `connecting` covers both opening the socket and the round trip until the
 * server's `welcome` lands, because a socket that is open but has not been
 * admitted to a room is not something a player can act on. `reconnecting` is
 * the same state after a match has already started, kept separate only because
 * it reads very differently on screen.
 */
export type PartyClientStatus =
  'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'rejected'

/**
 * Why a room refused a player.
 *
 * The protocol's own error codes plus two the protocol cannot express: a code
 * nobody is using, and a build with no party server configured at all. Both are
 * decided before or outside a room, so neither has a `RoomErrorCode`.
 */
export type RejectionCode = RoomErrorCode | 'room-not-found' | 'no-party-host'

export type Rejection = { code: RejectionCode; message: string }

/**
 * The close code a room uses to hang up on a connection for good.
 *
 * One code, with the reason string carrying the detail. A refusal has to stay
 * readable after the socket is gone, and the close is the only thing that
 * survives it: the matching `{ t: 'error' }` frame is sent first, but a client
 * that was mid-reconnect may never see it. This is also what stops
 * `partysocket` cheerfully retrying a room that is full forever.
 */
export const CLOSE_REJECTED = 4001

/** The reason a room sends when it closes a connection the player asked to end. */
const CLOSE_REASON_LEFT = 'left'

const REJECTION_CODES: readonly RejectionCode[] = [
  'version-mismatch',
  'room-full',
  'match-in-progress',
  'superseded',
  'not-host',
  'not-enough-players',
  'bad-name',
  'bad-message',
  'invalid-solution',
  'not-in-match',
  'rate-limited',
  'server-error',
  'room-not-found',
  'no-party-host',
]

const isRejectionCode = (value: string): value is RejectionCode =>
  (REJECTION_CODES as readonly string[]).includes(value)

/**
 * Protocol errors that end the connection rather than annoy the player.
 *
 * Everything else — a rejected solution, a message the server did not like — is
 * a thing that happened during a session that is still perfectly alive.
 */
const FATAL_ERROR_CODES: readonly RoomErrorCode[] = [
  'version-mismatch',
  'room-full',
  'match-in-progress',
]

const isFatalErrorCode = (code: RoomErrorCode): boolean => FATAL_ERROR_CODES.includes(code)

/**
 * True when a close means "do not come back".
 *
 * Only the application range, which is the server's explicit refusal. A clean
 * 1000 is deliberately *not* fatal: a worker being redeployed closes cleanly
 * and the player should come straight back, and `close()` already stops
 * reconnection on its own for an exit this client chose.
 */
const isFatalClose = (code: number): boolean => code >= 4000 && code <= 4999

/**
 * What a refusing close meant, or null when it was the player's own exit.
 *
 * The room puts a `RoomErrorCode` in the reason where it has one. A reason it
 * does not recognise still ends the connection — the server would not have used
 * this code otherwise — but is reported as a server problem rather than
 * guessed at.
 */
export const rejectionFromClose = (code: number, reason: string): Rejection | null => {
  if (!isFatalClose(code)) return null
  if (reason === CLOSE_REASON_LEFT) return null
  if (isRejectionCode(reason)) return { code: reason, message: rejectionMessage(reason) }
  return { code: 'server-error', message: reason || rejectionMessage('server-error') }
}

/** How often a quiet connection is poked, and how long silence is tolerated. */
export const HEARTBEAT_INTERVAL_MS = 15_000

/**
 * Backoff bounds.
 *
 * Deliberately tighter than `partysocket`'s defaults: the default three-second
 * floor is an eternity in the middle of a timed level, where every second
 * offline is a second of a race not being run. The ceiling stays modest for the
 * same reason — a player waiting out an interlude should be back before the
 * next level starts.
 */
export const MIN_RECONNECT_DELAY_MS = 400
export const MAX_RECONNECT_DELAY_MS = 6_000

/**
 * How many connection attempts before giving up and saying so.
 *
 * Retrying forever is the wrong default for a game: a player whose match is
 * unreachable needs to be told, so they can go and play a single-player level
 * instead of watching a spinner.
 */
export const MAX_RECONNECT_ATTEMPTS = 10

/** The server's clock relative to ours, and the round trip it was measured over. */
export type ClockEstimate = {
  /** Add to a local timestamp to get the server's. Zero until the first pong. */
  offsetMs: number
  /** Round trip in milliseconds, or null before the first pong. */
  rttMs: number | null
}

export type PartyClientEvent =
  | { kind: 'status'; status: PartyClientStatus; rejection: Rejection | null }
  | { kind: 'message'; message: ServerMessage }
  | { kind: 'clock'; clock: ClockEstimate }

export type PartyClientListener = (event: PartyClientEvent) => void

/** Anything `partysocket` can construct in place of a real `WebSocket`. */
export type SocketConstructor = new (url: string, protocols?: string | string[]) => unknown

export type PartyClientConfig = {
  room: RoomCode
  name: string
  /**
   * The id `partysocket` puts on the socket URL.
   *
   * Transport bookkeeping and nothing else: the party server mints its own
   * connection id at the door and discards whatever arrives here, precisely so
   * that naming a connection is not a way to become its owner. Kept because it
   * is stable for the tab, which makes a reconnect easy to follow in a log.
   * Defaults to a per-tab id in `sessionStorage`.
   */
  sessionId?: string
  /**
   * The seat to resume, overriding whatever this tab has stored for the room.
   * Tests use it; the app has no reason to.
   */
  seatToken?: SeatToken
  /** Overrides the configured party host. */
  host?: string
  /** Injected in tests so nothing opens a real socket. */
  socket?: SocketConstructor
  /** Zero disables the heartbeat. */
  heartbeatMs?: number
  /** Overrides the backoff. Tests use it to keep a reconnection loop quick. */
  retry?: { maxAttempts?: number; minDelayMs?: number; maxDelayMs?: number }
  now?: () => number
}

export type PartyClient = {
  readonly room: RoomCode
  status: () => PartyClientStatus
  rejection: () => Rejection | null
  clock: () => ClockEstimate
  /** True when the frame went out on an open socket; false when it was dropped. */
  send: (message: ClientMessage) => boolean
  subscribe: (listener: PartyClientListener) => () => void
  /** Retries now, resetting the backoff. For a "try again" button. */
  reconnect: () => void
  /** Ends the session. `leave: true` tells the room the exit was deliberate. */
  close: (options?: { leave?: boolean }) => void
}

const SESSION_KEY = 'meowdoku:mp:session'

/** One stored token per room: a tab may have been in more than one. */
const SEAT_TOKEN_PREFIX = 'meowdoku:mp:seat:'

const randomId = (): string => {
  const cryptoApi = typeof globalThis.crypto === 'object' ? globalThis.crypto : null
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID()
  return `s${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
}

/**
 * A per-tab session id.
 *
 * `sessionStorage`, not `localStorage` and emphatically not the single-player
 * save: it must die with the tab (two tabs are two players) and it must never
 * share a key with anything a single-player session reads or writes. Storage
 * being unavailable is not an error — the id simply stops surviving a reload.
 */
export const sessionPlayerId = (): string => {
  try {
    const existing = sessionStorage.getItem(SESSION_KEY)
    if (existing !== null && existing.length > 0) return existing
    const minted = randomId()
    sessionStorage.setItem(SESSION_KEY, minted)
    return minted
  } catch {
    return randomId()
  }
}

/** Forgets the per-tab session id, so the next connection is a new player. */
export const clearSessionPlayerId = (): void => {
  try {
    sessionStorage.removeItem(SESSION_KEY)
  } catch {
    // Nothing to forget if storage was never available.
  }
}

/**
 * The seat token this tab holds for a room, if any.
 *
 * `sessionStorage` for the same reasons as the session id above, plus one more:
 * this is a credential. It must die with the tab, it must never be readable by
 * another tab pretending to be this one, and it must never share a key with
 * anything a single-player session touches. Storage being unavailable is not an
 * error — the token then lives only in memory, and a reload becomes a new
 * player instead of a returning one.
 */
export const seatTokenFor = (room: RoomCode): SeatToken | null => {
  try {
    const stored = sessionStorage.getItem(SEAT_TOKEN_PREFIX + room)
    return stored !== null && stored.length > 0 ? stored : null
  } catch {
    return null
  }
}

const rememberSeatToken = (room: RoomCode, token: SeatToken): void => {
  try {
    sessionStorage.setItem(SEAT_TOKEN_PREFIX + room, token)
  } catch {
    // The token still works for this client instance; only a reload loses it.
  }
}

/** Gives up a seat, so the next connection to this room is a new player. */
export const clearSeatToken = (room: RoomCode): void => {
  try {
    sessionStorage.removeItem(SEAT_TOKEN_PREFIX + room)
  } catch {
    // Nothing to forget if storage was never available.
  }
}

const rejectionMessages: Readonly<Record<RejectionCode, string>> = {
  'version-mismatch': 'This app is out of date. Reload to play multiplayer.',
  'room-full': 'That room is full.',
  'match-in-progress': 'That match has already started.',
  superseded: 'This room is open somewhere else.',
  'room-not-found': 'No room with that code.',
  'no-party-host': 'Multiplayer is not available in this build.',
  'not-host': 'Only the host can do that.',
  'not-enough-players': 'Not enough players yet.',
  'bad-name': 'That name cannot be used.',
  'bad-message': 'The server did not understand that.',
  'invalid-solution': 'That solution was not accepted.',
  'not-in-match': 'You are not in this match.',
  'rate-limited': 'Slow down a moment.',
  'server-error': 'The party server had a problem.',
}

/** A human-readable line for a refusal, so every caller words them the same way. */
export const rejectionMessage = (code: RejectionCode): string => rejectionMessages[code]

export const createPartyClient = (config: PartyClientConfig): PartyClient => {
  const now = config.now ?? Date.now
  const heartbeatMs = config.heartbeatMs ?? HEARTBEAT_INTERVAL_MS
  const listeners = new Set<PartyClientListener>()

  let status: PartyClientStatus = 'idle'
  let rejection: Rejection | null = null
  let clock: ClockEstimate = { offsetMs: 0, rttMs: null }
  let admitted = false
  let closedByUs = false
  let seat: SeatToken | null = config.seatToken ?? seatTokenFor(config.room)
  let lastSeenAt = now()
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let socket: PartySocket | null = null

  const emit = (event: PartyClientEvent): void => {
    for (const listener of listeners) listener(event)
  }

  const setStatus = (next: PartyClientStatus, reason: Rejection | null = null): void => {
    if (status === next && rejection === reason) return
    status = next
    rejection = reason
    emit({ kind: 'status', status, rejection })
  }

  const stopHeartbeat = (): void => {
    if (heartbeat === null) return
    clearInterval(heartbeat)
    heartbeat = null
  }

  const startHeartbeat = (): void => {
    if (heartbeatMs <= 0 || heartbeat !== null) return
    heartbeat = setInterval(() => {
      // Two missed intervals with nothing arriving means the socket is open in
      // name only. Forcing a reconnect is the only way back from that, and it
      // costs nothing when the diagnosis is wrong.
      if (now() - lastSeenAt > heartbeatMs * 2) {
        socket?.reconnect()
        return
      }
      send({ t: 'ping', at: now() })
    }, heartbeatMs)
  }

  const maxAttempts = config.retry?.maxAttempts ?? MAX_RECONNECT_ATTEMPTS
  const host = config.host ?? partyHost()
  if (host === null) {
    setStatus('rejected', { code: 'no-party-host', message: rejectionMessage('no-party-host') })
  }

  const send = (message: ClientMessage): boolean => {
    const live = socket
    if (live === null || live.readyState !== live.OPEN) return false
    live.send(encodeMessage(message))
    return true
  }

  const handlePong = (message: ServerMessage): void => {
    if (message.t !== 'pong') return
    const rttMs = Math.max(0, now() - message.at)
    // The server's timestamp was taken roughly halfway through the round trip,
    // so half the trip is the best correction available without a real clock
    // sync protocol. Sub-frame accuracy is not the point: this only has to keep
    // a countdown from being visibly wrong.
    clock = { offsetMs: Math.round(message.serverTime + rttMs / 2 - now()), rttMs }
    emit({ kind: 'clock', clock })
  }

  const handleMessage = (raw: unknown): void => {
    lastSeenAt = now()
    const message = parseServerMessage(raw)
    if (message === null) return
    if (message.t === 'pong') {
      handlePong(message)
      return
    }
    if (message.t === 'welcome') {
      // Kept before the event goes out, so that anything the store does in
      // response to being admitted already has a seat to come back to.
      seat = message.token
      rememberSeatToken(config.room, message.token)
      admitted = true
      setStatus('connected')
    }
    if (message.t === 'error' && isFatalErrorCode(message.code)) {
      // Refused rather than merely told off: stop reconnecting and let the
      // close that follows find the client already in its final state.
      closedByUs = true
      setStatus('rejected', { code: message.code, message: message.message })
      stopHeartbeat()
      socket?.close(1000, message.code)
    }
    emit({ kind: 'message', message })
  }

  if (host !== null) {
    const live = new PartySocket({
      host,
      party: PARTY_ROOM_PARTY,
      room: config.room,
      id: config.sessionId ?? sessionPlayerId(),
      // Carried on the handshake URL as well as in the join frame, so a
      // connection refused before the room ever reads a message is still
      // attributable to a version in a server log.
      query: { v: String(PROTOCOL_VERSION) },
      minReconnectionDelay: config.retry?.minDelayMs ?? MIN_RECONNECT_DELAY_MS,
      maxReconnectionDelay: config.retry?.maxDelayMs ?? MAX_RECONNECT_DELAY_MS,
      maxRetries: maxAttempts,
      // Nothing is buffered across a disconnect. A progress tick or a stale
      // claim replayed on the far side of a reconnect would describe a moment
      // that has passed; the store re-sends what still matters once the
      // `welcome` for the new connection arrives.
      maxEnqueuedMessages: 0,
      shouldReconnectOnClose: (event) => !isFatalClose(event.code),
      ...(config.socket ? { WebSocket: config.socket } : {}),
    })
    socket = live
    setStatus('connecting')

    live.addEventListener('open', () => {
      lastSeenAt = now()
      // The join carries the name on every connection, not just the first, so a
      // reconnecting player re-asserts who they are without the store having to
      // know whether this socket is new. It carries the seat token whenever
      // there is one, which is what turns this socket into the same player
      // rather than another one; without it the room has no way to tell, and
      // must not guess.
      send({
        t: 'join',
        v: PROTOCOL_VERSION,
        name: config.name,
        ...(seat === null ? {} : { token: seat }),
      })
      startHeartbeat()
    })

    live.addEventListener('message', (event: MessageEvent) => {
      handleMessage(event.data)
    })

    live.addEventListener('close', (event) => {
      stopHeartbeat()
      if (status === 'rejected') return
      const refusal = rejectionFromClose(event.code, event.reason)
      if (refusal !== null) {
        setStatus('rejected', refusal)
        return
      }
      // A refusing close with no refusal in it is the room acknowledging an
      // exit this player asked for.
      if (isFatalClose(event.code)) {
        setStatus('disconnected')
        return
      }
      if (closedByUs) {
        setStatus('disconnected')
        return
      }
      // `partysocket` has already decided whether to retry by the time this
      // fires, so its own verdict is the honest one to report.
      const exhausted = !live.shouldReconnect || live.retryCount >= maxAttempts
      setStatus(exhausted ? 'disconnected' : admitted ? 'reconnecting' : 'connecting')
    })

    live.addEventListener('error', () => {
      // An error is always followed by a close, which is where the decision is
      // made. Swallowing it here keeps an unhandled event from reaching the
      // console on every ordinary reconnect.
    })
  }

  return {
    room: config.room,
    status: () => status,
    rejection: () => rejection,
    clock: () => clock,
    send,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    reconnect: () => {
      if (status === 'rejected' || socket === null) return
      closedByUs = false
      setStatus(admitted ? 'reconnecting' : 'connecting')
      socket.reconnect()
    },
    close: (options) => {
      closedByUs = true
      stopHeartbeat()
      if (options?.leave === true) {
        send({ t: 'leave' })
        // The seat is being given up, so the token that owns it is worthless
        // and keeping it would only mean presenting a stale credential the next
        // time this tab tried the same room.
        seat = null
        clearSeatToken(config.room)
      }
      socket?.close(1000, 'client-close')
      setStatus('disconnected')
      listeners.clear()
    },
  }
}

/** Whether a room code is live, answered without opening a socket to it. */
export type RoomLookup =
  { ok: true; code: RoomCode } | { ok: false; reason: RejectionCode; message: string }

export type LobbyOptions = {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/** The lobby is a registry lookup, not a match; it should answer instantly. */
const LOBBY_TIMEOUT_MS = 4_000

/** A lobby request the server refused, carrying the status so callers can read it. */
type LobbyFailure = Error & { status?: number }

const lobbyFailure = (message: string, status?: number): LobbyFailure => {
  const error: LobbyFailure = new Error(message)
  if (status !== undefined) error.status = status
  return error
}

const statusOf = (error: unknown): number | null =>
  typeof error === 'object' && error !== null && typeof (error as LobbyFailure).status === 'number'
    ? ((error as LobbyFailure).status as number)
    : null

const lobbyFetch = async (
  path: string,
  init: RequestInit,
  options: LobbyOptions,
): Promise<unknown> => {
  const url = partyUrl(path)
  const doFetch = options.fetchImpl ?? (typeof fetch === 'function' ? fetch : null)
  if (url === null || doFetch === null) throw lobbyFailure('no-party-host')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? LOBBY_TIMEOUT_MS)
  try {
    const response = await doFetch(url, {
      ...init,
      cache: 'no-store',
      credentials: 'omit',
      mode: 'cors',
      signal: controller.signal,
    })
    if (!response.ok) throw lobbyFailure(`lobby-${response.status}`, response.status)
    return (await response.json()) as unknown
  } finally {
    clearTimeout(timer)
  }
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

/**
 * Asks the lobby for a free room code.
 *
 * Code uniqueness is only knowable where the live rooms are known, so the
 * server mints it; the client's job is to display it and connect to it. The
 * lobby can legitimately fail to find a free code, which is a "try again"
 * rather than an error worth dwelling on.
 *
 * Room codes are a finite shared resource, so the lobby rations them and a
 * caller asking for too many is told so. That is a different thing from the
 * server being broken and is worth saying differently: "slow down" is advice a
 * player can act on.
 */
export const createRoom = async (
  options: LobbyOptions = {},
): Promise<
  { ok: true; code: RoomCode } | { ok: false; reason: RejectionCode; message: string }
> => {
  try {
    const body = asRecord(await lobbyFetch(PARTY_ROOMS_PATH, { method: 'POST' }, options))
    const code = body?.['code']
    if (typeof code !== 'string' || code.length === 0) {
      return { ok: false, reason: 'server-error', message: rejectionMessage('server-error') }
    }
    return { ok: true, code: code as RoomCode }
  } catch (error) {
    if (statusOf(error) === 429) {
      return { ok: false, reason: 'rate-limited', message: rejectionMessage('rate-limited') }
    }
    return { ok: false, reason: 'server-error', message: rejectionMessage('server-error') }
  }
}

/**
 * Checks that a room code is live before connecting to it.
 *
 * Worth a round trip: a mistyped code is by far the likeliest thing to go wrong
 * on the join screen, and this turns it into a message under the text field
 * rather than a socket that opens and then closes. The registry answers only
 * whether the code is in use — how full the room is and whether its match has
 * started are the room's own business, and it says so on the socket.
 */
export const lookupRoom = async (
  code: RoomCode,
  options: LobbyOptions = {},
): Promise<RoomLookup> => {
  let body: Record<string, unknown> | null
  try {
    body = asRecord(await lobbyFetch(`${PARTY_ROOMS_PATH}/${code}`, { method: 'GET' }, options))
  } catch {
    return { ok: false, reason: 'server-error', message: rejectionMessage('server-error') }
  }
  if (body === null || body['exists'] !== true) {
    return { ok: false, reason: 'room-not-found', message: rejectionMessage('room-not-found') }
  }
  return { ok: true, code }
}
