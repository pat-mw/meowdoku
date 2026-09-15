import { Rng, hashString } from '../board/generator/prng'
import { tierFor } from '../board/generator/tiers'
import { MAX_PLAYERS, MIN_PLAYERS } from './protocol'
import type {
  FinishStatus,
  LevelFinish,
  LevelResult,
  LevelSpec,
  MatchDifficulty,
  Player,
  PlayerId,
  PodiumEntry,
  PodiumStatus,
  RoomErrorCode,
  RoomSettings,
} from './protocol'

/**
 * The multiplayer rulebook.
 *
 * Every mode, every ranking and every state transition lives here as a pure
 * function: no sockets, no storage, no timers, no `Date.now`, no randomness
 * beyond the seeded PRNG the level generator already uses. The party server
 * and the client both import this module, which is the mechanism that stops
 * the two disagreeing about who won — the client is not guessing at the
 * server's answer, it is computing the same one.
 *
 * Time enters only as arguments. Anything that needs "now" takes it, so a
 * whole match can be replayed from a scripted sequence of finishes in a test.
 *
 * The module knows about the board (it picks level numbers and reads the tier
 * table); the board knows nothing about multiplayer.
 */

/** Seconds of "get ready" between the host pressing start and the first level. */
export const COUNTDOWN_MS = 3000

/**
 * The pause between levels in steady and knockout.
 *
 * Long enough to read who won or who went out, short enough that a player who
 * solved fast does not feel punished for it. Blaze never pauses.
 */
export const INTERLUDE_MS = 6000

/**
 * How long a dropped player keeps their seat.
 *
 * A phone that locks, a tunnel, a Wi-Fi handover: all of these last seconds,
 * and taking someone out of a match for one would be worse than making the
 * room wait. While disconnected a player is still in the match and their level
 * clock still runs, so the grace period costs the room nothing but a name
 * greyed out in the progress bar.
 */
export const RECONNECT_GRACE_MS = 30_000

/** Knockout needs a crowd to thin: two players is just a head-to-head. */
export const MIN_KNOCKOUT_PLAYERS = 3

/**
 * The level-number band each difficulty draws from.
 *
 * Multiplayer picks its own level numbers and never reads or writes the
 * player's single-player progress. The bands stop at level 100 for two
 * reasons. Generation cost: tiers 1 to 5 are 5x5 through 9x9 and generate in
 * milliseconds, whereas the 15x15 top tier takes a few hundred and would have
 * players watching a spinner while an opponent solves. And board size: every
 * tier in these bands declares exactly one size, so `boardSizeFor` is exact
 * without generating anything, which is what lets a client scale an opponent's
 * progress bar for a board it has not built. A unit test enforces the
 * single-size property against the tier table.
 *
 *   easy     tiers 1-2   5x5 and 6x6
 *   standard tiers 3-4   7x7 and 8x8
 *   hard     tier  5     9x9
 */
export const DIFFICULTY_BANDS: Record<MatchDifficulty, { from: number; to: number }> = {
  easy: { from: 1, to: 25 },
  standard: { from: 26, to: 70 },
  hard: { from: 71, to: 100 },
}

/**
 * How long a level stays open before an unsolved board becomes a timeout.
 *
 * This is a backstop, not a target: in steady and knockout the room moves on
 * as soon as everyone has finished, so the cap only bites when somebody is
 * genuinely stuck. It has to exist, because without it one stuck player holds
 * seven others hostage.
 */
export const LEVEL_TIME_LIMIT_MS: Record<MatchDifficulty, number> = {
  easy: 90_000,
  standard: 150_000,
  hard: 240_000,
}

/**
 * Board edge length for a multiplayer level, read from the tier table.
 *
 * Exact for every level in `DIFFICULTY_BANDS`, whose tiers all declare a single
 * size. Outside those bands a tier may offer a choice the generator's PRNG
 * makes, and this returns the first of them.
 */
export const boardSizeFor = (levelNumber: number): number => tierFor(levelNumber).sizes[0] ?? 5

/**
 * The levels a match plays, in order.
 *
 * Derived from the room seed so that the schedule is reproducible: the server
 * publishes it, but any client can check it, and a reconnecting player gets the
 * same sequence without asking. Levels are drawn without replacement, so no
 * match ever serves the same puzzle twice.
 */
export const matchSchedule = (
  seed: string,
  difficulty: MatchDifficulty,
  count: number,
): LevelSpec[] => {
  const band = DIFFICULTY_BANDS[difficulty]
  const pool: number[] = []
  for (let n = band.from; n <= band.to; n++) pool.push(n)
  new Rng(hashString(`meowdoku:match:${seed}:${difficulty}`)).shuffle(pool)

  const wanted = Math.max(0, Math.floor(count))
  const specs: LevelSpec[] = []
  for (let i = 0; i < wanted; i++) {
    // The modulo is unreachable for any supported length — the smallest band
    // holds 25 levels and the longest match is 10 — and exists so a future
    // band or level count cannot produce a short schedule.
    const levelNumber = pool[i % pool.length] as number
    specs.push({
      levelNumber,
      size: boardSizeFor(levelNumber),
      timeLimitMs: LEVEL_TIME_LIMIT_MS[difficulty],
    })
  }
  return specs
}

/**
 * Knockout length: one elimination per level until two remain, then a final.
 *
 * Eight players play seven levels — six eliminations down to a head-to-head,
 * then the head-to-head itself. The schedule is sized from the player count at
 * the moment the host starts; if players leave mid-match the match simply ends
 * sooner, because knockout's end condition is "one player left standing", not
 * "the schedule ran out".
 */
export const knockoutLevelCount = (playerCount: number): number =>
  Math.max(1, Math.floor(playerCount) - 1)

/** How many levels this match plays. The only place knockout's length is decided. */
export const levelCountFor = (settings: RoomSettings, playerCount: number): number =>
  settings.mode === 'knockout' ? knockoutLevelCount(playerCount) : settings.levelCount

/** Whether the mode runs everyone through the same level at the same time. */
export const isSyncedMode = (settings: RoomSettings): boolean => settings.mode !== 'blaze'

export type MatchPhase = 'countdown' | 'playing' | 'interlude' | 'finished'

/** Why a player stopped competing. */
export type ExitKind = 'knockout' | 'left'

export type Participant = {
  id: PlayerId
  connected: boolean
  /** 1-based level ordinal at which they stopped competing; null while active. */
  exitLevel: number | null
  exit: ExitKind | null
}

/**
 * A match in progress.
 *
 * Deliberately close to append-only: finishes accumulate and are never edited,
 * and every score is derived from them by `standingFor`. A replayed or
 * late-arriving message can therefore not leave a running total out of step
 * with the results it was computed from, which is the failure mode that makes
 * "the scores disagree" bugs so hard to reproduce.
 */
export type MatchState = {
  settings: RoomSettings
  seed: string
  schedule: LevelSpec[]
  levelCount: number
  /** Server epoch ms when the host pressed start. */
  startedAt: number
  phase: MatchPhase
  /**
   * 0-based index of the level in progress. In blaze, where players advance
   * independently, this tracks the furthest level anyone has reached — the
   * front of the race — and `playerLevelIndex` is authoritative per player.
   */
  levelIndex: number
  /** Server epoch ms when the current level began. */
  levelStartedAt: number
  participants: Participant[]
  /** Every finish of the whole match, in the order the server accepted them. */
  finishes: LevelFinish[]
  results: LevelResult[]
  /** Next sequence number to stamp on a finish. Monotonic; the last-resort tiebreak. */
  seq: number
}

export type CreateMatchInput = {
  settings: RoomSettings
  /** Any stable string; the room code plus the start time is the obvious choice. */
  seed: string
  players: readonly PlayerId[]
  /** Server epoch ms. */
  startedAt: number
}

export const createMatch = (input: CreateMatchInput): MatchState => {
  const levelCount = levelCountFor(input.settings, input.players.length)
  return {
    settings: input.settings,
    seed: input.seed,
    schedule: matchSchedule(input.seed, input.settings.difficulty, levelCount),
    levelCount,
    startedAt: input.startedAt,
    phase: 'countdown',
    levelIndex: 0,
    levelStartedAt: input.startedAt + COUNTDOWN_MS,
    participants: input.players.map((id) => ({
      id,
      connected: true,
      exitLevel: null,
      exit: null,
    })),
    finishes: [],
    results: [],
    seq: 1,
  }
}

export const participantOf = (state: MatchState, playerId: PlayerId): Participant | null =>
  state.participants.find((p) => p.id === playerId) ?? null

/** Players still in the running: neither knocked out nor gone. */
export const activeParticipants = (state: MatchState): Participant[] =>
  state.participants.filter((p) => p.exit === null)

export const isActive = (state: MatchState, playerId: PlayerId): boolean =>
  participantOf(state, playerId)?.exit === null

const finishesOf = (state: MatchState, playerId: PlayerId): LevelFinish[] =>
  state.finishes.filter((f) => f.playerId === playerId)

export const finishFor = (
  state: MatchState,
  levelIndex: number,
  playerId: PlayerId,
): LevelFinish | null =>
  state.finishes.find((f) => f.levelIndex === levelIndex && f.playerId === playerId) ?? null

/**
 * Which level a player is on.
 *
 * In steady and knockout everyone is on the room's level. In blaze a player is
 * on the level after the last one they finished, which is the whole point of
 * the mode: nobody waits.
 */
export const playerLevelIndex = (state: MatchState, playerId: PlayerId): number =>
  state.settings.mode === 'blaze'
    ? Math.min(state.levelCount, finishesOf(state, playerId).length)
    : state.levelIndex

/** Blaze: true once a player has played through the whole schedule. */
export const hasFinishedSchedule = (state: MatchState, playerId: PlayerId): boolean =>
  playerLevelIndex(state, playerId) >= state.levelCount

export const levelSpecAt = (state: MatchState, levelIndex: number): LevelSpec | null =>
  state.schedule[levelIndex] ?? null

/** The time limit of a level, used to charge an unsolved level in blaze totals. */
export const levelTimeLimitMs = (state: MatchState, levelIndex: number): number =>
  levelSpecAt(state, levelIndex)?.timeLimitMs ?? LEVEL_TIME_LIMIT_MS[state.settings.difficulty]

/** Server epoch ms at which the current synchronised level times out. */
export const levelDeadlineAt = (state: MatchState): number =>
  state.levelStartedAt + levelTimeLimitMs(state, state.levelIndex)

/** Blaze's backstop: nobody can hold a room open past the summed level limits. */
export const matchDeadlineAt = (state: MatchState): number =>
  state.levelStartedAt + state.schedule.reduce((total, spec) => total + spec.timeLimitMs, 0)

/** What the server records when a player stops playing a level. */
export type FinishInput = {
  playerId: PlayerId
  levelIndex: number
  status: FinishStatus
  /** Server-measured milliseconds from level start; null unless solved. */
  elapsedMs: number | null
  /** Cats placed at that moment. The board size when solved. */
  progress: number
}

/**
 * Whether a claimed finish is one the match will record.
 *
 * Rejects replays, finishes from players who are out, and claims for a level
 * the player is not actually on — a client that reconnects and replays its
 * last message must not be able to bank a second time for the same level.
 */
export const canAcceptFinish = (
  state: MatchState,
  playerId: PlayerId,
  levelIndex: number,
): boolean => {
  if (state.phase !== 'playing') return false
  if (!isActive(state, playerId)) return false
  if (levelIndex < 0 || levelIndex >= state.levelCount) return false
  if (levelIndex !== playerLevelIndex(state, playerId)) return false
  return finishFor(state, levelIndex, playerId) === null
}

const appendFinish = (state: MatchState, input: FinishInput): MatchState => {
  const finish: LevelFinish = {
    playerId: input.playerId,
    levelIndex: input.levelIndex,
    status: input.status,
    elapsedMs: input.elapsedMs,
    progress: input.progress,
    seq: state.seq,
  }
  const next: MatchState = {
    ...state,
    finishes: [...state.finishes, finish],
    seq: state.seq + 1,
  }
  if (state.settings.mode === 'blaze') {
    // The room's level index follows the leader, so spectators and the lobby
    // header have something meaningful to show while players are spread out.
    next.levelIndex = Math.min(
      state.levelCount - 1,
      Math.max(state.levelIndex, playerLevelIndex(next, input.playerId)),
    )
  }
  return next
}

/**
 * Records a finish, or returns the state untouched if it is not acceptable.
 *
 * Silently ignoring a stale claim is deliberate: by the time a duplicate
 * arrives the level is usually over, and there is nothing useful to tell the
 * player. Call `canAcceptFinish` first when an error message is wanted.
 */
export const applyFinish = (state: MatchState, input: FinishInput): MatchState =>
  canAcceptFinish(state, input.playerId, input.levelIndex) ? appendFinish(state, input) : state

/** A dropped connection. The player keeps their seat and their clock keeps running. */
export const applyDisconnect = (state: MatchState, playerId: PlayerId): MatchState => ({
  ...state,
  participants: state.participants.map((p) =>
    p.id === playerId && p.exit === null ? { ...p, connected: false } : p,
  ),
})

export const applyReconnect = (state: MatchState, playerId: PlayerId): MatchState => ({
  ...state,
  participants: state.participants.map((p) =>
    p.id === playerId && p.exit === null ? { ...p, connected: true } : p,
  ),
})

/**
 * Takes a player out of the match for good.
 *
 * Called for a deliberate exit and when the reconnect grace period expires.
 * Leaving forfeits the level in progress even if a solve for it was already
 * recorded: an absent player must not be able to win a level, take a point, or
 * spare somebody else from a knockout.
 */
export const applyLeave = (state: MatchState, playerId: PlayerId): MatchState => ({
  ...state,
  participants: state.participants.map((p) =>
    p.id === playerId && p.exit === null
      ? {
          ...p,
          connected: false,
          exit: 'left',
          exitLevel: Math.min(state.levelCount, playerLevelIndex(state, playerId) + 1),
        }
      : p,
  ),
})

const STATUS_ORDER: Record<FinishStatus, number> = { solved: 0, timeout: 1, abandoned: 2 }

/**
 * Orders two outcomes of the same level, best first.
 *
 * Solving beats running out of time, which beats walking away. Among solvers
 * the faster time wins, and when two are equal to the millisecond the finish
 * the server accepted first wins: arrival order is the only total order that
 * exists, and picking it is fairer than a coin toss because it is at least the
 * order the room saw.
 *
 * Among players who did not solve, more cats placed ranks higher — which is
 * what decides a level nobody solved, and is the same number the progress bar
 * was showing all along. Equal progress falls back to sequence order, which is
 * deterministic but carries no meaning; by then the two players really are
 * indistinguishable.
 */
export const compareFinishes = (a: LevelFinish, b: LevelFinish): number => {
  const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
  if (byStatus !== 0) return byStatus
  if (a.status === 'solved' && b.status === 'solved') {
    const ea = a.elapsedMs ?? Number.POSITIVE_INFINITY
    const eb = b.elapsedMs ?? Number.POSITIVE_INFINITY
    if (ea !== eb) return ea - eb
    return a.seq - b.seq
  }
  if (a.progress !== b.progress) return b.progress - a.progress
  return a.seq - b.seq
}

/** Best to worst. Does not mutate the input. */
export const rankFinishes = (finishes: readonly LevelFinish[]): LevelFinish[] =>
  [...finishes].sort(compareFinishes)

export type LevelEndReason = 'all-finished' | 'deadline' | 'walkover'

/**
 * Whether the current synchronised level is over, and why.
 *
 * Null while it is still running. Blaze always answers null: it has no shared
 * level to end, only a match to finish.
 */
export const levelEndReason = (state: MatchState, now: number): LevelEndReason | null => {
  if (state.phase !== 'playing' || state.settings.mode === 'blaze') return null
  const active = activeParticipants(state)
  if (active.length === 0) return 'walkover'
  if (active.every((p) => finishFor(state, state.levelIndex, p.id) !== null)) return 'all-finished'
  if (now >= levelDeadlineAt(state)) return 'deadline'
  return null
}

export type MatchEndReason = 'complete' | 'walkover' | 'empty' | 'deadline'

/**
 * Whether the match is over, and why.
 *
 *   complete  the schedule ran out, or knockout is down to its survivor
 *   walkover  everyone else left; whoever is still here wins by default
 *   empty     nobody is left at all, so there is no champion
 *   deadline  blaze's backstop, in case a player never finishes or reports
 *
 * Knockout's end condition is the survivor rather than the schedule, which is
 * what makes a room that loses players mid-match behave sensibly: if a
 * five-player knockout drops to two, the next level is the final, regardless of
 * how many levels were scheduled when the host pressed start.
 */
export const matchEndReason = (state: MatchState, now: number): MatchEndReason | null => {
  if (state.phase === 'finished') return null
  const active = activeParticipants(state)
  if (active.length === 0) return 'empty'

  if (state.settings.mode === 'knockout') {
    if (active.length > 1) return null
    const survivor = active[0] as Participant
    // A knockout is properly won when the survivor came through a level that
    // eliminated somebody. If the room merely emptied around them, it is a
    // walkover, and the end-of-match screen should say so.
    const last = state.results[state.results.length - 1]
    const earned =
      last !== undefined && last.eliminatedId !== null && last.ranking.includes(survivor.id)
    return earned ? 'complete' : 'walkover'
  }

  if (active.length === 1 && state.participants.length > 1) return 'walkover'

  if (state.settings.mode === 'blaze') {
    if (active.every((p) => hasFinishedSchedule(state, p.id))) return 'complete'
    return now >= matchDeadlineAt(state) ? 'deadline' : null
  }

  return state.levelIndex >= state.levelCount ? 'complete' : null
}

/** Ends the match. Idempotent. */
export const finishMatch = (state: MatchState): MatchState =>
  state.phase === 'finished' ? state : { ...state, phase: 'finished' }

/**
 * Closes the level in progress and works out what it did.
 *
 * Players who never claimed a finish are given one here: `timeout` if they are
 * still connected and simply did not solve it, `abandoned` if their connection
 * is gone. The caller passes the last progress sample it has for them, so a
 * level nobody solved is still ranked by how far each player got.
 *
 * Returns the state unchanged with a null result for blaze, which has no
 * shared level to close.
 */
export const resolveLevel = (
  state: MatchState,
  now: number,
  progress: Readonly<Record<PlayerId, number>> = {},
): { state: MatchState; result: LevelResult | null } => {
  if (state.phase !== 'playing' || state.settings.mode === 'blaze') return { state, result: null }
  const spec = levelSpecAt(state, state.levelIndex)
  if (!spec) return { state: finishMatch(state), result: null }

  const levelIndex = state.levelIndex
  let next = state
  for (const player of activeParticipants(state)) {
    if (finishFor(next, levelIndex, player.id) !== null) continue
    next = appendFinish(next, {
      playerId: player.id,
      levelIndex,
      status: player.connected ? 'timeout' : 'abandoned',
      elapsedMs: null,
      progress: progress[player.id] ?? 0,
    })
  }

  // Only players still in the match are ranked: a solve banked by someone who
  // then left the room does not win them the level.
  const finishes = rankFinishes(
    next.finishes.filter((f) => f.levelIndex === levelIndex && isActive(next, f.playerId)),
  )
  const winner = finishes.find((f) => f.status === 'solved') ?? null

  let eliminatedId: PlayerId | null = null
  if (state.settings.mode === 'knockout' && finishes.length >= 2) {
    eliminatedId = (finishes[finishes.length - 1] as LevelFinish).playerId
    next = {
      ...next,
      participants: next.participants.map((p) =>
        p.id === eliminatedId
          ? { ...p, exit: 'knockout', exitLevel: levelIndex + 1, connected: p.connected }
          : p,
      ),
    }
  }

  const result: LevelResult = {
    levelIndex,
    levelNumber: spec.levelNumber,
    ranking: finishes.map((f) => f.playerId),
    winnerId: winner ? winner.playerId : null,
    eliminatedId,
    finishes,
  }

  next = {
    ...next,
    results: [...next.results, result],
    levelIndex: levelIndex + 1,
    phase: 'interlude',
  }
  if (matchEndReason(next, now) !== null) next = finishMatch(next)
  return { state: next, result }
}

/**
 * Starts the next level, or ends the match if there is not one.
 *
 * Called at the end of the countdown and at the end of each interlude. In
 * blaze it is called exactly once: every player then runs their own stream
 * from `playerLevelIndex`, and `levelStartedAt` stays put as the match clock.
 */
export const beginLevel = (state: MatchState, now: number): MatchState => {
  if (state.phase === 'finished') return state
  if (matchEndReason(state, now) !== null) return finishMatch(state)
  if (state.levelIndex >= state.levelCount) return finishMatch(state)
  return { ...state, phase: 'playing', levelStartedAt: now }
}

/** A player's running totals, derived from the recorded finishes. */
export type Standing = {
  playerId: PlayerId
  /** Levels won. Only steady ranks by this. */
  points: number
  levelsSolved: number
  /** Total elapsed across played levels, an unsolved level charged its time limit. */
  totalTimeMs: number
  /** 1-based level ordinal at which the player went out; null while still in. */
  eliminatedAtLevel: number | null
}

export const standingFor = (state: MatchState, playerId: PlayerId): Standing => {
  const mine = finishesOf(state, playerId)
  let levelsSolved = 0
  let totalTimeMs = 0
  for (const finish of mine) {
    if (finish.status === 'solved' && finish.elapsedMs !== null) {
      levelsSolved += 1
      totalTimeMs += finish.elapsedMs
    } else {
      totalTimeMs += levelTimeLimitMs(state, finish.levelIndex)
    }
  }
  return {
    playerId,
    points: state.results.filter((r) => r.winnerId === playerId).length,
    levelsSolved,
    totalTimeMs,
    eliminatedAtLevel: participantOf(state, playerId)?.exitLevel ?? null,
  }
}

/** The sequence number of a player's last recorded finish; Infinity if they have none. */
const lastSeq = (state: MatchState, playerId: PlayerId): number => {
  let seq = Number.POSITIVE_INFINITY
  for (const finish of state.finishes) {
    if (finish.playerId === playerId) seq = finish.seq
  }
  return seq
}

const exitRank = (participant: Participant | null): number => {
  if (!participant || participant.exit === null) return 0
  return participant.exit === 'knockout' ? 1 : 2
}

/**
 * The final standings, best first.
 *
 * Ordering is per mode, and every comparison ends in a deterministic tiebreak
 * so two players never share a place:
 *
 *   BLAZE     most levels solved, then least total time, then who got there
 *             first. Levels lead the ordering because an unsolved level is
 *             charged its time limit, and a generous limit should never let a
 *             player who gave up on a puzzle outrank one who finished it.
 *
 *   STEADY    most levels won, then least total time, then who got there
 *             first. Time is the documented tiebreak because points are coarse
 *             — a five-level match has five of them — and the player who was
 *             consistently close to winning is the right one to rank higher.
 *
 *   KNOCKOUT  the survivor first, then the reverse of the elimination order:
 *             last out is second. Nothing else can order a knockout, because
 *             players who went out early never played the later levels.
 *
 * In every mode a player who left the room ranks below one who stayed. They
 * forfeited; a walkover is not a win over someone who is still playing.
 */
export const matchPodium = (state: MatchState): PodiumEntry[] => {
  const mode = state.settings.mode
  const rows = state.participants.map((participant) => ({
    participant,
    standing: standingFor(state, participant.id),
    seq: lastSeq(state, participant.id),
  }))

  rows.sort((a, b) => {
    if (mode === 'knockout') {
      const ea = a.standing.eliminatedAtLevel ?? Number.POSITIVE_INFINITY
      const eb = b.standing.eliminatedAtLevel ?? Number.POSITIVE_INFINITY
      if (ea !== eb) return eb - ea
      const byExit = exitRank(a.participant) - exitRank(b.participant)
      if (byExit !== 0) return byExit
    } else {
      const byExit = exitRank(a.participant) - exitRank(b.participant)
      if (byExit !== 0) return byExit
      if (mode === 'steady' && a.standing.points !== b.standing.points) {
        return b.standing.points - a.standing.points
      }
    }
    if (a.standing.levelsSolved !== b.standing.levelsSolved) {
      return b.standing.levelsSolved - a.standing.levelsSolved
    }
    if (a.standing.totalTimeMs !== b.standing.totalTimeMs) {
      return a.standing.totalTimeMs - b.standing.totalTimeMs
    }
    if (a.seq !== b.seq) return a.seq - b.seq
    return a.participant.id < b.participant.id ? -1 : 1
  })

  return rows.map((row, index) => {
    const status: PodiumStatus =
      row.participant.exit === 'left'
        ? 'left'
        : row.participant.exit === 'knockout'
          ? 'knocked-out'
          : index === 0
            ? 'champion'
            : 'finished'
    return {
      playerId: row.participant.id,
      place: index + 1,
      status,
      points: row.standing.points,
      levelsSolved: row.standing.levelsSolved,
      totalTimeMs: row.standing.totalTimeMs,
      eliminatedAtLevel: row.standing.eliminatedAtLevel,
    }
  })
}

/** The champion, or null when the room emptied before anyone could win. */
export const championOf = (podium: readonly PodiumEntry[]): PlayerId | null => {
  const first = podium[0]
  return first && first.status === 'champion' ? first.playerId : null
}

/**
 * Host succession.
 *
 * The earliest joiner still connected takes over, so a host who leaves
 * mid-match hands the room to the person most likely to have been there for
 * all of it. Ties on join time fall back to the player id, which keeps the
 * choice deterministic — every client computes the same new host without
 * waiting to be told. Returns null when nobody is left, which is the room's
 * cue to close.
 */
export const chooseHost = (
  players: readonly Player[],
  excludeId: PlayerId | null = null,
): PlayerId | null => {
  const candidates = players.filter((p) => p.id !== excludeId && p.connected)
  if (candidates.length === 0) return null
  let best = candidates[0] as Player
  for (const player of candidates) {
    if (
      player.joinedAt < best.joinedAt ||
      (player.joinedAt === best.joinedAt && player.id < best.id)
    )
      best = player
  }
  return best.id
}

/** Whether the host may start, and the error code to send back if not. */
export const canStartMatch = (
  settings: RoomSettings,
  players: readonly Player[],
): { ok: true } | { ok: false; code: RoomErrorCode } => {
  const present = players.filter((p) => p.connected).length
  const required = settings.mode === 'knockout' ? MIN_KNOCKOUT_PLAYERS : MIN_PLAYERS
  if (present < required) return { ok: false, code: 'not-enough-players' }
  if (present > MAX_PLAYERS) return { ok: false, code: 'room-full' }
  return { ok: true }
}

/**
 * Verifies a claimed solution against the level's own.
 *
 * A generated puzzle has exactly one solution, so "did they solve it" is an
 * array comparison once the server has generated the level from its number.
 * There is no scoring to re-derive and nothing to trust the client for.
 */
export const solutionMatches = (solution: readonly number[], claim: readonly number[]): boolean => {
  if (solution.length !== claim.length) return false
  for (let row = 0; row < solution.length; row++) {
    if (solution[row] !== claim[row]) return false
  }
  return true
}
