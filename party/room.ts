import { Server, getServerByName } from 'partyserver'
import type { Connection, ConnectionContext, WSMessage } from 'partyserver'
import {
  MAX_PLAYERS,
  PROGRESS_TICK_INTERVAL_MS,
  PROTOCOL_VERSION,
  encodeMessage,
  parseClientMessage,
} from '../src/multiplayer/protocol'
import type {
  ClientMessage,
  LevelSpec,
  Player,
  PlayerId,
  PodiumEntry,
  ProgressTick,
  RoomCode,
  RoomErrorCode,
  RoomPhase,
  RoomSettings,
  RoomState,
  ServerMessage,
} from '../src/multiplayer/protocol'
import { DEFAULT_SETTINGS } from '../src/multiplayer/protocol'
import {
  INTERLUDE_MS,
  RECONNECT_GRACE_MS,
  activeParticipants,
  applyDisconnect,
  applyFinish,
  applyLeave,
  applyReconnect,
  beginLevel,
  canAcceptFinish,
  canStartMatch,
  chooseHost,
  createMatch,
  finishMatch,
  isSyncedMode,
  levelCountFor,
  levelDeadlineAt,
  levelEndReason,
  levelSpecAt,
  matchDeadlineAt,
  matchEndReason,
  matchPodium,
  playerLevelIndex,
  resolveLevel,
  standingFor,
} from '../src/multiplayer/match'
import type { MatchState } from '../src/multiplayer/match'
import type { Env } from './env'
import { SeatKeyring } from './lib/identity'
import { LevelVault } from './lib/levels'
import { commandBucket, progressBucket, type TokenBucket } from './lib/rateLimit'
import { fallbackName, uniqueName } from './lib/names'
import { REGISTRY_NAME } from './registry'
import {
  SNAPSHOT_KEY,
  SNAPSHOT_VERSION,
  decodeRoomSnapshot,
  type RoomSnapshot,
} from './lib/snapshot'

/**
 * One room, and the only authority over what happened in it.
 *
 * The rules themselves are not here. `src/multiplayer/match.ts` is a pure
 * rulebook that the client imports too, so both ends compute the same podium
 * from the same recorded finishes; this class supplies the three things a pure
 * function cannot — a clock, a socket, and somewhere to put the answer.
 *
 * THE CLOCK. Every duration that decides a placing is measured here, between a
 * level start this object broadcast and a claim this object accepted. A client
 * sends its own elapsed time as `clientMs` and the server uses it for nothing:
 * phone clocks are wrong by seconds, and a client that wanted to lie would
 * simply lie. There is exactly one `Date.now()` in this file, so there is
 * exactly one place a timing decision can come from.
 *
 * VERIFICATION. A claimed solution is checked against the level the server
 * generates from the same level number, in `./levels`. Nothing else in the
 * claim is trusted.
 *
 * IDENTITY. A connection is nobody until it presents something. Its id is
 * minted by the Worker in front of this object and means only "this socket";
 * a seat is entered by minting one or by presenting the seat's token, which
 * this room issued to its owner alone. Player ids go out in every broadcast and
 * grant nothing, which is what stops reading the room from being enough to take
 * a place in it. See ./lib/identity.
 *
 * MEMORY, WITH A WRITE-DOWN. Room state lives in fields. Durable Object storage
 * carries a snapshot written on transitions only, so an eviction mid-match is
 * recoverable while the 250 ms progress path never touches disk. See
 * ./snapshot for exactly what is written and why.
 *
 * HIBERNATION IS OFF. A match is minutes long and continuously active, and the
 * room depends on in-memory timers for the progress pump and on in-memory rate
 * limits per connection. Hibernation would evict all three between messages to
 * save duration billing the room is not idle enough to benefit from. The
 * durable alarm below is the safety net for the eviction that happens anyway.
 */

/** A connection that never sends `join` is closed rather than left to squat a slot. */
const JOIN_GRACE_MS = 10_000

/** How long an empty room waits before releasing its code and wiping itself. */
const EMPTY_CLOSE_MS = 60_000

/** How often a populated room tells the registry its code is still in use. */
const REGISTRY_HEARTBEAT_MS = 5 * 60_000

/** Ignore an alarm reschedule smaller than this; each one is a storage write. */
const ALARM_SLACK_MS = 1000

/** Guards the catch-up loop when a wake finds several deadlines already past. */
const MAX_TRANSITIONS_PER_WAKE = 32

/** How long a connection must wait before another rate-limit complaint. */
const RATE_LIMIT_NOTICE_MS = 2000

/** Close codes. 4000+ is the application-defined range. */
const CLOSE_REJECTED = 4001

type Seat = {
  id: PlayerId
  name: string
  joinedAt: number
  /**
   * The socket currently sitting in this seat, or null between connections.
   *
   * Every message is attributed through this field, so a frame only counts as
   * this player's if it arrives on the connection the seat is holding. It also
   * settles the ordering when a player comes back before the room has noticed
   * they left: the close of the connection they replaced must not mark the seat
   * disconnected, because by then somebody is sitting in it.
   */
  connectionId: string | null
  connected: boolean
  /** Server epoch ms of the drop that started the reconnect grace, or null. */
  disconnectedAt: number | null
  /**
   * True once the player has left for good: the grace expired, or they said so.
   * The seat is kept rather than deleted so the podium and the results can still
   * put a name to the id, and it frees its slot for a new player immediately.
   */
  gone: boolean
  /** Latest progress sample: cats correctly placed on their current board. */
  progress: number
}

type Budget = {
  commands: TokenBucket
  progress: TokenBucket
  noticedAt: number
}

export class Room extends Server<Env> {
  /** See the class docstring: a match is active throughout, so there is nothing to hibernate. */
  static override options = { hibernate: false }

  #phase: RoomPhase = 'lobby'
  #hostId: PlayerId | null = null
  #settings: RoomSettings = DEFAULT_SETTINGS
  #seats = new Map<PlayerId, Seat>()

  /** Seat tokens, kept apart from the seats so a broadcast cannot carry one. */
  #keyring = new SeatKeyring()

  /** Which seat each live connection is sitting in. The inverse of `Seat.connectionId`. */
  #byConnection = new Map<string, PlayerId>()

  #match: MatchState | null = null
  #podium: PodiumEntry[] | null = null
  #phaseStartedAt = 0
  #phaseEndsAt: number | null = null

  /**
   * When each player's current level started, by server clock.
   *
   * Identical for everyone in steady and knockout, and the whole point of the
   * map in blaze, where a player's next level starts the instant their last
   * solve is accepted and nobody else's clock moves.
   */
  #levelStartedAt = new Map<PlayerId, number>()

  /** Interlude skips: players who have said they are ready for the next level. */
  #ready = new Set<PlayerId>()

  #vault = new LevelVault()

  /** Players whose progress has changed since the last fan-out. */
  #dirty = new Set<PlayerId>()
  #pump: ReturnType<typeof setInterval> | null = null

  /** Connections that have opened but not yet completed the join handshake. */
  #pending = new Map<string, number>()
  #budgets = new Map<string, Budget>()

  #wakeTimer: ReturnType<typeof setTimeout> | null = null
  #alarmAt: number | null = null
  #emptySince: number | null = null
  #registryTouchedAt = 0
  #persistTimer: ReturnType<typeof setTimeout> | null = null
  #closed = false

  get #code(): RoomCode {
    return this.name as RoomCode
  }

  // ---------------------------------------------------------------- lifecycle

  override async onStart(): Promise<void> {
    const snapshot = decodeRoomSnapshot(await this.ctx.storage.get(SNAPSHOT_KEY))
    if (snapshot) this.#restore(snapshot)
    this.#tick(Date.now())
  }

  /**
   * Rebuilds a room from its last written snapshot.
   *
   * Every seat comes back disconnected, because whatever sockets existed died
   * with the previous instance. Players reconnect into the same seats within
   * seconds — the reconnect grace exists precisely to cover this — and the
   * match carries on from the finishes it had already recorded. The seat tokens
   * come back with the seats, since they are the only thing that will let those
   * players prove which seat is theirs.
   */
  #restore(snapshot: RoomSnapshot): void {
    const now = Date.now()
    this.#phase = snapshot.phase
    this.#hostId = snapshot.hostId
    this.#settings = snapshot.settings
    this.#match = snapshot.match
    this.#podium = snapshot.podium
    this.#phaseStartedAt = snapshot.phaseStartedAt
    this.#phaseEndsAt = snapshot.phaseEndsAt
    this.#vault = new LevelVault(undefined, snapshot.levels)
    this.#levelStartedAt = new Map(Object.entries(snapshot.levelStartedAt))
    this.#keyring = new SeatKeyring()
    this.#byConnection.clear()
    this.#seats = new Map(
      snapshot.seats.map((seat) => [
        seat.id,
        {
          id: seat.id,
          name: seat.name,
          joinedAt: seat.joinedAt,
          connectionId: null,
          connected: false,
          disconnectedAt: seat.disconnectedAt ?? now,
          gone: false,
          progress: 0,
        },
      ]),
    )
    for (const seat of snapshot.seats) this.#keyring.adopt(seat.id, seat.token)
    if (this.#match) {
      for (const participant of this.#match.participants) {
        if (participant.exit !== null) {
          const seat = this.#seats.get(participant.id)
          if (seat) seat.gone = true
        }
      }
      for (const seat of this.#seats.values()) {
        this.#match = applyDisconnect(this.#match, seat.id)
      }
    }
    this.#emptySince = now
  }

  override onConnect(connection: Connection, _ctx: ConnectionContext): void {
    const now = Date.now()
    if (this.#closed) {
      // The room released its code and wiped itself; whoever this is has stale
      // information and belongs in a new room, not a resurrected one.
      this.#reject(connection, 'not-in-match', 'That room has closed.')
      return
    }
    if (this.#byConnection.has(connection.id) || this.#pending.has(connection.id)) {
      // Two sockets with one id. PartyServer keys its connection map by that
      // id, so the newcomer has already displaced whoever was there and the
      // room can no longer reach them — the only thing left to do is refuse the
      // one that caused it. Unreachable while the Worker mints these ids; kept
      // because the cost of being wrong about that is a player silently losing
      // their connection to somebody else's.
      this.#reject(connection, 'server-error', 'That connection id is already in use.')
      return
    }
    this.#emptySince = null
    this.#pending.set(connection.id, now)
    this.#budgets.set(connection.id, {
      commands: commandBucket(now),
      progress: progressBucket(now),
      noticedAt: 0,
    })
    this.#arm(now)
  }

  override onClose(connection: Connection, _code: number, _reason: string, _clean: boolean): void {
    const now = Date.now()
    this.#pending.delete(connection.id)
    this.#budgets.delete(connection.id)

    // Only the connection the seat is actually holding can vacate it. A socket
    // that was superseded by its owner reconnecting closes afterwards, and
    // treating that as a drop would take a player who is demonstrably present
    // and start their reconnect grace running.
    const seat = this.#seatOn(connection.id)
    this.#byConnection.delete(connection.id)
    if (seat && !seat.gone) {
      seat.connectionId = null
      seat.connected = false
      seat.disconnectedAt = now
      if (this.#inMatch()) {
        // Keep the seat and keep their clock running. A locked phone, a tunnel
        // or a Wi-Fi handover all last seconds, and taking someone out of a
        // match for one would be worse for the room than a greyed-out name.
        if (this.#match) this.#match = applyDisconnect(this.#match, seat.id)
      } else if (this.#phase === 'lobby') {
        // Nothing to forfeit in a lobby, and holding the slot would keep a
        // ninth player out on behalf of somebody who closed the tab.
        this.#removeSeat(seat)
      } else {
        // Between matches the seat is kept so the podium can still name them.
        seat.gone = true
      }
      this.#reseatHost()
      this.#broadcastState(now)
    }

    if (this.#connectionCount() === 0) this.#emptySince = now
    this.#persistSoon()
    this.#tick(now)
  }

  override onError(connection: Connection, error: unknown): void {
    console.error(`room ${this.#code}: connection ${connection.id} errored`, error)
  }

  override onException(error: unknown): void {
    console.error(`room ${this.#code}: unhandled exception`, error)
  }

  override onAlarm(): void {
    this.#alarmAt = null
    this.#tick(Date.now())
  }

  // ----------------------------------------------------------------- messages

  override onMessage(connection: Connection, raw: WSMessage): void {
    const now = Date.now()
    if (typeof raw !== 'string') {
      this.#reject(connection, 'bad-message', 'Messages must be JSON text.')
      return
    }
    const message = parseClientMessage(raw)
    if (!message) {
      this.#reject(connection, 'bad-message', 'Unrecognised message.')
      return
    }
    if (!this.#afford(connection, message, now)) return

    switch (message.t) {
      case 'join':
        this.#onJoin(connection, message, now)
        return
      case 'ping':
        this.#send(connection, { t: 'pong', at: message.at, serverTime: now })
        return
      default:
        break
    }

    const seat = this.#seatOn(connection.id)
    if (!seat || seat.gone) {
      this.#reject(connection, 'not-in-match', 'Send join before anything else.')
      return
    }

    switch (message.t) {
      case 'name':
        this.#onName(seat, message.name, now)
        break
      case 'settings':
        this.#onSettings(connection, seat, message.settings, now)
        break
      case 'start':
        this.#onStartMatch(connection, seat, now)
        break
      case 'progress':
        this.#onProgress(seat, message.cats)
        break
      case 'solved':
        this.#onSolved(connection, seat, message, now)
        break
      case 'ready':
        this.#onReady(seat, now)
        break
      case 'rematch':
        this.#onRematch(connection, now)
        break
      case 'leave':
        this.#onLeave(connection, seat, now)
        break
      default:
        break
    }
  }

  /**
   * Spends the sender's message budget.
   *
   * Progress and commands have separate buckets because they have nothing in
   * common: progress is bursty and disposable, commands are rare and
   * consequential. Over-budget progress is dropped in silence — the next tick
   * carries the true number anyway, so complaining would cost more than the
   * message did. Over-budget commands get one complaint every couple of
   * seconds, which is enough to explain a refusal without becoming a second
   * flood in the opposite direction.
   */
  #afford(connection: Connection, message: ClientMessage, now: number): boolean {
    const budget = this.#budgets.get(connection.id)
    if (!budget) return true
    if (message.t === 'progress') return budget.progress.take(now)
    if (budget.commands.take(now)) return true
    if (now - budget.noticedAt >= RATE_LIMIT_NOTICE_MS) {
      budget.noticedAt = now
      this.#send(connection, { t: 'error', code: 'rate-limited', message: 'Slow down.' })
    }
    return false
  }

  /**
   * The only way into a seat.
   *
   * Order is the substance of this method. A join either presents a token this
   * room issued, in which case it is the return of a player the room already
   * knows, or it does not, in which case it is a stranger and every door policy
   * applies to it: a match under way is closed, and a full room is full.
   *
   * Getting that order wrong is what made the room hijackable. When a seat
   * could be re-entered by naming it, and naming it was tried before the
   * match-in-progress guard, anybody who had read a state frame could walk into
   * a running match as any player in it.
   */
  #onJoin(connection: Connection, message: ClientMessage & { t: 'join' }, now: number): void {
    if (message.v !== PROTOCOL_VERSION) {
      this.#reject(connection, 'version-mismatch', 'Reload Meowdoku to join this room.')
      return
    }
    this.#pending.delete(connection.id)

    // A repeated join on a connection that already holds a seat is the client
    // re-asserting itself; answer it the same way as a return.
    const held = this.#seatOn(connection.id)
    const claimed = this.#keyring.resolve(message.token)
    const returning = held ?? (claimed === null ? null : this.#seats.get(claimed))
    if (returning && !returning.gone) {
      this.#resume(connection, returning, message.name, now)
      return
    }

    // A match already under way is closed to newcomers. Letting somebody in
    // halfway would either hand them a schedule they cannot win or make every
    // ranking mean something different, and there is a coherent alternative
    // already: wait for the podium, and for the room to return to its lobby.
    if (this.#phase !== 'lobby' && this.#phase !== 'finished') {
      this.#reject(connection, 'match-in-progress', 'That match has already started.')
      return
    }
    if (this.#activeSeatCount() >= MAX_PLAYERS) {
      this.#reject(connection, 'room-full', 'That room is full.')
      return
    }

    const identity = this.#keyring.mint()
    const seat: Seat = {
      id: identity.id,
      name: this.#nameFor(message.name, identity.id),
      joinedAt: now,
      connectionId: null,
      connected: true,
      disconnectedAt: null,
      gone: false,
      progress: 0,
    }
    this.#seats.set(seat.id, seat)
    this.#bind(connection, seat)
    if (this.#hostId === null || !this.#seats.has(this.#hostId)) this.#hostId = seat.id

    this.#welcome(connection, seat, now)
    this.#broadcastState(now, connection.id)
    this.#persistSoon()
    void this.#touchRegistry(now, true)
    this.#arm(now)
  }

  /**
   * Puts a returning player back in the seat they left.
   *
   * Reached only by presenting the seat's token, so this is the owner by
   * definition — which is also why a second connection is allowed to take the
   * seat over rather than being refused. A phone that reloads, or a socket that
   * is open but has quietly stopped delivering, leaves a connection the server
   * still believes in; refusing the new one would strand the player behind
   * their own ghost until the grace period ran out.
   */
  #resume(connection: Connection, seat: Seat, name: string, now: number): void {
    this.#bind(connection, seat)
    seat.connected = true
    seat.disconnectedAt = null
    if (name.length > 0 && name !== seat.name) seat.name = this.#nameFor(name, seat.id)
    if (this.#match) this.#match = applyReconnect(this.#match, seat.id)
    if (this.#hostId === null) this.#hostId = seat.id

    this.#welcome(connection, seat, now)
    this.#broadcastState(now, connection.id)
    this.#persistSoon()
    this.#arm(now)
  }

  /**
   * Hands a seat to a connection, evicting whatever was in it.
   *
   * The rebind happens before the old socket is closed, so that the close —
   * which arrives later and carries the old connection's id — finds a seat that
   * is no longer its and leaves the player alone.
   */
  #bind(connection: Connection, seat: Seat): void {
    const previous = seat.connectionId
    seat.connectionId = connection.id
    this.#byConnection.set(connection.id, seat.id)
    if (previous === null || previous === connection.id) return
    this.#byConnection.delete(previous)
    try {
      this.getConnection(previous)?.close(CLOSE_REJECTED, 'superseded')
    } catch {
      // Already gone, which is the usual case: this is the socket that dropped.
    }
  }

  /** The seat a connection is holding, or null if it is holding none. */
  #seatOn(connectionId: string): Seat | null {
    const playerId = this.#byConnection.get(connectionId)
    if (playerId === undefined) return null
    const seat = this.#seats.get(playerId)
    if (!seat || seat.connectionId !== connectionId) return null
    return seat
  }

  /** Forgets a seat completely: its slot, its secret and its connection. */
  #removeSeat(seat: Seat): void {
    this.#seats.delete(seat.id)
    this.#keyring.forget(seat.id)
    this.#ready.delete(seat.id)
    this.#dirty.delete(seat.id)
    this.#levelStartedAt.delete(seat.id)
    if (seat.connectionId !== null) this.#byConnection.delete(seat.connectionId)
    seat.connectionId = null
  }

  /**
   * The opening burst on a connection.
   *
   * A reconnecting player needs more than the room snapshot: they need the
   * schedule they missed and the clock of the level they are in the middle of,
   * so their board and their timer come back where they left them rather than
   * at zero.
   *
   * This is also the one frame in the protocol that carries a secret. The token
   * goes to this connection and is never broadcast, never stored in room state
   * and never mentioned in an error, because it is the whole of what proves a
   * seat belongs to whoever is holding it.
   */
  #welcome(connection: Connection, seat: Seat, now: number): void {
    this.#send(connection, {
      t: 'welcome',
      v: PROTOCOL_VERSION,
      you: seat.id,
      token: this.#keyring.tokenFor(seat.id),
      state: this.#state(now),
    })
    const match = this.#match
    if (!match) return
    this.#send(connection, {
      t: 'match',
      schedule: match.schedule,
      levelCount: match.levelCount,
      startsAt: match.startedAt,
    })
    if (this.#phase === 'playing') {
      const levelIndex = playerLevelIndex(match, seat.id)
      this.#send(connection, {
        t: 'level',
        levelIndex,
        startsAt: this.#levelStartedAt.get(seat.id) ?? match.levelStartedAt,
        deadlineAt: this.#phaseEndsAt ?? levelDeadlineAt(match),
      })
    }
    if (this.#phase === 'finished' && this.#podium) {
      this.#send(connection, { t: 'finished', podium: this.#podium })
    }
  }

  #onName(seat: Seat, name: string, now: number): void {
    const next = this.#nameFor(name, seat.id)
    if (next === seat.name) return
    seat.name = next
    this.#broadcastState(now)
    this.#persistSoon()
  }

  #onSettings(connection: Connection, seat: Seat, settings: RoomSettings, now: number): void {
    if (seat.id !== this.#hostId) {
      this.#send(connection, {
        t: 'error',
        code: 'not-host',
        message: 'Only the host can change the mode.',
      })
      return
    }
    if (this.#phase !== 'lobby' && this.#phase !== 'finished') {
      this.#send(connection, {
        t: 'error',
        code: 'match-in-progress',
        message: 'The mode cannot change during a match.',
      })
      return
    }
    this.#settings = settings
    this.#broadcastState(now)
    this.#persistSoon()
  }

  #onStartMatch(connection: Connection, seat: Seat, now: number): void {
    if (seat.id !== this.#hostId) {
      this.#send(connection, { t: 'error', code: 'not-host', message: 'Only the host can start.' })
      return
    }
    if (this.#phase !== 'lobby' && this.#phase !== 'finished') {
      this.#send(connection, {
        t: 'error',
        code: 'match-in-progress',
        message: 'That match is already running.',
      })
      return
    }
    // A match starts from the players who are actually here, so anyone who
    // drifted off does not silently pad the field — which in knockout would
    // also inflate the number of levels.
    this.#dropAbsentSeats()
    const players = this.#players()
    const allowed = canStartMatch(this.#settings, players)
    if (!allowed.ok) {
      this.#send(connection, {
        t: 'error',
        code: allowed.code,
        message:
          allowed.code === 'not-enough-players'
            ? 'Not enough players for that mode yet.'
            : 'That room cannot start right now.',
      })
      return
    }

    const match = createMatch({
      settings: this.#settings,
      // The code alone would make every match in a room identical; the start
      // time makes a rematch a different set of puzzles.
      seed: `${this.#code}:${now}`,
      players: players.map((player) => player.id),
      startedAt: now,
    })
    this.#match = match
    this.#podium = null
    this.#phase = 'countdown'
    this.#phaseStartedAt = now
    this.#phaseEndsAt = match.levelStartedAt
    this.#ready.clear()
    this.#levelStartedAt.clear()
    for (const other of this.#seats.values()) other.progress = 0

    this.#broadcast({ t: 'countdown', startsAt: match.levelStartedAt })
    this.#broadcast({
      t: 'match',
      schedule: match.schedule,
      levelCount: match.levelCount,
      startsAt: match.levelStartedAt,
    })
    this.#broadcastState(now)

    // Generate the first board during the countdown. Three seconds of wall
    // clock buys the room the one expensive thing it does, so that the first
    // claim of the match is an array comparison rather than a generation.
    this.#vault.warm(levelSpecAt(match, 0)?.levelNumber)
    this.#persistSoon()
    void this.#touchRegistry(now, true)
    this.#arm(now)
  }

  #onProgress(seat: Seat, cats: number): void {
    const cap = this.#currentSpecFor(seat.id)?.size ?? cats
    const next = Math.max(0, Math.min(cats, cap))
    if (next === seat.progress) return
    seat.progress = next
    this.#dirty.add(seat.id)
  }

  /**
   * Accepts or refuses a claimed solution.
   *
   * The order matters: the rules decide whether this player may finish this
   * level at all before any board is generated, so a client cannot make the
   * room do work by claiming levels it is not on.
   */
  #onSolved(
    connection: Connection,
    seat: Seat,
    message: ClientMessage & { t: 'solved' },
    now: number,
  ): void {
    const match = this.#match
    if (!match || this.#phase !== 'playing') {
      this.#send(connection, { t: 'error', code: 'not-in-match', message: 'No level is running.' })
      return
    }
    const { levelIndex, cols } = message.claim
    if (!canAcceptFinish(match, seat.id, levelIndex)) {
      this.#send(connection, {
        t: 'error',
        code: 'not-in-match',
        message: 'That level is not yours to finish.',
      })
      return
    }
    const spec = levelSpecAt(match, levelIndex)
    if (!spec || cols.length !== spec.size) {
      this.#send(connection, {
        t: 'error',
        code: 'invalid-solution',
        message: 'That is not a solution to this board.',
      })
      return
    }
    if (!this.#vault.verify(spec.levelNumber, cols)) {
      this.#send(connection, {
        t: 'error',
        code: 'invalid-solution',
        message: 'That is not a solution to this board.',
      })
      return
    }

    // The server's own measurement, start to finish. `message.clientMs` is
    // recorded nowhere: it exists so a support question about a suspicious time
    // has two numbers to compare, not so it can decide one.
    const startedAt = this.#levelStartedAt.get(seat.id) ?? match.levelStartedAt
    const elapsedMs = Math.max(0, now - startedAt)

    this.#match = applyFinish(match, {
      playerId: seat.id,
      levelIndex,
      status: 'solved',
      elapsedMs,
      progress: spec.size,
    })
    seat.progress = spec.size
    this.#dirty.add(seat.id)
    this.#send(connection, { t: 'accepted', levelIndex, elapsedMs })

    if (!isSyncedMode(match.settings)) {
      // Blaze: this player's next level starts now and nobody else's clock
      // moves. Their bar drops back to zero on a board only they are looking at.
      this.#levelStartedAt.set(seat.id, now)
      seat.progress = 0
      const next = this.#match
      this.#vault.warm(levelSpecAt(next, playerLevelIndex(next, seat.id))?.levelNumber)
    }

    this.#persistSoon()
    this.#tick(now)
  }

  #onReady(seat: Seat, now: number): void {
    if (this.#phase !== 'interlude') return
    this.#ready.add(seat.id)
    this.#tick(now)
  }

  /**
   * Puts a finished room back in its lobby.
   *
   * A room outlives its matches. Without this the phase reached `finished` and
   * stayed there for as long as the room existed, which made the podium a dead
   * end: the mode could not be changed in any way the lobby would show, nobody
   * could set up another match, and the only way to play again with the same
   * people was for all of them to leave and build a new room around a new code
   * read aloud again.
   *
   * Any player may ask, not just the host. The podium is on everybody's screen
   * and the room moves through phases together, so making this the host's
   * privilege would mean a room whose host has wandered off is a room nobody
   * can restart — the same dead end by a different route.
   */
  #onRematch(connection: Connection, now: number): void {
    if (this.#phase === 'lobby') return
    if (this.#phase !== 'finished') {
      this.#send(connection, {
        t: 'error',
        code: 'match-in-progress',
        message: 'That match is still running.',
      })
      return
    }
    this.#returnToLobby(now)
  }

  /**
   * Discards the finished match and leaves a lobby behind.
   *
   * Everything a match decided goes with it. Scores, eliminations, the podium,
   * the schedule and the knockout roster are all derived from `#match`, so
   * dropping it is what makes the next match a new one rather than a
   * continuation: nobody starts the rematch already knocked out, and the
   * knockout length is recomputed from whoever is in the room when it starts.
   *
   * What survives is the room itself — its code, its settings, and the people
   * still connected. Settings survive because a rematch is nearly always the
   * same game again, and changing the mode is one tap away in the lobby.
   * Players who left or dropped do not, both so the field is honest and so
   * their slots are free for somebody new.
   */
  #returnToLobby(now: number): void {
    this.#dropAbsentSeats()
    this.#match = null
    this.#podium = null
    this.#phase = 'lobby'
    this.#phaseStartedAt = now
    this.#phaseEndsAt = null
    this.#ready.clear()
    this.#levelStartedAt.clear()
    this.#dirty.clear()
    this.#stopPump()
    for (const seat of this.#seats.values()) seat.progress = 0
    // The host may have been one of the people who just left.
    this.#reseatHost()
    this.#broadcastState(now)
    this.#persistSoon()
    this.#arm(now)
  }

  /** Clears out the seats of players who are no longer in the room. */
  #dropAbsentSeats(): void {
    for (const seat of [...this.#seats.values()]) {
      if (seat.gone || !seat.connected) this.#removeSeat(seat)
    }
  }

  #onLeave(connection: Connection, seat: Seat, now: number): void {
    this.#retire(seat, now)
    this.#broadcastState(now)
    this.#persistSoon()
    try {
      connection.close(CLOSE_REJECTED, 'left')
    } catch {
      // Already gone; nothing to close.
    }
    this.#tick(now)
  }

  /**
   * Takes a player out for good.
   *
   * Leaving forfeits whatever level is in progress, even if a solve for it was
   * already banked: an absent player must not win a level, take a point, or
   * spare somebody else from a knockout. That consequence is `applyLeave`'s to
   * decide; detecting the event is this class's job.
   */
  #retire(seat: Seat, now: number): void {
    if (seat.gone) return
    seat.gone = true
    seat.connected = false
    seat.disconnectedAt = now
    seat.progress = 0
    this.#ready.delete(seat.id)
    if (seat.connectionId !== null) this.#byConnection.delete(seat.connectionId)
    seat.connectionId = null
    if (this.#match) this.#match = applyLeave(this.#match, seat.id)
    if (this.#phase === 'lobby') this.#removeSeat(seat)
    this.#reseatHost()
  }

  // ------------------------------------------------------------------- phases

  /**
   * The single scheduler.
   *
   * Everything time-driven passes through here — the end of the countdown, a
   * level's deadline, an interlude expiring, a reconnect grace running out, an
   * empty room closing — so a wake from an in-memory timer, a durable alarm, or
   * an incoming message all advance the room by exactly the same rules. The
   * loop exists because a wake can find several deadlines already past: an
   * eviction, or a room left with nobody in it.
   */
  #tick(now: number): void {
    if (this.#closed) return
    this.#expirePending(now)
    this.#expireGrace(now)

    for (let step = 0; step < MAX_TRANSITIONS_PER_WAKE; step++) {
      if (!this.#advance(now)) break
    }

    if (this.#phase === 'lobby' || this.#phase === 'finished') {
      if (this.#emptySince !== null && now - this.#emptySince >= EMPTY_CLOSE_MS) {
        void this.#close()
        return
      }
    }

    // The pump is derived from the phase rather than started and stopped by
    // hand, so a room restored mid-level after an eviction fans out progress
    // again without a separate restart path.
    if (this.#phase === 'playing') this.#startPump()
    else this.#stopPump()

    void this.#touchRegistry(now, false)
    this.#arm(now)
  }

  /** One state transition, or false when the room is settled for now. */
  #advance(now: number): boolean {
    const match = this.#match
    if (!match) return false

    switch (this.#phase) {
      case 'countdown':
        if (now < match.levelStartedAt) return false
        this.#beginLevel(now)
        return true
      case 'playing': {
        if (isSyncedMode(match.settings)) {
          if (levelEndReason(match, now) === null) return false
          this.#resolveLevel(now)
          return true
        }
        if (matchEndReason(match, now) === null) return false
        this.#finishMatch(now)
        return true
      }
      case 'interlude': {
        const due = this.#phaseEndsAt !== null && now >= this.#phaseEndsAt
        if (!due && !this.#everyoneReady()) return false
        this.#beginLevel(now)
        return true
      }
      default:
        return false
    }
  }

  #beginLevel(now: number): void {
    const match = this.#match
    if (!match) return
    const next = beginLevel(match, now)
    this.#match = next
    if (next.phase === 'finished') {
      this.#finishMatch(now)
      return
    }

    this.#phase = 'playing'
    this.#phaseStartedAt = next.levelStartedAt
    this.#phaseEndsAt = isSyncedMode(next.settings) ? levelDeadlineAt(next) : matchDeadlineAt(next)
    this.#ready.clear()
    this.#levelStartedAt.clear()
    for (const participant of activeParticipants(next)) {
      this.#levelStartedAt.set(participant.id, next.levelStartedAt)
    }
    for (const seat of this.#seats.values()) {
      seat.progress = 0
      this.#dirty.add(seat.id)
    }

    this.#vault.warm(levelSpecAt(next, next.levelIndex)?.levelNumber)
    this.#broadcast({
      t: 'level',
      levelIndex: next.levelIndex,
      startsAt: next.levelStartedAt,
      deadlineAt: this.#phaseEndsAt,
    })
    this.#broadcastState(now)
    this.#persistSoon()
  }

  #resolveLevel(now: number): void {
    const match = this.#match
    if (!match) return
    const progress: Record<PlayerId, number> = {}
    for (const seat of this.#seats.values()) progress[seat.id] = seat.progress

    const { state, result } = resolveLevel(match, now, progress)
    this.#match = state
    this.#stopPump()
    this.#flushProgress(now)
    if (result) this.#broadcast({ t: 'result', result })

    if (state.phase === 'finished') {
      this.#finishMatch(now)
      return
    }
    this.#phase = 'interlude'
    this.#phaseStartedAt = now
    this.#phaseEndsAt = now + INTERLUDE_MS
    this.#ready.clear()
    // The pause is the room's only free window in which to build the next
    // board, so use it rather than paying for it on the next level's first claim.
    this.#vault.warm(levelSpecAt(state, state.levelIndex)?.levelNumber)
    this.#broadcastState(now)
    this.#persistSoon()
  }

  #finishMatch(now: number): void {
    const match = this.#match
    if (!match) return
    const finished = finishMatch(match)
    this.#match = finished
    this.#podium = matchPodium(finished)
    this.#phase = 'finished'
    this.#phaseStartedAt = now
    this.#phaseEndsAt = null
    this.#ready.clear()
    this.#stopPump()
    this.#broadcast({ t: 'finished', podium: this.#podium })
    this.#broadcastState(now)
    this.#persistSoon()
  }

  /** Whether every player still racing has asked to skip the rest of the interlude. */
  #everyoneReady(): boolean {
    const match = this.#match
    if (!match) return false
    const waiting = activeParticipants(match).filter(
      (participant) => this.#seats.get(participant.id)?.connected === true,
    )
    if (waiting.length === 0) return false
    return waiting.every((participant) => this.#ready.has(participant.id))
  }

  #expirePending(now: number): void {
    for (const [id, since] of this.#pending) {
      if (now - since < JOIN_GRACE_MS) continue
      this.#pending.delete(id)
      const connection = this.getConnection(id)
      try {
        connection?.close(CLOSE_REJECTED, 'join timeout')
      } catch {
        // Already gone.
      }
    }
  }

  /** Turns a drop that outlasted its grace period into a departure. */
  #expireGrace(now: number): void {
    let changed = false
    for (const seat of this.#seats.values()) {
      if (seat.gone || seat.connected || seat.disconnectedAt === null) continue
      if (now - seat.disconnectedAt < RECONNECT_GRACE_MS) continue
      this.#retire(seat, now)
      changed = true
    }
    if (changed) {
      this.#broadcastState(now)
      this.#persistSoon()
    }
  }

  #reseatHost(): void {
    const host = this.#hostId === null ? null : this.#seats.get(this.#hostId)
    if (host && host.connected && !host.gone) return
    this.#hostId = chooseHost(this.#players(), this.#hostId)
  }

  // ------------------------------------------------------------------ fan-out

  /**
   * Coalesced progress.
   *
   * Eight players tapping quickly would otherwise turn into a fan-out storm:
   * every sample from every player relayed to every socket. Instead samples
   * land in a set and one message goes out per tick interval carrying at most
   * eight small tuples, so the cost of a busy room is fixed by the clock rather
   * than by how fast people are playing.
   */
  #startPump(): void {
    if (this.#pump !== null) return
    this.#pump = setInterval(() => this.#flushProgress(Date.now()), PROGRESS_TICK_INTERVAL_MS)
  }

  #stopPump(): void {
    if (this.#pump === null) return
    clearInterval(this.#pump)
    this.#pump = null
  }

  #flushProgress(now: number): void {
    if (this.#dirty.size === 0) return
    const match = this.#match
    const ticks: ProgressTick[] = []
    for (const id of this.#dirty) {
      const seat = this.#seats.get(id)
      if (!seat) continue
      ticks.push([id, match ? playerLevelIndex(match, id) : 0, seat.progress])
    }
    this.#dirty.clear()
    if (ticks.length === 0) return
    this.#broadcast({ t: 'progress', at: now, ticks })
  }

  #players(): Player[] {
    const match = this.#match
    return [...this.#seats.values()].map((seat) => {
      const standing = match ? standingFor(match, seat.id) : null
      return {
        id: seat.id,
        name: seat.name,
        joinedAt: seat.joinedAt,
        connected: seat.connected,
        levelIndex: match ? playerLevelIndex(match, seat.id) : -1,
        levelsSolved: standing?.levelsSolved ?? 0,
        points: standing?.points ?? 0,
        totalTimeMs: standing?.totalTimeMs ?? 0,
        eliminatedAtLevel: standing?.eliminatedAtLevel ?? null,
        progress: seat.progress,
      }
    })
  }

  #state(now: number): RoomState {
    const match = this.#match
    const players = this.#players()
    return {
      code: this.#code,
      phase: this.#phase,
      hostId: this.#hostId,
      settings: this.#settings,
      players,
      levelCount: match ? match.levelCount : levelCountFor(this.#settings, players.length),
      schedule: match ? match.schedule : null,
      levelIndex: match ? match.levelIndex : -1,
      phaseStartedAt: this.#phaseStartedAt,
      phaseEndsAt: this.#phaseEndsAt,
      results: match ? match.results : [],
      podium: this.#podium,
      serverTime: now,
    }
  }

  #broadcastState(now: number, without?: string): void {
    const encoded = encodeMessage({ t: 'state', state: this.#state(now) })
    this.broadcast(encoded, without === undefined ? undefined : [without])
  }

  #broadcast(message: ServerMessage): void {
    this.broadcast(encodeMessage(message))
  }

  #send(connection: Connection, message: ServerMessage): void {
    try {
      connection.send(encodeMessage(message))
    } catch {
      // The socket closed between the decision and the send. The room will
      // notice through onClose; there is nothing useful to do here.
    }
  }

  /** An error the connection cannot recover from: explain, then hang up. */
  #reject(connection: Connection, code: RoomErrorCode, message: string): void {
    this.#send(connection, { t: 'error', code, message })
    try {
      connection.close(CLOSE_REJECTED, code)
    } catch {
      // Already gone.
    }
  }

  // ------------------------------------------------------------------ helpers

  #inMatch(): boolean {
    return this.#phase === 'countdown' || this.#phase === 'playing' || this.#phase === 'interlude'
  }

  #connectionCount(): number {
    let count = 0
    for (const _connection of this.getConnections()) count += 1
    return count
  }

  /** Seats that still hold a slot. A retired seat is kept for its name only. */
  #activeSeatCount(): number {
    let count = 0
    for (const seat of this.#seats.values()) if (!seat.gone) count += 1
    return count
  }

  #nameFor(desired: string, exclude: PlayerId): string {
    const taken: string[] = []
    for (const seat of this.#seats.values()) {
      if (seat.id !== exclude) taken.push(seat.name)
    }
    const wanted = desired.length > 0 ? desired : fallbackName(this.#seats.size + 1)
    return uniqueName(wanted, taken, this.#seats.size + 1)
  }

  #currentSpecFor(playerId: PlayerId): LevelSpec | null {
    const match = this.#match
    if (!match) return null
    return levelSpecAt(match, playerLevelIndex(match, playerId))
  }

  // ------------------------------------------------------------- housekeeping

  /**
   * Arms the next wake, twice over.
   *
   * The in-memory timer is what actually fires: it is precise and free. The
   * durable alarm is the backstop for the instance being evicted or restarted
   * between now and then, which would otherwise leave a match frozen at a
   * deadline nobody is left to notice. Rescheduling the alarm costs a storage
   * write, so a move of less than a second is not worth making.
   */
  #arm(now: number): void {
    if (this.#closed) return
    const at = this.#nextWake(now)
    if (this.#wakeTimer !== null) clearTimeout(this.#wakeTimer)
    this.#wakeTimer = null
    if (at === null) return

    this.#wakeTimer = setTimeout(() => this.#tick(Date.now()), Math.max(0, at - now))
    if (this.#alarmAt === null || Math.abs(this.#alarmAt - at) > ALARM_SLACK_MS) {
      this.#alarmAt = at
      void this.ctx.storage.setAlarm(at).catch(() => {
        this.#alarmAt = null
      })
    }
  }

  #nextWake(now: number): number | null {
    const times: number[] = []
    const match = this.#match

    if (match) {
      if (this.#phase === 'countdown') times.push(match.levelStartedAt)
      if (this.#phase === 'playing' && this.#phaseEndsAt !== null) times.push(this.#phaseEndsAt)
      if (this.#phase === 'interlude' && this.#phaseEndsAt !== null) times.push(this.#phaseEndsAt)
    }
    for (const seat of this.#seats.values()) {
      if (!seat.gone && !seat.connected && seat.disconnectedAt !== null) {
        times.push(seat.disconnectedAt + RECONNECT_GRACE_MS)
      }
    }
    for (const since of this.#pending.values()) times.push(since + JOIN_GRACE_MS)
    if (this.#emptySince !== null) times.push(this.#emptySince + EMPTY_CLOSE_MS)

    if (times.length === 0) return null
    return Math.max(now, Math.min(...times))
  }

  /**
   * Tells the registry this code is still in use.
   *
   * Cheap and idempotent, and the only thing standing between a long match and
   * having its code recycled underneath it.
   *
   * A room with nobody in it deliberately says nothing. The heartbeat is what
   * promotes a one-minute reservation into a room holding its code for half an
   * hour, and an empty room has not earned that: a socket that connects and
   * never joins would otherwise be enough to park a code for thirty minutes at
   * a time. This room closes and releases its code a minute after its last
   * connection anyway, so silence costs a real room nothing.
   */
  async #touchRegistry(now: number, force: boolean): Promise<void> {
    if (this.#closed || this.#seats.size === 0) return
    if (!force && now - this.#registryTouchedAt < REGISTRY_HEARTBEAT_MS) return
    this.#registryTouchedAt = now
    try {
      const registry = await getServerByName(this.env.Registry, REGISTRY_NAME)
      await registry.keepAlive(this.#code)
    } catch (error) {
      console.error(`room ${this.#code}: registry heartbeat failed`, error)
    }
  }

  /**
   * Shuts the room down and gives its code back.
   *
   * Rooms are ephemeral by design: there is nothing here worth keeping once the
   * last player has gone, and leaving the record behind would slowly starve the
   * code space of five-character codes people can read aloud.
   */
  async #close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#stopPump()
    if (this.#wakeTimer !== null) clearTimeout(this.#wakeTimer)
    this.#wakeTimer = null
    if (this.#persistTimer !== null) clearTimeout(this.#persistTimer)
    this.#persistTimer = null
    try {
      const registry = await getServerByName(this.env.Registry, REGISTRY_NAME)
      await registry.release(this.#code)
    } catch (error) {
      console.error(`room ${this.#code}: registry release failed`, error)
    }
    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.deleteAll()
  }

  /**
   * Writes the snapshot, shortly.
   *
   * Transitions arrive in small bursts — a level resolving broadcasts a result,
   * enters the interlude and recomputes every standing in the same millisecond
   * — so the write is deferred just long enough to collapse a burst into one.
   * Progress never calls this; see ./snapshot.
   */
  #persistSoon(): void {
    if (this.#closed || this.#persistTimer !== null) return
    this.#persistTimer = setTimeout(() => {
      this.#persistTimer = null
      void this.#persist()
    }, 250)
  }

  async #persist(): Promise<void> {
    if (this.#closed) return
    const snapshot: RoomSnapshot = {
      v: SNAPSHOT_VERSION,
      phase: this.#phase,
      hostId: this.#hostId,
      settings: this.#settings,
      seats: [...this.#seats.values()].map((seat) => ({
        id: seat.id,
        name: seat.name,
        joinedAt: seat.joinedAt,
        token: this.#keyring.tokenFor(seat.id),
        disconnectedAt: seat.disconnectedAt,
      })),
      match: this.#match,
      levelStartedAt: Object.fromEntries(this.#levelStartedAt),
      phaseStartedAt: this.#phaseStartedAt,
      phaseEndsAt: this.#phaseEndsAt,
      podium: this.#podium,
      levels: this.#vault.snapshot(),
    }
    try {
      await this.ctx.storage.put(SNAPSHOT_KEY, snapshot)
    } catch (error) {
      console.error(`room ${this.#code}: snapshot write failed`, error)
    }
  }
}
