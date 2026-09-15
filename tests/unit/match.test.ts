import { describe, expect, it } from 'vitest'
import { tierFor, TIERS } from '../../src/board/generator/tiers'
import {
  applyDisconnect,
  applyFinish,
  applyLeave,
  applyReconnect,
  beginLevel,
  boardSizeFor,
  canAcceptFinish,
  canStartMatch,
  championOf,
  chooseHost,
  compareFinishes,
  COUNTDOWN_MS,
  createMatch,
  DIFFICULTY_BANDS,
  finishMatch,
  INTERLUDE_MS,
  knockoutLevelCount,
  levelCountFor,
  levelDeadlineAt,
  levelEndReason,
  levelSpecAt,
  LEVEL_TIME_LIMIT_MS,
  matchDeadlineAt,
  matchEndReason,
  matchPodium,
  matchSchedule,
  playerLevelIndex,
  resolveLevel,
  solutionMatches,
  standingFor,
  type MatchState,
} from '../../src/multiplayer/match'
import {
  decodeSettings,
  defaultSettingsFor,
  parseClientMessage,
  sanitizeName,
  type LevelCount,
  type LevelFinish,
  type Player,
  type RoomSettings,
} from '../../src/multiplayer/protocol'

const T0 = 1_000_000
const EASY_LIMIT = LEVEL_TIME_LIMIT_MS.easy

const blaze = (levelCount: LevelCount = 3): RoomSettings => ({
  mode: 'blaze',
  levelCount,
  difficulty: 'easy',
})

const steady = (levelCount: LevelCount = 3): RoomSettings => ({
  mode: 'steady',
  levelCount,
  difficulty: 'easy',
})

const knockout = (): RoomSettings => ({ mode: 'knockout', difficulty: 'easy' })

/** Creates a match and runs the countdown out, so it is on its first level. */
const startMatch = (settings: RoomSettings, ids: string[], startedAt = T0): MatchState =>
  beginLevel(
    createMatch({ settings, seed: 'A4K7M', players: ids, startedAt }),
    startedAt + COUNTDOWN_MS,
  )

/** A solve of whichever level the player is currently on. */
const solve = (state: MatchState, id: string, elapsedMs: number): MatchState => {
  const levelIndex = playerLevelIndex(state, id)
  return applyFinish(state, {
    playerId: id,
    levelIndex,
    status: 'solved',
    elapsedMs,
    progress: levelSpecAt(state, levelIndex)?.size ?? 0,
  })
}

/** A player who ran the clock out on the level they are on. */
const ranOut = (state: MatchState, id: string, progress = 0): MatchState => {
  const levelIndex = playerLevelIndex(state, id)
  return applyFinish(state, {
    playerId: id,
    levelIndex,
    status: 'timeout',
    elapsedMs: null,
    progress,
  })
}

const player = (id: string, joinedAt: number, connected = true): Player => ({
  id,
  name: id,
  joinedAt,
  connected,
  levelIndex: 0,
  levelsSolved: 0,
  points: 0,
  totalTimeMs: 0,
  eliminatedAtLevel: null,
  progress: 0,
})

const places = (state: MatchState): string[] => matchPodium(state).map((entry) => entry.playerId)

describe('the level sequence', () => {
  it('is a pure function of the seed', () => {
    expect(matchSchedule('A4K7M', 'standard', 5)).toEqual(matchSchedule('A4K7M', 'standard', 5))
  })

  it('differs between rooms', () => {
    const a = matchSchedule('A4K7M', 'standard', 5).map((spec) => spec.levelNumber)
    const b = matchSchedule('9WXY2', 'standard', 5).map((spec) => spec.levelNumber)
    expect(a).not.toEqual(b)
  })

  it('never repeats a level inside a match', () => {
    const numbers = matchSchedule('A4K7M', 'easy', 10).map((spec) => spec.levelNumber)
    expect(new Set(numbers).size).toBe(10)
  })

  it('stays inside the difficulty band', () => {
    for (const difficulty of ['easy', 'standard', 'hard'] as const) {
      const band = DIFFICULTY_BANDS[difficulty]
      for (const spec of matchSchedule('A4K7M', difficulty, 10)) {
        expect(spec.levelNumber).toBeGreaterThanOrEqual(band.from)
        expect(spec.levelNumber).toBeLessThanOrEqual(band.to)
      }
    }
  })

  it('draws only boards small enough to generate in milliseconds', () => {
    for (const difficulty of ['easy', 'standard', 'hard'] as const) {
      for (const spec of matchSchedule('A4K7M', difficulty, 10)) {
        expect(spec.size).toBeLessThanOrEqual(9)
        expect(spec.size).toBe(tierFor(spec.levelNumber).sizes[0])
      }
    }
  })

  it('carries the time limit of its difficulty', () => {
    expect(matchSchedule('A4K7M', 'hard', 1)[0]?.timeLimitMs).toBe(LEVEL_TIME_LIMIT_MS.hard)
  })

  it('never touches the single-player tiers that are slow to generate', () => {
    expect(DIFFICULTY_BANDS.hard.to).toBeLessThan(101)
  })

  it('is empty for a zero-length match rather than throwing', () => {
    expect(matchSchedule('A4K7M', 'easy', 0)).toEqual([])
  })
})

describe('boardSizeFor', () => {
  it('is exact for every level multiplayer can draw', () => {
    // The wire format publishes a board size without generating the board, so
    // every tier in a multiplayer band must declare exactly one size. A tier
    // table edit that broke this would silently mis-scale progress bars.
    for (const band of Object.values(DIFFICULTY_BANDS)) {
      for (let n = band.from; n <= band.to; n++) {
        expect(tierFor(n).sizes).toHaveLength(1)
        expect(boardSizeFor(n)).toBe(tierFor(n).sizes[0])
      }
    }
  })

  it('agrees with the tier table for the first tier', () => {
    expect(boardSizeFor(1)).toBe(TIERS[0]?.sizes[0])
  })
})

describe('how many levels a match plays', () => {
  it('uses the host setting for blaze and steady', () => {
    expect(levelCountFor(blaze(7), 4)).toBe(7)
    expect(levelCountFor(steady(10), 8)).toBe(10)
  })

  it('derives knockout from the player count: one elimination per level', () => {
    expect(knockoutLevelCount(8)).toBe(7)
    expect(knockoutLevelCount(4)).toBe(3)
    expect(knockoutLevelCount(3)).toBe(2)
    expect(knockoutLevelCount(2)).toBe(1)
  })

  it('gives knockout no settable length at all', () => {
    expect('levelCount' in defaultSettingsFor('knockout', 'easy')).toBe(false)
    expect(levelCountFor(knockout(), 5)).toBe(4)
  })
})

describe('blaze', () => {
  it('lets players advance without waiting for each other', () => {
    let state = startMatch(blaze(3), ['a', 'b'])
    state = solve(state, 'a', 4000)
    expect(playerLevelIndex(state, 'a')).toBe(1)
    expect(playerLevelIndex(state, 'b')).toBe(0)
    state = solve(state, 'a', 4000)
    expect(playerLevelIndex(state, 'a')).toBe(2)
    // The room's index follows the leader so spectators see the race front.
    expect(state.levelIndex).toBe(2)
    expect(state.phase).toBe('playing')
  })

  it('never enters an interlude', () => {
    let state = startMatch(blaze(3), ['a', 'b'])
    state = solve(state, 'a', 4000)
    expect(levelEndReason(state, T0 + 999_999)).toBeNull()
    expect(resolveLevel(state, T0 + 999_999).result).toBeNull()
  })

  it('orders the podium by levels solved, then by total time', () => {
    let state = startMatch(blaze(3), ['a', 'b', 'c'])
    for (const elapsed of [1000, 1000, 1000]) state = solve(state, 'a', elapsed)
    for (const elapsed of [5000, 5000, 5000]) state = solve(state, 'b', elapsed)
    state = solve(state, 'c', 1)
    state = solve(state, 'c', 1)
    state = ranOut(state, 'c', 3)

    expect(matchEndReason(state, T0)).toBe('complete')
    state = finishMatch(state)
    expect(places(state)).toEqual(['a', 'b', 'c'])

    const podium = matchPodium(state)
    expect(podium[0]?.status).toBe('champion')
    expect(podium[0]?.totalTimeMs).toBe(3000)
    // The unsolved level is charged the cap, and solving fewer levels still
    // ranks below solving more however fast the solved ones were.
    expect(podium[2]?.levelsSolved).toBe(2)
    expect(podium[2]?.totalTimeMs).toBe(2 + EASY_LIMIT)
  })

  it('has a backstop deadline so one stuck player cannot hold the room', () => {
    const state = startMatch(blaze(3), ['a', 'b'])
    expect(matchDeadlineAt(state)).toBe(T0 + COUNTDOWN_MS + 3 * EASY_LIMIT)
    expect(matchEndReason(state, matchDeadlineAt(state) - 1)).toBeNull()
    expect(matchEndReason(state, matchDeadlineAt(state))).toBe('deadline')
  })

  it('ranks a player who played the schedule out above one who solved nothing', () => {
    // Two players run the whole schedule while a third solves none of it, then
    // both finishers press "leave the match" rather than sit on a finished
    // board until the match deadline. Finishing is a state of its own, so
    // leaving afterwards forfeits nothing.
    let state = startMatch(blaze(5), ['a', 'b', 'c'])
    for (let level = 0; level < 5; level++) {
      state = solve(state, 'a', 1000)
      state = solve(state, 'b', 2000)
    }
    expect(state.participants.find((p) => p.id === 'a')?.exit).toBe('completed')
    expect(canAcceptFinish(state, 'a', 5)).toBe(false)

    state = applyLeave(state, 'a')
    state = applyLeave(state, 'b')
    expect(state.participants.find((p) => p.id === 'a')?.exit).toBe('completed')

    // c is still racing two banked times, so the match is not over — and it is
    // certainly not c's.
    expect(matchEndReason(state, T0 + COUNTDOWN_MS)).toBeNull()
    expect(matchEndReason(state, matchDeadlineAt(state))).toBe('deadline')

    state = finishMatch(state)
    expect(places(state)).toEqual(['a', 'b', 'c'])
    const podium = matchPodium(state)
    expect(championOf(podium)).toBe('a')
    expect(podium.map((entry) => entry.status)).toEqual(['champion', 'finished', 'finished'])
    expect(podium[2]?.levelsSolved).toBe(0)
  })

  it('does not hand a two-player race to the straggler when the finisher leaves', () => {
    let state = startMatch(blaze(3), ['a', 'b'])
    for (let level = 0; level < 3; level++) state = solve(state, 'a', 20_000)
    state = applyLeave(state, 'a')
    // b is alone but still has a finisher's time to chase, so the race runs on.
    expect(matchEndReason(state, T0 + COUNTDOWN_MS)).toBeNull()
    state = finishMatch(state)
    expect(championOf(matchPodium(state))).toBe('a')
    expect(places(state)).toEqual(['a', 'b'])
  })

  it('keeps the place of a finisher whose connection drops afterwards', () => {
    let state = startMatch(blaze(3), ['a', 'b'])
    for (let level = 0; level < 3; level++) state = solve(state, 'a', 1000)
    state = applyDisconnect(state, 'a')
    // The reconnect grace running out retires a seat, not a result.
    state = applyLeave(state, 'a')
    expect(state.participants.find((p) => p.id === 'a')?.exit).toBe('completed')

    state = solve(state, 'b', 500)
    state = finishMatch(state)
    expect(championOf(matchPodium(state))).toBe('a')
  })

  it('is complete, not empty, once every player has played it out', () => {
    let state = startMatch(blaze(3), ['a', 'b'])
    for (let level = 0; level < 3; level++) {
      state = solve(state, 'a', 1000)
      state = solve(state, 'b', 2000)
    }
    expect(matchEndReason(state, T0 + COUNTDOWN_MS)).toBe('complete')
    expect(championOf(matchPodium(finishMatch(state)))).toBe('a')
  })

  it('ends as a walkover when everyone else leaves', () => {
    let state = startMatch(blaze(3), ['a', 'b'])
    state = solve(state, 'a', 1000)
    state = applyLeave(state, 'b')
    expect(matchEndReason(state, T0)).toBe('walkover')
    state = finishMatch(state)
    expect(places(state)).toEqual(['a', 'b'])
    expect(championOf(matchPodium(state))).toBe('a')
  })
})

describe('steady', () => {
  it('scores a point to the fastest solver of each level', () => {
    let state = startMatch(steady(3), ['a', 'b', 'c'])
    let now = T0 + COUNTDOWN_MS

    const winners = ['a', 'b', 'a']
    for (const winner of winners) {
      const others = ['a', 'b', 'c'].filter((id) => id !== winner)
      state = solve(state, winner, 1000)
      state = solve(state, others[0] as string, 2000)
      expect(levelEndReason(state, now)).toBeNull()
      state = solve(state, others[1] as string, 3000)
      expect(levelEndReason(state, now)).toBe('all-finished')

      const closed = resolveLevel(state, now)
      state = closed.state
      expect(closed.result?.winnerId).toBe(winner)
      expect(closed.result?.eliminatedId).toBeNull()
      expect(state.phase === 'interlude' || state.phase === 'finished').toBe(true)
      now += INTERLUDE_MS
      state = beginLevel(state, now)
    }

    expect(state.phase).toBe('finished')
    expect(standingFor(state, 'a').points).toBe(2)
    expect(standingFor(state, 'b').points).toBe(1)
    expect(standingFor(state, 'c').points).toBe(0)
    expect(places(state)).toEqual(['a', 'b', 'c'])
  })

  it('breaks a points tie on total time', () => {
    let state = startMatch(steady(3), ['a', 'b'])
    let now = T0 + COUNTDOWN_MS
    const script: Array<[number, number]> = [
      [1000, 9000],
      [9000, 1000],
      [9000, 1500],
    ]
    for (const [aTime, bTime] of script) {
      state = solve(state, 'a', aTime)
      state = solve(state, 'b', bTime)
      state = resolveLevel(state, now).state
      now += INTERLUDE_MS
      state = beginLevel(state, now)
    }
    expect(standingFor(state, 'a').points).toBe(1)
    expect(standingFor(state, 'b').points).toBe(2)
    expect(places(state)).toEqual(['b', 'a'])
  })

  it('awards nobody the level when nobody solves it', () => {
    const state = startMatch(steady(3), ['a', 'b'])
    const now = levelDeadlineAt(state)
    expect(levelEndReason(state, now)).toBe('deadline')
    const closed = resolveLevel(state, now, { a: 3, b: 1 })
    expect(closed.result?.winnerId).toBeNull()
    expect(closed.result?.ranking).toEqual(['a', 'b'])
    expect(standingFor(closed.state, 'a').points).toBe(0)
  })

  it('gives the level to whoever the server saw first on an identical time', () => {
    let state = startMatch(steady(3), ['a', 'b'])
    state = solve(state, 'b', 5000)
    state = solve(state, 'a', 5000)
    const closed = resolveLevel(state, T0 + COUNTDOWN_MS)
    expect(closed.result?.winnerId).toBe('b')
    expect(closed.result?.ranking).toEqual(['b', 'a'])
  })

  it('charges an unsolved level its time limit and still ranks the solver first', () => {
    let state = startMatch(steady(3), ['a', 'b'])
    let now = T0 + COUNTDOWN_MS
    for (let i = 0; i < 3; i++) {
      state = solve(state, 'a', 5000)
      expect(levelEndReason(state, now)).toBeNull()
      now = levelDeadlineAt(state)
      expect(levelEndReason(state, now)).toBe('deadline')
      const closed = resolveLevel(state, now, { b: 2 })
      state = closed.state
      expect(closed.result?.winnerId).toBe('a')
      expect(closed.result?.finishes[1]?.status).toBe('timeout')
      now += INTERLUDE_MS
      state = beginLevel(state, now)
    }
    expect(state.phase).toBe('finished')
    expect(standingFor(state, 'b').levelsSolved).toBe(0)
    expect(standingFor(state, 'b').totalTimeMs).toBe(3 * EASY_LIMIT)
    expect(places(state)).toEqual(['a', 'b'])
  })
})

describe('knockout', () => {
  it('knocks the slowest player out of every level and crowns the survivor', () => {
    let state = startMatch(knockout(), ['a', 'b', 'c', 'd'])
    expect(state.levelCount).toBe(3)
    let now = T0 + COUNTDOWN_MS

    const order = [
      ['a', 'b', 'c', 'd'],
      ['a', 'b', 'c'],
      ['a', 'b'],
    ]
    for (const level of order) {
      level.forEach((id, index) => {
        state = solve(state, id, 1000 * (index + 1))
      })
      const closed = resolveLevel(state, now)
      state = closed.state
      expect(closed.result?.eliminatedId).toBe(level[level.length - 1])
      now += INTERLUDE_MS
      state = beginLevel(state, now)
    }

    expect(state.phase).toBe('finished')
    expect(places(state)).toEqual(['a', 'b', 'c', 'd'])
    const podium = matchPodium(state)
    expect(podium[0]?.status).toBe('champion')
    expect(podium[1]?.status).toBe('knocked-out')
    expect(podium[1]?.eliminatedAtLevel).toBe(3)
    expect(podium[3]?.eliminatedAtLevel).toBe(1)
  })

  it('decides an unsolved level on the record the server verified, not on reported progress', () => {
    // Identical state, one field different: the number of cats each client
    // claims to have placed. The server holds the solution but never sees a
    // board, so that number is unverifiable and must not rank anybody — least
    // of all decide who goes home.
    let state = startMatch(knockout(), ['a', 'b', 'c', 'd'])
    for (const [id, elapsed] of [
      ['a', 1000],
      ['b', 2000],
      ['c', 3000],
      ['d', 4000],
    ] as const) {
      state = solve(state, id, elapsed)
    }
    state = resolveLevel(state, T0 + COUNTDOWN_MS).state
    state = beginLevel(state, T0 + COUNTDOWN_MS + INTERLUDE_MS)

    const now = levelDeadlineAt(state)
    const honest = resolveLevel(state, now, { a: 0, b: 0, c: 0 })
    const lied = resolveLevel(state, now, { a: 0, b: 0, c: 99 })

    // Nobody solved it, so the level is decided by who has solved least and
    // spent longest getting there — both of them times the server measured.
    expect(honest.result?.winnerId).toBeNull()
    expect(honest.result?.eliminatedId).toBe('c')
    expect(lied.result?.eliminatedId).toBe('c')
    expect(lied.result?.ranking).toEqual(['a', 'b', 'c'])
  })

  it('eliminates nobody from a level the rules cannot separate anyone on', () => {
    // First level, nobody solved it, nobody has a record yet: the three players
    // really are indistinguishable on everything the server knows, and a
    // knockout must not evict one of them on a number they typed themselves.
    const state = startMatch(knockout(), ['a', 'b', 'c'])
    const now = levelDeadlineAt(state)
    const closed = resolveLevel(state, now, { a: 4, b: 2, c: 3 })
    expect(closed.result?.winnerId).toBeNull()
    expect(closed.result?.eliminatedId).toBeNull()
    expect(closed.state.participants.every((p) => p.exit === null)).toBe(true)
  })

  it('still reaches a champion after a level that eliminated nobody', () => {
    let state = startMatch(knockout(), ['a', 'b', 'c'])
    let now = levelDeadlineAt(state)
    state = resolveLevel(state, now, {}).state
    now += INTERLUDE_MS
    state = beginLevel(state, now)

    state = solve(state, 'a', 1000)
    now = levelDeadlineAt(state)
    const closed = resolveLevel(state, now, {})
    // b and c are still level with each other, so this level puts nobody out
    // either, and the schedule simply runs out with three players standing.
    expect(closed.result?.eliminatedId).toBeNull()
    state = beginLevel(closed.state, now + INTERLUDE_MS)

    expect(state.phase).toBe('finished')
    const podium = matchPodium(state)
    expect(podium.map((entry) => entry.place)).toEqual([1, 2, 3])
    expect(championOf(podium)).toBe('a')
    expect(new Set(podium.map((entry) => entry.playerId)).size).toBe(3)
  })

  it('does not call a title earned when the room emptied after the last level', () => {
    let state = startMatch(knockout(), ['a', 'b', 'c', 'd'])
    const now = T0 + COUNTDOWN_MS
    for (const [id, elapsed] of [
      ['a', 1000],
      ['b', 2000],
      ['c', 3000],
      ['d', 4000],
    ] as const) {
      state = solve(state, id, elapsed)
    }
    state = resolveLevel(state, now).state
    expect(matchEndReason(state, now)).toBeNull()

    // Two players walk out of the interlude. a is the last one standing
    // because the room emptied, not because a beat anybody in a final.
    state = applyLeave(state, 'b')
    state = applyLeave(state, 'c')
    expect(matchEndReason(state, now)).toBe('walkover')
    state = finishMatch(state)
    expect(championOf(matchPodium(state))).toBe('a')
  })

  it('makes the next level the final when the room drops to two early', () => {
    let state = startMatch(knockout(), ['a', 'b', 'c', 'd'])
    let now = T0 + COUNTDOWN_MS
    for (const [id, elapsed] of [
      ['a', 1000],
      ['b', 2000],
      ['c', 3000],
      ['d', 4000],
    ] as const) {
      state = solve(state, id, elapsed)
    }
    state = resolveLevel(state, now).state
    expect(state.participants.find((p) => p.id === 'd')?.exit).toBe('knockout')

    // A player walks out during the interlude, so three scheduled levels
    // become two and the next one is the head-to-head.
    state = applyLeave(state, 'c')
    expect(matchEndReason(state, now)).toBeNull()
    now += INTERLUDE_MS
    state = beginLevel(state, now)
    state = solve(state, 'b', 1000)
    state = solve(state, 'a', 2000)
    const closed = resolveLevel(state, now)
    state = closed.state

    expect(closed.result?.eliminatedId).toBe('a')
    expect(state.phase).toBe('finished')
    expect(state.results).toHaveLength(2)
    expect(state.levelIndex).toBeLessThan(state.levelCount)
    // b survived a real head-to-head; a was knocked out of it; c forfeited at
    // the same level as a but ranks below them for leaving.
    expect(places(state)).toEqual(['b', 'a', 'c', 'd'])
    expect(matchPodium(state)[2]?.status).toBe('left')
  })

  it('reports a walkover rather than a win when the room simply empties', () => {
    let state = startMatch(knockout(), ['a', 'b', 'c'])
    state = applyLeave(state, 'b')
    state = applyLeave(state, 'c')
    expect(matchEndReason(state, T0)).toBe('walkover')
    state = finishMatch(state)
    expect(championOf(matchPodium(state))).toBe('a')
  })

  it('ends with no champion when everybody leaves', () => {
    let state = startMatch(knockout(), ['a', 'b', 'c'])
    for (const id of ['a', 'b', 'c']) state = applyLeave(state, id)
    expect(matchEndReason(state, T0)).toBe('empty')
    state = finishMatch(state)
    expect(championOf(matchPodium(state))).toBeNull()
    expect(matchPodium(state).every((entry) => entry.status === 'left')).toBe(true)
  })

  it('plays a single level with the minimum crowd', () => {
    const state = startMatch(knockout(), ['a', 'b'])
    expect(state.levelCount).toBe(1)
    expect(state.schedule).toHaveLength(1)
  })
})

describe('disconnects', () => {
  it('keeps a dropped player in the match while their clock runs', () => {
    let state = startMatch(steady(3), ['a', 'b'])
    state = applyDisconnect(state, 'b')
    expect(state.participants.find((p) => p.id === 'b')?.exit).toBeNull()
    expect(canAcceptFinish(state, 'b', 0)).toBe(true)
    state = applyReconnect(state, 'b')
    expect(state.participants.find((p) => p.id === 'b')?.connected).toBe(true)
    state = solve(state, 'b', 1000)
    expect(standingFor(state, 'b').levelsSolved).toBe(1)
  })

  it('records a player who was offline at the end as having abandoned it', () => {
    let state = startMatch(steady(3), ['a', 'b'])
    state = solve(state, 'a', 1000)
    state = applyDisconnect(state, 'b')
    const closed = resolveLevel(state, levelDeadlineAt(state), { b: 1 })
    expect(closed.result?.finishes[1]?.status).toBe('abandoned')
    expect(closed.result?.ranking).toEqual(['a', 'b'])
  })

  it('ranks a timeout above an abandonment however far each claims to have got', () => {
    const gone: LevelFinish = {
      playerId: 'gone',
      levelIndex: 0,
      status: 'abandoned',
      elapsedMs: null,
      progress: 5,
      seq: 2,
    }
    const stuck: LevelFinish = {
      playerId: 'stuck',
      levelIndex: 0,
      status: 'timeout',
      elapsedMs: null,
      progress: 0,
      seq: 1,
    }
    expect([gone, stuck].sort(compareFinishes).map((f) => f.playerId)).toEqual(['stuck', 'gone'])
  })

  it('ends a steady match with no champion when the whole room walks out', () => {
    let state = startMatch(steady(3), ['a', 'b'])
    state = solve(state, 'a', 1000)
    for (const id of ['a', 'b']) state = applyLeave(state, id)
    expect(matchEndReason(state, T0)).toBe('empty')
    state = finishMatch(state)
    expect(championOf(matchPodium(state))).toBeNull()
    expect(matchPodium(state).every((entry) => entry.status === 'left')).toBe(true)
  })

  it('does not demote a player who closes the podium screen', () => {
    let state = startMatch(steady(3), ['a', 'b'])
    let now = T0 + COUNTDOWN_MS
    for (let level = 0; level < 3; level++) {
      state = solve(state, 'a', 1000)
      state = solve(state, 'b', 2000)
      state = resolveLevel(state, now).state
      now += INTERLUDE_MS
      state = beginLevel(state, now)
    }
    expect(state.phase).toBe('finished')
    // The match is over; there is nothing left to forfeit by leaving it.
    expect(applyLeave(state, 'a')).toBe(state)
    expect(places(applyLeave(state, 'a'))).toEqual(['a', 'b'])
    expect(championOf(matchPodium(applyLeave(state, 'a')))).toBe('a')
  })

  it('stops a player who left from winning the level they were in', () => {
    let state = startMatch(steady(3), ['a', 'b', 'c'])
    state = solve(state, 'a', 500)
    state = applyLeave(state, 'a')
    state = solve(state, 'b', 4000)
    state = solve(state, 'c', 5000)
    const closed = resolveLevel(state, T0 + COUNTDOWN_MS)
    expect(closed.result?.winnerId).toBe('b')
    expect(closed.result?.ranking).not.toContain('a')
  })
})

describe('accepting a finish', () => {
  it('ignores a replayed claim', () => {
    let state = startMatch(steady(3), ['a', 'b'])
    state = solve(state, 'a', 1000)
    const replayed = solve(state, 'a', 1)
    expect(replayed).toBe(state)
    expect(state.finishes).toHaveLength(1)
  })

  it('ignores a claim for a level the player is not on', () => {
    const state = startMatch(steady(3), ['a', 'b'])
    expect(canAcceptFinish(state, 'a', 2)).toBe(false)
    expect(canAcceptFinish(state, 'a', -1)).toBe(false)
    expect(
      applyFinish(state, {
        playerId: 'a',
        levelIndex: 2,
        status: 'solved',
        elapsedMs: 10,
        progress: 5,
      }),
    ).toBe(state)
  })

  it('ignores a claim from a player who is out', () => {
    let state = startMatch(knockout(), ['a', 'b', 'c'])
    state = applyLeave(state, 'c')
    expect(canAcceptFinish(state, 'c', 0)).toBe(false)
  })

  it('ignores a claim before the countdown has run out', () => {
    const state = createMatch({
      settings: steady(3),
      seed: 'A4K7M',
      players: ['a', 'b'],
      startedAt: T0,
    })
    expect(state.phase).toBe('countdown')
    expect(canAcceptFinish(state, 'a', 0)).toBe(false)
  })

  it('stamps a rising sequence number so an identical time is still ordered', () => {
    let state = startMatch(steady(3), ['a', 'b'])
    state = solve(state, 'a', 1000)
    state = solve(state, 'b', 1000)
    expect(state.finishes.map((f) => f.seq)).toEqual([1, 2])
    expect(
      compareFinishes(state.finishes[0] as LevelFinish, state.finishes[1] as LevelFinish),
    ).toBeLessThan(0)
  })
})

describe('host succession', () => {
  it('hands the room to the earliest joiner still connected', () => {
    const players = [player('host', 100), player('b', 200), player('c', 150)]
    expect(chooseHost(players, 'host')).toBe('c')
  })

  it('skips players who are offline', () => {
    const players = [player('host', 100), player('b', 150, false), player('c', 200)]
    expect(chooseHost(players, 'host')).toBe('c')
  })

  it('breaks a join-time tie deterministically', () => {
    expect(chooseHost([player('z', 100), player('a', 100)], null)).toBe('a')
  })

  it('reports an empty room rather than inventing a host', () => {
    expect(chooseHost([], null)).toBeNull()
    expect(chooseHost([player('host', 100)], 'host')).toBeNull()
  })
})

describe('starting a match', () => {
  it('needs two players for blaze and steady', () => {
    expect(canStartMatch(steady(5), [player('a', 1)])).toEqual({
      ok: false,
      code: 'not-enough-players',
    })
    expect(canStartMatch(steady(5), [player('a', 1), player('b', 2)])).toEqual({ ok: true })
  })

  it('needs a crowd for knockout, which is the point of the mode', () => {
    expect(canStartMatch(knockout(), [player('a', 1), player('b', 2)]).ok).toBe(false)
    expect(canStartMatch(knockout(), [player('a', 1), player('b', 2), player('c', 3)])).toEqual({
      ok: true,
    })
  })

  it('does not count players who have dropped out of the lobby', () => {
    expect(canStartMatch(steady(5), [player('a', 1), player('b', 2, false)]).ok).toBe(false)
  })
})

describe('solutionMatches', () => {
  it('accepts the level solution and nothing else', () => {
    expect(solutionMatches([2, 0, 3, 1], [2, 0, 3, 1])).toBe(true)
    expect(solutionMatches([2, 0, 3, 1], [2, 0, 1, 3])).toBe(false)
    expect(solutionMatches([2, 0, 3, 1], [2, 0, 3])).toBe(false)
  })
})

describe('the wire contract', () => {
  it('refuses to carry a level count into knockout settings', () => {
    expect(decodeSettings({ mode: 'knockout', difficulty: 'easy', levelCount: 99 })).toEqual({
      mode: 'knockout',
      difficulty: 'easy',
    })
  })

  it('rejects a level count the host cannot have chosen', () => {
    expect(decodeSettings({ mode: 'blaze', difficulty: 'easy', levelCount: 4 })).toBeNull()
    expect(decodeSettings({ mode: 'nope', difficulty: 'easy', levelCount: 5 })).toBeNull()
  })

  it('trims a name to something a progress bar can show', () => {
    expect(sanitizeName('  Mr   Whiskers  the   Third ')).toBe('Mr Whiskers the')
  })

  it('rejects a malformed frame rather than guessing at it', () => {
    expect(parseClientMessage('not json')).toBeNull()
    expect(parseClientMessage({ t: 'progress', cats: -1 })).toBeNull()
    expect(
      parseClientMessage({ t: 'solved', claim: { levelIndex: 0, cols: [9] }, clientMs: 1 }),
    ).toBeNull()
    expect(parseClientMessage('{"t":"start"}')).toEqual({ t: 'start' })
  })
})
