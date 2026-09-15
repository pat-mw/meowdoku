/**
 * The multiplayer session, as a store the screens can read.
 *
 * This is the seam between the socket and the UI, and it is deliberately the
 * only place that knows about both. It holds three kinds of thing: the room
 * state the server owns and broadcasts, the local-only facts about this player
 * (who I am, whether my connection is up, which board I am looking at), and the
 * puzzle in progress.
 *
 * Three rules shape it.
 *
 * The board is the existing pure reducer, unforked. Multiplayer supplies a
 * level number, hands the resulting `Level` to `createGame`, feeds the same
 * gestures through `reduce` that a single-player level does, and reads progress
 * back out of the cells. Every rule about cats, lives and winning stays in
 * `src/board`, which continues to know nothing about rooms or sockets.
 *
 * Levels travel as numbers. The server broadcasts a schedule of level numbers;
 * each client generates the identical board from them through the same worker
 * and the same cache single-player uses. No puzzle is ever sent over the wire.
 *
 * Nothing here touches the single-player save. This store is entirely separate
 * from `useGameStore`, writes to no storage of its own, and a multiplayer
 * connection dying has no path by which it could disturb a single-player game.
 * The two settings multiplayer honours — auto-marking, and whether sound and
 * haptics are on — are pushed in by the screen through `setPreferences` rather
 * than read out of the save, so the dependency runs one way only.
 */

import { create } from 'zustand'
import type { GameAction, GameState } from '../board/reducer'
import { createGame, reduce } from '../board/reducer'
import { catIndices } from '../board/rules'
import { CellState, toIndex } from '../board/types'
import type { Level } from '../board/types'
import { loadLevel } from '../level/levelClient'
import { hapticForGesture, vibrate } from '../fx/haptics'
import { playSound, soundForGesture } from '../fx/sound'
import {
  DEFAULT_SETTINGS,
  MAX_PLAYERS,
  type LevelResult,
  type LevelSpec,
  type Player,
  type PlayerId,
  type PodiumEntry,
  type ProgressTick,
  type RoomCode,
  type RoomPhase,
  type RoomSettings,
  type RoomState,
  type ServerMessage,
  type SolutionClaim,
  sanitizeName,
} from './protocol'
import { canStartMatch, isSyncedMode } from './match'
import {
  type PartyClient,
  type PartyClientStatus,
  type Rejection,
  type RejectionCode,
  createPartyClient,
  createRoom as createRoomOnServer,
  lookupRoom,
  rejectionMessage,
} from './client'
import { partyHost } from './connection'

/**
 * How a multiplayer board differs from a single-player one.
 *
 * Power-ups are off. A reveal places a cat for free and a hint is a solver
 * speaking out loud; either one in a race is not a power-up but a cheat code,
 * and a mode where the fastest player is the one who spent their hints first
 * is not a puzzle game. Lives are more generous than single-player's three
 * instead: in a race the real cost of a wrong guess is the seconds it took and
 * the cell it burned, and a player knocked out of a match by a mis-tap on a
 * phone has been failed by the game rather than beaten by anyone.
 */
export const MULTIPLAYER_LIVES = 5

/** Cats placed by one player on one level, as most recently reported. */
export type ProgressSample = {
  levelIndex: number
  cats: number
}

/** A solve this client has claimed and the server has verified. */
export type AcceptedSolve = {
  levelIndex: number
  /** Server-measured milliseconds. The only time that counts. */
  elapsedMs: number
}

/** The two single-player settings a multiplayer board honours. */
export type MultiplayerPreferences = {
  autoX: boolean
  sound: boolean
  haptics: boolean
}

export type MultiplayerStore = {
  // ---- transport -------------------------------------------------------
  status: PartyClientStatus
  /** Why the room refused us, or null. Survives the socket closing. */
  rejection: Rejection | null
  /** A non-fatal complaint from the server, for a transient toast. */
  notice: string | null
  /** Add to a local timestamp to get the server's. */
  serverOffsetMs: number
  /** Round trip in milliseconds, or null before the first heartbeat. */
  rttMs: number | null

  // ---- identity --------------------------------------------------------
  playerId: PlayerId | null
  name: string

  // ---- the room, flattened --------------------------------------------
  /** The last full snapshot, for anything the flattened fields do not cover. */
  room: RoomState | null
  code: RoomCode | null
  phase: RoomPhase
  hostId: PlayerId | null
  settings: RoomSettings
  players: Player[]
  levelCount: number
  schedule: LevelSpec[] | null
  /** The room's current level. In blaze this is the leader's, not necessarily mine. */
  levelIndex: number
  phaseStartedAt: number
  phaseEndsAt: number | null
  results: LevelResult[]
  podium: PodiumEntry[] | null

  /** Latest progress per player, updated between snapshots by progress ticks. */
  progress: Record<PlayerId, ProgressSample>

  // ---- my board --------------------------------------------------------
  /** The level index of the board in front of me. Diverges from the room's in blaze. */
  myLevelIndex: number
  level: Level | null
  game: GameState | null
  loadingLevel: boolean
  levelError: string | null
  /** Local epoch ms at which my current board appeared, for the on-screen timer. */
  levelStartedAt: number | null
  /** Server epoch ms after which an unsolved board is a timeout; null in blaze. */
  levelDeadlineAt: number | null
  /** Server epoch ms the whole match must finish by, or null. */
  matchStartsAt: number | null
  accepted: AcceptedSolve | null
  /** The most recent level result, for the interlude screen. */
  lastResult: LevelResult | null

  preferences: MultiplayerPreferences

  // ---- actions ---------------------------------------------------------
  setPreferences: (preferences: Partial<MultiplayerPreferences>) => void
  /** Mints a code on the server and connects to it as host. */
  hostRoom: (name: string) => Promise<RoomCode | null>
  /** Checks the code exists and has room, then connects. */
  joinRoom: (code: RoomCode, name: string) => Promise<boolean>
  /** Leaves the room and clears everything local. */
  leaveRoom: () => void
  /** Retries a dropped connection now. */
  retry: () => void
  rename: (name: string) => void
  /** Host only; the server rejects it from anyone else. */
  updateSettings: (settings: RoomSettings) => void
  /** Host only. */
  startMatch: () => void
  /** Skips the rest of an interlude once everyone has said so. */
  markReady: () => void
  /**
   * Asks a finished room to go back to its lobby so another match can be set
   * up. Any player in the room may; the server ignores it in any other phase.
   */
  rematch: () => void
  dispatch: (action: GameAction) => void
  dismissNotice: () => void
  /** Drops all multiplayer state. Called on leaving and by tests. */
  reset: () => void
}

const EMPTY_PLAYERS: Player[] = []
const EMPTY_RESULTS: LevelResult[] = []
const EMPTY_PROGRESS: Record<PlayerId, ProgressSample> = {}

const initialState = {
  status: 'idle' as PartyClientStatus,
  rejection: null,
  notice: null,
  serverOffsetMs: 0,
  rttMs: null,
  playerId: null,
  name: '',
  room: null,
  code: null,
  phase: 'lobby' as RoomPhase,
  hostId: null,
  settings: DEFAULT_SETTINGS,
  players: EMPTY_PLAYERS,
  levelCount: 0,
  schedule: null,
  levelIndex: -1,
  phaseStartedAt: 0,
  phaseEndsAt: null,
  results: EMPTY_RESULTS,
  podium: null,
  progress: EMPTY_PROGRESS,
  myLevelIndex: -1,
  level: null,
  game: null,
  loadingLevel: false,
  levelError: null,
  levelStartedAt: null,
  levelDeadlineAt: null,
  matchStartsAt: null,
  accepted: null,
  lastResult: null,
  preferences: { autoX: false, sound: true, haptics: true } as MultiplayerPreferences,
} satisfies Omit<
  MultiplayerStore,
  | 'setPreferences'
  | 'hostRoom'
  | 'joinRoom'
  | 'leaveRoom'
  | 'retry'
  | 'rename'
  | 'updateSettings'
  | 'startMatch'
  | 'markReady'
  | 'rematch'
  | 'dispatch'
  | 'dismissNotice'
  | 'reset'
>

/**
 * The columns a solved board actually has cats in.
 *
 * Read off the cells rather than copied from `level.solution`, so the claim is
 * a statement about what the player did. The two agree on a solved board — the
 * reducer only ever places a cat on a correct cell — which is exactly why
 * reading the board costs nothing and says more.
 */
const claimedColumns = (game: GameState): number[] => {
  const cols: number[] = []
  for (let row = 0; row < game.size; row++) {
    let found = 0
    for (let col = 0; col < game.size; col++) {
      if (game.cells[toIndex(game.size, row, col)] === CellState.Cat) {
        found = col
        break
      }
    }
    cols.push(found)
  }
  return cols
}

export const useMultiplayerStore = create<MultiplayerStore>((set, get) => {
  /**
   * The live connection, held outside the store.
   *
   * A socket is not state a component should ever be able to select, and
   * keeping it out means no render can be triggered by it.
   */
  let client: PartyClient | null = null
  let unsubscribe: (() => void) | null = null

  /** Guards against an older level generation landing after a newer one. */
  let levelToken = 0
  /** Last progress figure actually put on the wire, so ticks only go out on change. */
  let sentProgress = -1
  /** A claim made but not yet acknowledged, so a reconnect can re-assert it. */
  let pendingClaim: SolutionClaim | null = null

  const teardownClient = (options?: { leave?: boolean }): void => {
    unsubscribe?.()
    unsubscribe = null
    client?.close(options ?? {})
    client = null
    levelToken++
    sentProgress = -1
    pendingClaim = null
  }

  /**
   * Forgets the board and everything else scoped to one match.
   *
   * A room outlives its matches, so this has to be a real erasure rather than a
   * tidy-up. `openLevelAt` skips a level it believes is already open, and it
   * decides that by comparing level numbers — so a board left behind by the
   * previous match would be reused, already solved, if the next match's
   * schedule happened to repeat one of its level numbers.
   */
  const clearLocalMatch = (): void => {
    levelToken++
    sentProgress = -1
    pendingClaim = null
    set({
      myLevelIndex: -1,
      level: null,
      game: null,
      loadingLevel: false,
      levelError: null,
      levelStartedAt: null,
      levelDeadlineAt: null,
      matchStartsAt: null,
      accepted: null,
      lastResult: null,
    })
  }

  /** Flattens a server snapshot into the fields selectors read. */
  const applyRoomState = (state: RoomState): void => {
    // A room that has gone back to its lobby has thrown its match away, and so
    // must this client: the board in front of the player belongs to a match
    // that no longer exists, and the standings beside it are already zeroed.
    if (state.phase === 'lobby' && get().phase !== 'lobby') clearLocalMatch()
    set({
      room: state,
      code: state.code,
      phase: state.phase,
      hostId: state.hostId,
      settings: state.settings,
      players: state.players,
      levelCount: state.levelCount,
      schedule: state.schedule,
      levelIndex: state.levelIndex,
      phaseStartedAt: state.phaseStartedAt,
      phaseEndsAt: state.phaseEndsAt,
      results: state.results,
      podium: state.podium,
      // A snapshot is the authority on where everyone is, so it replaces the
      // tick-by-tick map rather than merging into it: a player who left is gone
      // from `players` and should be gone from the bars too.
      progress: Object.fromEntries(
        state.players.map((player) => [
          player.id,
          { levelIndex: player.levelIndex, cats: player.progress },
        ]),
      ),
      // Only a snapshot's own clock is a fresh reading; a pong refines it.
      serverOffsetMs: state.serverTime > 0 ? state.serverTime - Date.now() : get().serverOffsetMs,
    })
  }

  /**
   * Generates and opens the board for a schedule slot.
   *
   * Idempotent on the level already in play, which is what makes a reconnect
   * resume rather than restart: the board is local, so a player who drops and
   * returns mid-level finds their cells exactly where they left them.
   *
   * Opening a *different* level drops the old board in the same breath as it
   * moves `myLevelIndex`, and that pairing is load-bearing. Generating a level
   * is always asynchronous — even a cache hit resolves a promise — so between
   * the two there is at least one render, and anything reading the pair would
   * otherwise see the new level's number beside the old level's cells. For the
   * board that is a flicker; for the progress bar, which is cats over board
   * size, it is a full bar at the moment the player has placed nothing. "Not
   * started" is the truth while a board is being built, so nothing is left
   * behind for it to be read from.
   */
  const openLevelAt = async (levelIndex: number): Promise<void> => {
    const { schedule, preferences, game, myLevelIndex } = get()
    const spec = schedule?.[levelIndex]
    if (spec === undefined) return
    if (levelIndex === myLevelIndex && game !== null && game.levelNumber === spec.levelNumber)
      return

    const token = ++levelToken
    sentProgress = -1
    pendingClaim = null
    set({
      myLevelIndex: levelIndex,
      level: null,
      game: null,
      loadingLevel: true,
      levelError: null,
      levelStartedAt: null,
      accepted: null,
    })
    try {
      const level = await loadLevel(spec.levelNumber)
      if (token !== levelToken) return
      set({
        level,
        game: createGame(level, {
          lives: MULTIPLAYER_LIVES,
          reveals: 0,
          hints: 0,
          autoX: preferences.autoX,
        }),
        loadingLevel: false,
        levelStartedAt: Date.now(),
      })
      // The next board is generated while this one is being solved, so no
      // player ever meets a spinner between levels.
      const next = schedule?.[levelIndex + 1]
      if (next) void loadLevel(next.levelNumber).catch(() => {})
    } catch (error) {
      if (token !== levelToken) return
      set({
        loadingLevel: false,
        levelError: error instanceof Error ? error.message : 'Could not build that puzzle',
      })
    }
  }

  /** Turns the reducer's event stamp into a cue and a pulse, once per event. */
  const announce = (action: GameAction, previous: GameState, next: GameState): void => {
    if (next.event === 'none' || previous.eventSeq === next.eventSeq) return
    const { sound, haptics } = get().preferences
    const cue = soundForGesture(action, next.event)
    if (cue !== null) playSound(cue, sound)
    const pattern = hapticForGesture(action, next.event)
    if (pattern !== null) vibrate(pattern, haptics)
  }

  /** Sends a progress tick, but only when the number of cats has actually moved. */
  const reportProgress = (game: GameState): void => {
    const cats = catIndices(game.cells).length
    if (cats === sentProgress) return
    if (client?.send({ t: 'progress', cats }) === true) sentProgress = cats
  }

  const claimSolution = (game: GameState): void => {
    const { myLevelIndex, levelStartedAt } = get()
    if (myLevelIndex < 0) return
    const claim: SolutionClaim = { levelIndex: myLevelIndex, cols: claimedColumns(game) }
    pendingClaim = claim
    const clientMs = levelStartedAt === null ? 0 : Math.max(0, Date.now() - levelStartedAt)
    client?.send({ t: 'solved', claim, clientMs })
  }

  const handleMessage = (message: ServerMessage): void => {
    switch (message.t) {
      case 'welcome': {
        set({ playerId: message.you })
        applyRoomState(message.state)
        // A claim that was in flight when the connection dropped never reached
        // the server, and the player has already earned it. Re-asserting it is
        // the difference between a blip costing a moment and costing the level.
        if (pendingClaim !== null && get().accepted === null) {
          client?.send({ t: 'solved', claim: pendingClaim, clientMs: 0 })
        }
        const index = message.state.levelIndex
        if (message.state.phase === 'playing' && index >= 0) void openLevelAt(index)
        break
      }
      case 'state':
        applyRoomState(message.state)
        break
      case 'countdown':
        set({ matchStartsAt: message.startsAt })
        break
      case 'match': {
        // A schedule is published once per match, so this frame is the one
        // unambiguous "a new match is starting" signal there is — including
        // when a room goes straight from a podium into another match without
        // passing through its lobby.
        clearLocalMatch()
        set({
          schedule: message.schedule,
          levelCount: message.levelCount,
          matchStartsAt: message.startsAt,
          podium: null,
          lastResult: null,
        })
        // Warmed during the countdown, so the first level starts on time.
        const first = message.schedule[0]
        if (first) void loadLevel(first.levelNumber).catch(() => {})
        break
      }
      case 'level':
        set({ levelDeadlineAt: message.deadlineAt, lastResult: null })
        void openLevelAt(message.levelIndex)
        break
      case 'accepted': {
        pendingClaim = null
        set({ accepted: { levelIndex: message.levelIndex, elapsedMs: message.elapsedMs } })
        // Blaze has no synchronised level start: an accepted solve is itself
        // the starting gun for the next board, and every player hears their own.
        const { settings, schedule } = get()
        if (!isSyncedMode(settings)) {
          const next = message.levelIndex + 1
          if (schedule !== null && next < schedule.length) void openLevelAt(next)
        }
        break
      }
      case 'progress': {
        const merged = { ...get().progress }
        for (const tick of message.ticks) {
          const [playerId, levelIndex, cats]: ProgressTick = tick
          merged[playerId] = { levelIndex, cats }
        }
        set({ progress: merged })
        break
      }
      case 'result':
        set({ lastResult: message.result })
        break
      case 'finished':
        set({ podium: message.podium, phase: 'finished' })
        break
      case 'error':
        // Fatal codes have already become a rejection inside the client; what
        // reaches here is something the player can shrug off.
        set({ notice: message.message })
        break
      case 'pong':
        break
    }
  }

  const connect = (code: RoomCode, name: string): void => {
    teardownClient()
    const next = createPartyClient({ room: code, name })
    client = next
    unsubscribe = next.subscribe((event) => {
      if (event.kind === 'status') set({ status: event.status, rejection: event.rejection })
      else if (event.kind === 'clock')
        set({ serverOffsetMs: event.clock.offsetMs, rttMs: event.clock.rttMs })
      else handleMessage(event.message)
    })
    set({ code, name, status: next.status(), rejection: next.rejection() })
  }

  const refuse = (reason: RejectionCode): void => {
    set({ status: 'rejected', rejection: { code: reason, message: rejectionMessage(reason) } })
  }

  return {
    ...initialState,

    setPreferences: (preferences) => {
      const next = { ...get().preferences, ...preferences }
      set({ preferences: next })
      // Auto-marking is a property of the board in play, so a mid-match change
      // has to reach the reducer rather than only the next level.
      const game = get().game
      if (game !== null && game.autoX !== next.autoX) {
        set({ game: reduce(game, { type: 'setAutoX', value: next.autoX }) })
      }
    },

    hostRoom: async (rawName) => {
      const name = sanitizeName(rawName)
      if (partyHost() === null) {
        refuse('no-party-host')
        return null
      }
      set({ status: 'connecting', rejection: null, name })
      const minted = await createRoomOnServer()
      if (!minted.ok) {
        set({ status: 'rejected', rejection: { code: minted.reason, message: minted.message } })
        return null
      }
      connect(minted.code, name)
      return minted.code
    },

    joinRoom: async (code, rawName) => {
      const name = sanitizeName(rawName)
      if (partyHost() === null) {
        refuse('no-party-host')
        return false
      }
      set({ status: 'connecting', rejection: null, name })
      // Asked before the socket, because PartyKit creates a room on connection
      // rather than refusing an unknown one: without this, a mistyped code
      // would silently open an empty room of its own.
      const found = await lookupRoom(code)
      if (!found.ok) {
        set({ status: 'rejected', rejection: { code: found.reason, message: found.message } })
        return false
      }
      connect(code, name)
      return true
    },

    leaveRoom: () => {
      teardownClient({ leave: true })
      set({ ...initialState, preferences: get().preferences })
    },

    retry: () => {
      set({ notice: null })
      client?.reconnect()
    },

    rename: (rawName) => {
      const name = sanitizeName(rawName)
      if (name.length === 0) return
      set({ name })
      client?.send({ t: 'name', name })
    },

    updateSettings: (settings) => {
      client?.send({ t: 'settings', settings })
    },

    startMatch: () => {
      client?.send({ t: 'start' })
    },

    markReady: () => {
      client?.send({ t: 'ready' })
    },

    rematch: () => {
      client?.send({ t: 'rematch' })
    },

    dispatch: (action) => {
      const previous = get().game
      if (previous === null) return
      const next = reduce(previous, action)
      if (next === previous) return
      set({ game: next })
      announce(action, previous, next)
      reportProgress(next)
      // 'winning' is the animation window; the claim goes out the moment the
      // board is decided rather than when the confetti stops, because the
      // server is timing this to the millisecond.
      if (next.status === 'winning' && previous.status !== 'winning') claimSolution(next)
    },

    dismissNotice: () => set({ notice: null }),

    reset: () => {
      teardownClient()
      set({ ...initialState, preferences: get().preferences })
    },
  }
})

// ---------------------------------------------------------------------------
// Selectors.
//
// Zustand 5 compares with `Object.is`, so a selector that builds an object or
// an array returns something new on every store write and re-renders its
// component every time anything at all changes. Every selector below returns
// either a primitive or a reference the store already holds.
// ---------------------------------------------------------------------------

export const selectStatus = (state: MultiplayerStore): PartyClientStatus => state.status
export const selectRejection = (state: MultiplayerStore): Rejection | null => state.rejection
export const selectPhase = (state: MultiplayerStore): RoomPhase => state.phase
export const selectCode = (state: MultiplayerStore): RoomCode | null => state.code
export const selectPlayers = (state: MultiplayerStore): Player[] => state.players
export const selectSettings = (state: MultiplayerStore): RoomSettings => state.settings
export const selectGame = (state: MultiplayerStore): GameState | null => state.game
export const selectLevel = (state: MultiplayerStore): Level | null => state.level
export const selectPodium = (state: MultiplayerStore): PodiumEntry[] | null => state.podium
export const selectLastResult = (state: MultiplayerStore): LevelResult | null => state.lastResult

/** The player object for this client, straight out of the players array. */
export const selectMe = (state: MultiplayerStore): Player | null =>
  state.players.find((player) => player.id === state.playerId) ?? null

export const selectIsHost = (state: MultiplayerStore): boolean =>
  state.playerId !== null && state.playerId === state.hostId

/**
 * True when the host may start a match right now.
 *
 * Who is allowed lives in `canStartMatch` so the button and the server agree; a
 * lobby that offers Start when the server would refuse it is worse than one
 * that greys the button out a moment too long.
 *
 * Two phases qualify, not one. A room outlives its matches: the server accepts
 * a start from a finished room exactly as it does from a lobby, and gating on
 * `lobby` alone is what made a podium a dead end for the whole room.
 */
export const selectCanStart = (state: MultiplayerStore): boolean =>
  (state.phase === 'lobby' || state.phase === 'finished') &&
  canStartMatch(state.settings, state.players).ok

/**
 * True when this client can ask the room for another match.
 *
 * Any seated player may ask, not only the host: the podium is on everybody's
 * screen, and a host who has put their phone down would otherwise strand the
 * room on it. Only from a finished match, because that is the only phase the
 * server acts on — and only over a live connection, because a button whose
 * message is silently dropped is worse than no button at all.
 */
export const selectCanRematch = (state: MultiplayerStore): boolean =>
  state.phase === 'finished' && state.playerId !== null && state.status === 'connected'

export const selectIsFull = (state: MultiplayerStore): boolean =>
  state.players.length >= MAX_PLAYERS

/** Cats placed by one player, for their bar. Returns a number, so it is stable. */
export const selectProgressOf =
  (playerId: PlayerId) =>
  (state: MultiplayerStore): number =>
    state.progress[playerId]?.cats ?? 0

/** The level a player is on, which in blaze is how far ahead they are. */
export const selectLevelIndexOf =
  (playerId: PlayerId) =>
  (state: MultiplayerStore): number =>
    state.progress[playerId]?.levelIndex ?? state.levelIndex

/** Board size for a player's current level, so their bar can be scaled. */
export const selectBoardSizeOf =
  (playerId: PlayerId) =>
  (state: MultiplayerStore): number => {
    const index = state.progress[playerId]?.levelIndex ?? state.levelIndex
    return state.schedule?.[index]?.size ?? state.level?.size ?? 0
  }

/**
 * Who is winning right now: furthest through the schedule, then most cats down.
 *
 * Recomputed on every read rather than stored, because it is a fold over at
 * most eight small records and storing it would mean keeping it in step with
 * two different message types.
 */
export const selectLeaderId = (state: MultiplayerStore): PlayerId | null => {
  let leader: PlayerId | null = null
  let bestLevel = -1
  let bestCats = -1
  for (const player of state.players) {
    if (player.eliminatedAtLevel !== null) continue
    const sample = state.progress[player.id]
    const levelIndex = sample?.levelIndex ?? player.levelIndex
    const cats = sample?.cats ?? player.progress
    if (levelIndex > bestLevel || (levelIndex === bestLevel && cats > bestCats)) {
      leader = player.id
      bestLevel = levelIndex
      bestCats = cats
    }
  }
  return leader
}

/** Cats this client has placed, straight off the local board. */
export const selectMyProgress = (state: MultiplayerStore): number =>
  state.game === null ? 0 : catIndices(state.game.cells).length

// ---------------------------------------------------------------------------
// Clock helpers.
//
// Every timestamp on the wire is the server's. These convert, and they are
// plain functions rather than store state so a component can call them inside
// its own animation frame without the store re-rendering anything.
// ---------------------------------------------------------------------------

/** A server timestamp as a local one. */
export const toLocalTime = (serverMs: number, offsetMs: number): number => serverMs - offsetMs

/** Milliseconds left until a server deadline, floored at zero. */
export const remainingMs = (
  serverDeadlineMs: number | null,
  offsetMs: number,
  now = Date.now(),
): number => (serverDeadlineMs === null ? 0 : Math.max(0, serverDeadlineMs - offsetMs - now))
