/**
 * The multiplayer wire format.
 *
 * This module is the single source of truth for everything that crosses the
 * WebSocket. It is pure data plus a handful of guards: no network, no storage,
 * no timers, no imports from React or the DOM, and nothing that would pull the
 * game core into a single-player bundle. The party server and the client both
 * import it, which is what stops the two ends drifting apart.
 *
 * Two decisions shape the whole format:
 *
 * 1. Levels are broadcast as level NUMBERS, never as board data. Level N is a
 *    pure function of N and the generator version, so every client given the
 *    same number generates a byte-identical puzzle. A whole match schedule is
 *    therefore a handful of integers, and no puzzle is ever stored server-side.
 *
 * 2. The server owns the clock. Every timestamp on the wire is server epoch
 *    milliseconds, and every elapsed time in a result is measured by the server
 *    between the level start it broadcast and the claim it accepted. Clients
 *    send their own clock only as a diagnostic; it never decides a race.
 */

/** Bumped whenever a message shape changes incompatibly. Checked on join. */
export const PROTOCOL_VERSION = 1

/** Hard cap on room size. The host starts the match; the room never auto-starts. */
export const MAX_PLAYERS = 8

/** Below this a match is not a race. Knockout needs more; see `canStartMatch`. */
export const MIN_PLAYERS = 2

/** Names are shown inside a progress bar row, so they have to stay short. */
export const MAX_NAME_LENGTH = 16

/**
 * How often the server coalesces and broadcasts progress.
 *
 * Progress is the highest-frequency message in the protocol by a wide margin,
 * and its only job is to keep a bar moving convincingly. Four frames a second
 * reads as live and costs at most 8 tiny tuples per tick in a full room.
 */
export const PROGRESS_TICK_INTERVAL_MS = 250

/**
 * A validated five-character room code.
 *
 * Branded rather than a bare string so a code can only be produced by
 * `parseRoomCode` or `generateRoomCode` in `./roomCode`. Every code that
 * reaches the server has therefore already been normalised and checked, which
 * is what keeps "the code the host reads aloud" and "the room the guest joins"
 * the same string.
 */
export type RoomCode = string & { readonly __brand: 'RoomCode' }

/**
 * Identifies one player for the lifetime of a room.
 *
 * The party server mints this from the connection, so it is opaque to the
 * client and stable across a reconnect within the same room. A plain alias
 * rather than a brand: mixing a player id up with another string is a bug the
 * type system cannot usefully prevent, and the brand would cost every call
 * site a cast.
 */
export type PlayerId = string

/** The party room name. Always equal to the room code. */
export type RoomId = string

export type GameMode = 'blaze' | 'steady' | 'knockout'

/**
 * How hard the match's levels are.
 *
 * Multiplayer draws from its own band of level numbers per difficulty — see
 * `DIFFICULTY_BANDS` in ./match — chosen so that generating a board costs
 * milliseconds rather than the few hundred a top-tier 15x15 costs. A race
 * cannot afford a player staring at a spinner while an opponent solves.
 */
export type MatchDifficulty = 'easy' | 'standard' | 'hard'

/**
 * The lengths a host may choose for blaze and steady.
 *
 * A closed union rather than a number: the UI is a segmented control, and an
 * out-of-range length is then unrepresentable rather than merely discouraged.
 */
export const LEVEL_COUNT_OPTIONS = [3, 5, 7, 10] as const

export type LevelCount = (typeof LEVEL_COUNT_OPTIONS)[number]

export const DEFAULT_LEVEL_COUNT: LevelCount = 5

export const DEFAULT_DIFFICULTY: MatchDifficulty = 'standard'

/**
 * What the host configures in the lobby.
 *
 * Discriminated by mode so that knockout has no `levelCount` field at all.
 * Knockout's length is a function of how many players are in the room — one
 * elimination per level until two remain — so making it settable would create
 * a value that could disagree with the rules. Unrepresentable beats documented.
 */
export type RoomSettings =
  | { mode: 'blaze'; levelCount: LevelCount; difficulty: MatchDifficulty }
  | { mode: 'steady'; levelCount: LevelCount; difficulty: MatchDifficulty }
  | { mode: 'knockout'; difficulty: MatchDifficulty }

/** The lobby's opening state: a five-level steady match at standard difficulty. */
export const DEFAULT_SETTINGS: RoomSettings = {
  mode: 'steady',
  levelCount: DEFAULT_LEVEL_COUNT,
  difficulty: DEFAULT_DIFFICULTY,
}

/** Settings for a mode, keeping the difficulty the host already picked. */
export const defaultSettingsFor = (mode: GameMode, difficulty: MatchDifficulty): RoomSettings =>
  mode === 'knockout' ? { mode, difficulty } : { mode, levelCount: DEFAULT_LEVEL_COUNT, difficulty }

/**
 * A room's lifecycle.
 *
 * `interlude` is the pause between levels in steady and knockout, during which
 * the level's winner (or the eliminated player) is on screen. Blaze never
 * enters it: its whole point is that there is no pause.
 */
export type RoomPhase = 'lobby' | 'countdown' | 'playing' | 'interlude' | 'finished'

/**
 * One level of a match as published to every client.
 *
 * `size` travels with the level number even though it is derivable, because
 * clients need it to scale another player's progress bar before they have
 * generated that board themselves. It is exact: every tier multiplayer draws
 * from declares exactly one board size, and a unit test enforces that.
 */
export type LevelSpec = {
  /** The level number both ends feed to the deterministic generator. */
  levelNumber: number
  /** Board edge length N. The board holds N cats. */
  size: number
  /** Milliseconds from level start before an unsolved board is recorded as a timeout. */
  timeLimitMs: number
}

/**
 * A live progress sample: `[playerId, levelIndex, catsPlaced]`.
 *
 * Progress is the number of cats correctly placed on the player's current
 * board, out of that level's `size`. Marked cells deliberately do not count.
 * Marking is a bookkeeping style — some players cross out every cell, some
 * never mark at all — so counting marks would measure temperament rather than
 * progress, and would let a bar sit at nine tenths with no cats down. Cats can
 * be removed, so the number can fall; a bar that retreats is telling the truth.
 *
 * `levelIndex` is carried because blaze players advance independently and are
 * routinely on different levels at the same moment.
 */
export type ProgressTick = readonly [PlayerId, number, number]

/** Why a player stopped playing a level. */
export type FinishStatus = 'solved' | 'timeout' | 'abandoned'

/**
 * One player's outcome on one level, as recorded by the server.
 *
 * `seq` is a monotonic counter over everything the server accepts during a
 * match. It is the tiebreak when two players' elapsed times are equal to the
 * millisecond: arrival order at the server is the only total order that
 * actually exists, so it is the one the rules use.
 */
export type LevelFinish = {
  playerId: PlayerId
  /** 0-based index into the match schedule. */
  levelIndex: number
  status: FinishStatus
  /** Server-measured milliseconds from level start; null unless solved. */
  elapsedMs: number | null
  /** Cats placed when the level ended. Equals the board size when solved. */
  progress: number
  /** Server sequence number, monotonic across the match. */
  seq: number
}

/** The outcome of one level, broadcast once the level closes. */
export type LevelResult = {
  /** 0-based index into the match schedule. */
  levelIndex: number
  levelNumber: number
  /** Best to worst, covering everyone who was still in the match. */
  ranking: PlayerId[]
  /** Null when nobody solved the level inside its time limit. */
  winnerId: PlayerId | null
  /** Knockout only: the player the level knocked out. */
  eliminatedId: PlayerId | null
  finishes: LevelFinish[]
}

/** How a player left the running order, for the podium. */
export type PodiumStatus = 'champion' | 'finished' | 'knocked-out' | 'left'

/** One row of the final standings. `place` is 1-based and never shared. */
export type PodiumEntry = {
  playerId: PlayerId
  place: number
  status: PodiumStatus
  /** Levels won. Only steady ranks by it; blaze has no level winners, so it is 0. */
  points: number
  levelsSolved: number
  /** Blaze: total elapsed across the schedule, unsolved levels charged the cap. */
  totalTimeMs: number
  /** 1-based level ordinal at which the player was knocked out or left. */
  eliminatedAtLevel: number | null
}

/**
 * One player as the room sees them.
 *
 * The standing fields are derived by the server from the match's recorded
 * finishes rather than accumulated in place, so a late-arriving or replayed
 * message can never leave a player's score out of step with the results.
 */
export type Player = {
  id: PlayerId
  name: string
  /** Server epoch ms. Also the tiebreak for host succession. */
  joinedAt: number
  connected: boolean
  /** 0-based index of the level this player is on. Blaze players differ. */
  levelIndex: number
  levelsSolved: number
  points: number
  totalTimeMs: number
  /** Null while the player is still in the match. */
  eliminatedAtLevel: number | null
  /** Latest progress sample: cats placed on their current board. */
  progress: number
}

/**
 * Everything the server owns about a room.
 *
 * Broadcast whole on any change that is not a progress tick. A full room is
 * eight players and at most ten results, so a snapshot is small enough that
 * deltas would buy latency at the cost of a class of desync bugs.
 */
export type RoomState = {
  code: RoomCode
  phase: RoomPhase
  /** Null only in the instant between the last player leaving and the room closing. */
  hostId: PlayerId | null
  settings: RoomSettings
  players: Player[]
  /** How many levels this match plays; for knockout, derived from the player count. */
  levelCount: number
  /** Published when the match starts; null in the lobby. */
  schedule: LevelSpec[] | null
  /** 0-based index of the level in progress, or -1 outside a match. */
  levelIndex: number
  /** Server epoch ms at which the current phase's clock started. */
  phaseStartedAt: number
  /** Server epoch ms at which the current phase ends, or null if open-ended. */
  phaseEndsAt: number | null
  results: LevelResult[]
  /** Non-null exactly when the phase is `finished`. */
  podium: PodiumEntry[] | null
  /** The server's clock at the moment the snapshot was built, for skew estimation. */
  serverTime: number
}

/**
 * A claimed solution.
 *
 * `cols[row]` is the column of that row's cat, which is precisely the shape of
 * `Level.solution`. A puzzle has exactly one solution, so the server verifies a
 * claim by generating the level and comparing arrays — N small integers on the
 * wire instead of a board, and no way to win by asserting.
 */
export type SolutionClaim = {
  levelIndex: number
  cols: number[]
}

export type RoomErrorCode =
  | 'version-mismatch'
  | 'room-full'
  | 'match-in-progress'
  | 'not-host'
  | 'not-enough-players'
  | 'bad-name'
  | 'bad-message'
  | 'invalid-solution'
  | 'not-in-match'
  | 'rate-limited'
  | 'server-error'

export type ClientMessage =
  /** First message on a connection. `v` lets the server reject an outdated client. */
  | { t: 'join'; v: number; name: string }
  | { t: 'name'; name: string }
  /** Host only; rejected with `not-host` from anyone else. */
  | { t: 'settings'; settings: RoomSettings }
  /** Host only. */
  | { t: 'start' }
  /** Cats currently placed. Sent only when the number changes. */
  | { t: 'progress'; cats: number }
  | { t: 'solved'; claim: SolutionClaim; clientMs: number }
  /** Interlude only: lets a room skip the remaining pause once everyone is ready. */
  | { t: 'ready' }
  /** A deliberate exit, as opposed to a dropped connection. */
  | { t: 'leave' }
  | { t: 'ping'; at: number }

export type ServerMessage =
  /** Always the first message on a connection. */
  | { t: 'welcome'; v: number; you: PlayerId; state: RoomState }
  | { t: 'state'; state: RoomState }
  /** The match is about to begin; `startsAt` is server epoch ms. */
  | { t: 'countdown'; startsAt: number }
  /** The whole schedule, published once, as level numbers. */
  | { t: 'match'; schedule: LevelSpec[]; levelCount: number; startsAt: number }
  /** Steady and knockout only: a synchronised level start. */
  | { t: 'level'; levelIndex: number; startsAt: number; deadlineAt: number }
  /** A solution claim was verified. In blaze this is the cue to advance. */
  | { t: 'accepted'; levelIndex: number; elapsedMs: number }
  | { t: 'progress'; at: number; ticks: ProgressTick[] }
  | { t: 'result'; result: LevelResult }
  | { t: 'finished'; podium: PodiumEntry[] }
  | { t: 'error'; code: RoomErrorCode; message: string }
  | { t: 'pong'; at: number; serverTime: number }

/** Serialises either direction. JSON: the payloads are tiny and debuggable. */
export const encodeMessage = (message: ClientMessage | ServerMessage): string =>
  JSON.stringify(message)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value)

const isCount = (value: unknown): value is number => isInt(value) && value >= 0

export const isGameMode = (value: unknown): value is GameMode =>
  value === 'blaze' || value === 'steady' || value === 'knockout'

export const isMatchDifficulty = (value: unknown): value is MatchDifficulty =>
  value === 'easy' || value === 'standard' || value === 'hard'

export const isLevelCount = (value: unknown): value is LevelCount =>
  (LEVEL_COUNT_OPTIONS as readonly number[]).includes(value as number)

/**
 * Validates settings arriving from a client.
 *
 * Returns a fresh object rather than the input, so a host cannot smuggle extra
 * fields into the state the server broadcasts to everyone else.
 */
export const decodeSettings = (value: unknown): RoomSettings | null => {
  if (!isRecord(value)) return null
  const { mode, difficulty } = value
  if (!isGameMode(mode) || !isMatchDifficulty(difficulty)) return null
  if (mode === 'knockout') return { mode, difficulty }
  const { levelCount } = value
  if (!isLevelCount(levelCount)) return null
  return { mode, levelCount, difficulty }
}

/**
 * Trims a name to something that fits a progress bar row.
 *
 * Control characters are stripped rather than escaped because they have no
 * legitimate use in a display name and are the cheapest way to break a layout.
 * Returns an empty string for input with nothing left in it; choosing a
 * fallback is the caller's business.
 */
export const sanitizeName = (raw: string): string => {
  let out = ''
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) continue
    out += ch
  }
  // Trimmed again after the slice: cutting mid-word can leave a trailing space
  // that would render as a name the player never typed.
  return out.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH).trim()
}

const decodeClaim = (value: unknown): SolutionClaim | null => {
  if (!isRecord(value)) return null
  const { levelIndex, cols } = value
  if (!isCount(levelIndex) || !Array.isArray(cols) || cols.length === 0) return null
  if (cols.length > 32) return null
  const parsed: number[] = []
  for (const col of cols) {
    if (!isCount(col) || col >= cols.length) return null
    parsed.push(col)
  }
  return { levelIndex, cols: parsed }
}

/**
 * Parses an untrusted client frame.
 *
 * This is the server's security boundary, so every field is checked and a
 * fresh object is returned; nothing from the socket is passed through by
 * reference. Accepts either a JSON string or an already-parsed value, and
 * returns null for anything it does not fully recognise — the caller answers
 * with a `bad-message` error rather than guessing.
 */
export const parseClientMessage = (raw: unknown): ClientMessage | null => {
  let value = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  if (!isRecord(value)) return null
  switch (value.t) {
    case 'join': {
      const { v, name } = value
      if (!isInt(v) || typeof name !== 'string') return null
      return { t: 'join', v, name: sanitizeName(name) }
    }
    case 'name': {
      const { name } = value
      if (typeof name !== 'string') return null
      return { t: 'name', name: sanitizeName(name) }
    }
    case 'settings': {
      const settings = decodeSettings(value.settings)
      return settings ? { t: 'settings', settings } : null
    }
    case 'start':
      return { t: 'start' }
    case 'progress': {
      const { cats } = value
      if (!isCount(cats) || cats > 32) return null
      return { t: 'progress', cats }
    }
    case 'solved': {
      const claim = decodeClaim(value.claim)
      const { clientMs } = value
      if (!claim || !isCount(clientMs)) return null
      return { t: 'solved', claim, clientMs }
    }
    case 'ready':
      return { t: 'ready' }
    case 'leave':
      return { t: 'leave' }
    case 'ping': {
      const { at } = value
      if (!isCount(at)) return null
      return { t: 'ping', at }
    }
    default:
      return null
  }
}

/**
 * Parses a frame from the server.
 *
 * Only the discriminant is checked. The client already trusts the server with
 * the entire match, so deep-validating its own room state would buy nothing
 * and would cost a validator for every nested type in a lazily-loaded chunk
 * that has a byte budget.
 */
export const parseServerMessage = (raw: unknown): ServerMessage | null => {
  let value = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  if (!isRecord(value) || typeof value.t !== 'string') return null
  switch (value.t) {
    case 'welcome':
    case 'state':
    case 'countdown':
    case 'match':
    case 'level':
    case 'accepted':
    case 'progress':
    case 'result':
    case 'finished':
    case 'error':
    case 'pong':
      return value as unknown as ServerMessage
    default:
      return null
  }
}
