import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as PartyClientModule from '../../src/multiplayer/client'
import type { Level } from '../../src/board/types'
import { toIndex } from '../../src/board/types'

/**
 * The store, driven by server frames, with the two things it talks to replaced.
 *
 * Both replacements are the point rather than a convenience. The party client
 * becomes a list of frames sent and a function that pushes frames back, so a
 * whole match can be played out synchronously. The level client becomes a
 * promise this file decides when to resolve, which is what makes the window
 * between "a new level has begun" and "its board exists" observable at all —
 * in the app that window is always non-empty, because even a cache hit resolves
 * a promise, but it is far too short to catch by waiting.
 *
 * What is asserted through it is mostly what the progress race would draw, via
 * `racerInputsFrom`. A bar that reads a state the player is not in is the
 * defect this file exists for, and the honest way to test it is to ask the same
 * question the component asks, of the same store the component reads.
 */

const stub = vi.hoisted(() => ({
  loadLevel: vi.fn(),
  createPartyClient: vi.fn(),
  createRoom: vi.fn(),
  lookupRoom: vi.fn(),
}))

vi.mock('../../src/level/levelClient', () => ({ loadLevel: stub.loadLevel }))

vi.mock('../../src/multiplayer/client', async (importOriginal) => {
  const actual = await importOriginal<typeof PartyClientModule>()
  return {
    ...actual,
    createPartyClient: stub.createPartyClient,
    createRoom: stub.createRoom,
    lookupRoom: stub.lookupRoom,
  }
})

import type {
  PartyClient,
  PartyClientListener,
  PartyClientStatus,
} from '../../src/multiplayer/client'
import { configureParty, resetConnectivity } from '../../src/multiplayer/connection'
import type {
  ClientMessage,
  GameMode,
  LevelCount,
  LevelSpec,
  Player,
  PlayerId,
  RoomCode,
  RoomState,
  ServerMessage,
} from '../../src/multiplayer/protocol'
import { PROTOCOL_VERSION } from '../../src/multiplayer/protocol'
import { isSyncedMode } from '../../src/multiplayer/match'
import { selectCanRematch, selectCanStart, useMultiplayerStore } from '../../src/multiplayer/store'
import { racerInputsFrom } from '../../src/ui/multiplayer/ProgressRace'
import { buildRacers, racerFraction, type RacerInput } from '../../src/ui/multiplayer/race'

// ---------------------------------------------------------------------------
// The room this file plays its matches in.
// ---------------------------------------------------------------------------

const ROOM = 'H3K9M' as RoomCode
const ME = 'me' as PlayerId
const RIVAL = 'rival' as PlayerId

const BOARD_SIZE = 5

/**
 * A board of the right shape for the reducer, keyed by level number.
 *
 * Only the size, the regions and the solution are read by anything under test,
 * and the solution is what lets a test actually solve a board rather than
 * assert that it did.
 */
const levelFor = (levelNumber: number): Level => ({
  number: levelNumber,
  size: BOARD_SIZE,
  regions: ['AABBB', 'AABBB', 'CCDDD', 'CCDDD', 'EEEEE'],
  solution: [0, 2, 4, 1, 3],
  tier: 1,
  depth: 1,
  generatorVersion: 1,
})

/** Level numbers are arbitrary; a schedule is only ever a list of them. */
const scheduleOf = (...levelNumbers: number[]): LevelSpec[] =>
  levelNumbers.map((levelNumber) => ({ levelNumber, size: BOARD_SIZE, timeLimitMs: 60_000 }))

const player = (id: PlayerId, overrides: Partial<Player> = {}): Player => ({
  id,
  name: id === ME ? 'Pat' : 'Rival',
  joinedAt: 0,
  connected: true,
  levelIndex: -1,
  levelsSolved: 0,
  points: 0,
  totalTimeMs: 0,
  eliminatedAtLevel: null,
  progress: 0,
  ...overrides,
})

const roomState = (overrides: Partial<RoomState> = {}): RoomState => ({
  code: ROOM,
  phase: 'lobby',
  hostId: ME,
  settings: { mode: 'steady', levelCount: 3, difficulty: 'standard' },
  players: [player(ME), player(RIVAL)],
  levelCount: 3,
  schedule: null,
  levelIndex: -1,
  phaseStartedAt: 0,
  phaseEndsAt: null,
  results: [],
  podium: null,
  serverTime: 0,
  ...overrides,
})

// ---------------------------------------------------------------------------
// The fakes.
// ---------------------------------------------------------------------------

/** Every level the store has asked for and not yet been given. */
let building = new Map<number, (level: Level) => void>()

type Wire = {
  /** Every frame this client has put on the wire, in order. */
  sent: ClientMessage[]
  /** Pushes a frame from the server. */
  emit: (message: ServerMessage) => void
  /** Moves the transport, which the store mirrors onto `status`. */
  setStatus: (status: PartyClientStatus) => void
  closed: boolean
}

let wire: Wire

/** Lets go of one level the store is waiting on, then lets the store settle. */
const finishBuilding = async (levelNumber: number): Promise<void> => {
  const resolve = building.get(levelNumber)
  if (resolve === undefined) throw new Error(`nothing is building level ${levelNumber}`)
  building.delete(levelNumber)
  resolve(levelFor(levelNumber))
  await settle()
}

/** Drains the microtasks `openLevelAt` needs to get from its await to its set. */
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) await Promise.resolve()
}

beforeEach(() => {
  building = new Map()
  resetConnectivity()
  configureParty('party.example.test')

  stub.loadLevel.mockImplementation(
    (levelNumber: number) =>
      new Promise<Level>((resolve) => {
        building.set(levelNumber, resolve)
      }),
  )
  stub.lookupRoom.mockImplementation(async (code: RoomCode) => ({ ok: true, code }))
  stub.createRoom.mockImplementation(async () => ({ ok: true, code: ROOM }))
  stub.createPartyClient.mockImplementation(() => {
    const listeners = new Set<PartyClientListener>()
    const live: Wire = {
      sent: [],
      emit: (message) => {
        for (const listener of [...listeners]) listener({ kind: 'message', message })
      },
      setStatus: (status) => {
        for (const listener of [...listeners]) listener({ kind: 'status', status, rejection: null })
      },
      closed: false,
    }
    wire = live
    const client: PartyClient = {
      room: ROOM,
      status: () => 'connecting',
      rejection: () => null,
      clock: () => ({ offsetMs: 0, rttMs: null }),
      send: (message) => {
        live.sent.push(message)
        return true
      },
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      reconnect: () => {},
      close: () => {
        live.closed = true
      },
    }
    return client
  })
})

afterEach(() => {
  useMultiplayerStore.getState().reset()
  configureParty(null)
  resetConnectivity()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Driving a match.
// ---------------------------------------------------------------------------

/** Joins the room and takes the welcome, leaving the store in a live lobby. */
const enterRoom = async (): Promise<void> => {
  await useMultiplayerStore.getState().joinRoom(ROOM, 'Pat')
  // Sound and haptics are off so the reducer's cues never look for an audio
  // context; nothing under test cares which way they are set.
  useMultiplayerStore.getState().setPreferences({ sound: false, haptics: false })
  wire.setStatus('connected')
  wire.emit({ t: 'welcome', v: PROTOCOL_VERSION, you: ME, token: 'seat-token', state: roomState() })
}

const playingState = (levelIndex: number, schedule: LevelSpec[], mode: GameMode): RoomState =>
  roomState({
    phase: 'playing',
    settings:
      mode === 'knockout'
        ? { mode, difficulty: 'standard' }
        : { mode, levelCount: schedule.length as LevelCount, difficulty: 'standard' },
    schedule,
    levelIndex,
    levelCount: schedule.length,
    players: [player(ME, { levelIndex }), player(RIVAL, { levelIndex })],
  })

/** Starts a match and opens its first board, so a test begins mid-level. */
const startMatch = async (schedule: LevelSpec[], mode: GameMode): Promise<void> => {
  await enterRoom()
  wire.emit({ t: 'match', schedule, levelCount: schedule.length, startsAt: 0 })
  wire.emit({ t: 'state', state: playingState(0, schedule, mode) })
  wire.emit({ t: 'level', levelIndex: 0, startsAt: 0, deadlineAt: 60_000 })
  await finishBuilding(schedule[0]?.levelNumber ?? 0)
}

/** Places every cat on the board in front of this client, as a player would. */
const solveMyBoard = (): void => {
  const { game, dispatch } = useMultiplayerStore.getState()
  if (game === null) throw new Error('there is no board to solve')
  game.solution.forEach((col, row) => {
    dispatch({ type: 'doubleTap', index: toIndex(game.size, row, col) })
  })
}

// ---------------------------------------------------------------------------
// What the race would draw, asked of the live store.
// ---------------------------------------------------------------------------

const racerInputs = (): RacerInput[] => {
  const state = useMultiplayerStore.getState()
  return racerInputsFrom({
    players: state.players,
    progress: state.progress,
    schedule: state.schedule,
    playerId: state.playerId,
    myLevelIndex: state.myLevelIndex,
    game: state.game,
  })
}

const myRacer = (): RacerInput => {
  const mine = racerInputs().find((input) => input.id === ME)
  if (mine === undefined) throw new Error('this client is not in the field')
  return mine
}

/** Where this client's bar would sit, 0 to 1. */
const myFraction = (): number => {
  const state = useMultiplayerStore.getState()
  return racerFraction(myRacer(), {
    synced: isSyncedMode(state.settings),
    levelCount: state.levelCount,
  })
}

// ---------------------------------------------------------------------------

describe('the board a level change hands over to', () => {
  it('reads as not started, not as the finished board it replaced', async () => {
    const schedule = scheduleOf(11, 12, 13)
    await startMatch(schedule, 'steady')

    solveMyBoard()
    // The server stamps the solve and its progress pump echoes it straight
    // back: this client, five of five, on level 0.
    wire.emit({ t: 'progress', at: 0, ticks: [[ME, 0, BOARD_SIZE]] })
    expect(myRacer().cats).toBe(BOARD_SIZE)
    expect(myFraction()).toBe(1)

    // The room closes the level and opens the next one, in the order the room
    // sends them: the level frame first, the snapshot behind it. Everything
    // between the two happens while this client's board is still being built,
    // which in the app is every level change on every device — the cache read
    // that usually answers instantly still answers through a promise.
    wire.emit({ t: 'level', levelIndex: 1, startsAt: 0, deadlineAt: 60_000 })

    const store = useMultiplayerStore.getState()
    expect(store.myLevelIndex).toBe(1)
    expect(store.loadingLevel).toBe(true)
    expect(store.game).toBeNull()
    // No board means nothing placed on it, which is exactly true: the player
    // cannot have made progress on a board that does not exist yet. The last
    // thing the room said about them — five of five — describes a board they
    // are no longer on and must not be borrowed for this one.
    expect(myRacer()).toMatchObject({ levelIndex: 1, cats: 0, size: BOARD_SIZE })
    expect(myFraction()).toBe(0)

    wire.emit({ t: 'state', state: playingState(1, schedule, 'steady') })
    expect(myFraction()).toBe(0)

    await finishBuilding(12)
    expect(useMultiplayerStore.getState().game?.levelNumber).toBe(12)
    expect(myRacer()).toMatchObject({ levelIndex: 1, cats: 0, size: BOARD_SIZE })
  })

  it('never crowns this client for a board it has not been given yet', async () => {
    const schedule = scheduleOf(11, 12, 13)
    await startMatch(schedule, 'steady')
    solveMyBoard()
    wire.emit({ t: 'progress', at: 0, ticks: [[ME, 0, BOARD_SIZE]] })

    wire.emit({ t: 'level', levelIndex: 1, startsAt: 0, deadlineAt: 60_000 })

    // Everybody is on zero at the start of a level, so nobody leads. A bar that
    // kept the last board's cats would put this client in front of a field that
    // has not started, wearing the crown, for as long as the generator takes.
    const racers = buildRacers(racerInputs(), { synced: true, levelCount: 3 }, ME)
    expect(racers.map((racer) => racer.fraction)).toEqual([0, 0])
    expect(racers.some((racer) => racer.isLeader)).toBe(false)
  })

  it('does not read a level ahead of itself in blaze', async () => {
    const schedule = scheduleOf(21, 22, 23)
    await startMatch(schedule, 'blaze')

    solveMyBoard()
    // One level of three is complete, so the bar stands a third of the way
    // along: the solved board fills level 0's share of the track exactly.
    expect(myFraction()).toBeCloseTo(1 / 3, 6)

    // Blaze has no synchronised start: the acceptance is itself the starting
    // gun for the next board, and the store opens it immediately.
    wire.emit({ t: 'accepted', levelIndex: 0, elapsedMs: 4_000 })

    expect(useMultiplayerStore.getState().myLevelIndex).toBe(1)
    expect(useMultiplayerStore.getState().game).toBeNull()
    // Exactly where the solve left it. Carrying the solved board's five cats
    // onto the new level's index would read two thirds of the way through a
    // match in which one level of three has been solved.
    expect(myFraction()).toBeCloseTo(1 / 3, 6)

    await finishBuilding(22)
    expect(myFraction()).toBeCloseTo(1 / 3, 6)
  })

  it('leaves a board alone when the level it belongs to has not changed', async () => {
    const schedule = scheduleOf(11, 12, 13)
    await startMatch(schedule, 'steady')
    solveMyBoard()
    const solved = useMultiplayerStore.getState().game

    // What a reconnect looks like: the same level, re-announced. The board is
    // local, so a player who dropped and came back mid-level must find their
    // cells exactly where they left them.
    wire.emit({
      t: 'welcome',
      v: PROTOCOL_VERSION,
      you: ME,
      token: 'seat-token',
      state: playingState(0, schedule, 'steady'),
    })
    await settle()
    expect(useMultiplayerStore.getState().game).toBe(solved)
  })
})

describe('a room that outlives its match', () => {
  const finish = (): void => {
    wire.emit({
      t: 'finished',
      podium: [
        {
          playerId: ME,
          place: 1,
          status: 'champion',
          points: 1,
          levelsSolved: 1,
          totalTimeMs: 4000,
          eliminatedAtLevel: null,
        },
      ],
    })
  }

  it('forgets the finished match when the room goes back to its lobby', async () => {
    const schedule = scheduleOf(11, 12, 13)
    await startMatch(schedule, 'steady')
    solveMyBoard()
    finish()
    expect(useMultiplayerStore.getState().phase).toBe('finished')

    // A rematch is the server's doing: it answers with an ordinary state frame
    // carrying a lobby.
    wire.emit({ t: 'state', state: roomState() })

    const store = useMultiplayerStore.getState()
    expect(store.phase).toBe('lobby')
    expect(store.game).toBeNull()
    expect(store.level).toBeNull()
    expect(store.myLevelIndex).toBe(-1)
    expect(store.accepted).toBeNull()
    expect(store.lastResult).toBeNull()
    expect(store.podium).toBeNull()
  })

  it('opens a fresh board when the next match repeats a level number', async () => {
    const schedule = scheduleOf(11, 12, 13)
    await startMatch(schedule, 'steady')
    solveMyBoard()
    finish()

    // Straight from the podium into another match, which the server allows.
    // Its schedule opens on the same level number as the last one — improbable
    // but permitted, and the one case where a board left lying around would be
    // handed back to the player already solved.
    wire.emit({ t: 'match', schedule, levelCount: 3, startsAt: 0 })
    wire.emit({ t: 'state', state: playingState(0, schedule, 'steady') })
    wire.emit({ t: 'level', levelIndex: 0, startsAt: 0, deadlineAt: 60_000 })
    await finishBuilding(11)

    expect(useMultiplayerStore.getState().game?.levelNumber).toBe(11)
    expect(useMultiplayerStore.getState().game?.status).toBe('playing')
    expect(myRacer().cats).toBe(0)
  })
})

describe('asking for another match', () => {
  it('sends the room a rematch', async () => {
    await enterRoom()
    useMultiplayerStore.getState().rematch()
    expect(wire.sent).toContainEqual({ t: 'rematch' })
  })

  it('offers a rematch to any seated player on a live connection', async () => {
    const schedule = scheduleOf(11, 12, 13)
    await startMatch(schedule, 'steady')
    // Not while the match is being played: the server would refuse it.
    expect(selectCanRematch(useMultiplayerStore.getState())).toBe(false)

    wire.emit({ t: 'state', state: playingState(0, schedule, 'steady') })
    wire.emit({ t: 'state', state: roomState({ phase: 'finished', podium: [] }) })
    expect(useMultiplayerStore.getState().phase).toBe('finished')
    // A guest, not the host: the podium is on everybody's screen.
    useMultiplayerStore.setState({ hostId: RIVAL })
    expect(selectCanRematch(useMultiplayerStore.getState())).toBe(true)

    // A button whose message would be silently dropped is worse than no button.
    wire.setStatus('reconnecting')
    expect(selectCanRematch(useMultiplayerStore.getState())).toBe(false)
  })

  it('lets a finished room start another match', async () => {
    const schedule = scheduleOf(11, 12, 13)
    await startMatch(schedule, 'steady')
    // Mid-match, nobody may start anything.
    expect(selectCanStart(useMultiplayerStore.getState())).toBe(false)

    wire.emit({ t: 'state', state: roomState({ phase: 'finished', podium: [] }) })
    expect(selectCanStart(useMultiplayerStore.getState())).toBe(true)

    wire.emit({ t: 'state', state: roomState() })
    expect(selectCanStart(useMultiplayerStore.getState())).toBe(true)
  })

  it('refuses to start a room that has nobody else in it', async () => {
    await enterRoom()
    wire.emit({ t: 'state', state: roomState({ players: [player(ME)] }) })
    expect(selectCanStart(useMultiplayerStore.getState())).toBe(false)
  })
})

describe('the field, as the race reads it', () => {
  it('takes an opponent from the room and never from this client', async () => {
    const schedule = scheduleOf(11, 12, 13)
    await startMatch(schedule, 'steady')

    wire.emit({ t: 'progress', at: 0, ticks: [[RIVAL, 0, 3]] })
    const rival = racerInputs().find((input) => input.id === RIVAL)
    expect(rival).toMatchObject({ levelIndex: 0, cats: 3, size: BOARD_SIZE })

    // And this client's own row is unmoved by the room's opinion of it: a tick
    // about you is a round trip old, and your board is in front of you.
    wire.emit({ t: 'progress', at: 0, ticks: [[ME, 0, 4]] })
    expect(myRacer().cats).toBe(0)
  })

  it('leaves a player who dropped exactly where the room last put them', async () => {
    const schedule = scheduleOf(11, 12, 13)
    await startMatch(schedule, 'steady')
    wire.emit({ t: 'progress', at: 0, ticks: [[RIVAL, 0, 2]] })

    wire.emit({
      t: 'state',
      state: roomState({
        phase: 'playing',
        schedule,
        levelIndex: 0,
        players: [
          player(ME, { levelIndex: 0 }),
          player(RIVAL, { levelIndex: 0, connected: false, progress: 2 }),
        ],
      }),
    })

    const rival = racerInputs().find((input) => input.id === RIVAL)
    expect(rival).toMatchObject({ levelIndex: 0, cats: 2, connected: false })
  })
})
