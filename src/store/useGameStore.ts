import { create } from 'zustand'
import type { Level } from '../board/types'
import type { GameAction, GameState } from '../board/reducer'
import { createGame, reduce, restoreGame, serializeGame } from '../board/reducer'
import { findHint } from '../board/hints'
import { GENERATOR_VERSION } from '../board/generator/version'
import { tierFor } from '../board/generator/tiers'
import { loadLevel, prefetchLevels } from '../level/levelClient'
import { HAPTICS, vibrate } from '../fx/haptics'
import { playSound, type SoundKind } from '../fx/sound'
import { requestPersistentStorage, type StoragePersistence } from '../pwa/storage'
import {
  type CompletedLevel,
  type SaveFile,
  type Settings,
  computeLifetimeScore,
  freshSave,
} from './save'
import { clearSave, createSaveScheduler, loadSave } from './persistence'
import { clearLevelMemoryCache } from '../level/levelCache'

/**
 * The whole app's mutable state: the save file, the puzzle in progress, and the
 * level currently loaded.
 *
 * The board reducer stays pure and knows nothing about storage or sound. This
 * store is the seam: it feeds gestures to the reducer, turns the resulting
 * event stamp into a sound and a haptic pulse, and schedules a debounced write
 * after every mutation.
 */

const saver = createSaveScheduler(100)

/** Which cue each reducer event plays. */
const EVENT_SOUND: Record<Exclude<GameState['event'], 'none'>, SoundKind> = {
  tick: 'tick',
  untick: 'untick',
  mew: 'mew',
  bonk: 'bonk',
  pop: 'pop',
  sparkle: 'sparkle',
  win: 'win',
  fail: 'fail',
}

const EVENT_HAPTIC: Partial<Record<GameState['event'], number | number[]>> = {
  tick: HAPTICS.tick,
  untick: HAPTICS.clear,
  pop: HAPTICS.hint,
  mew: HAPTICS.cat,
  sparkle: HAPTICS.cat,
  bonk: HAPTICS.wrong,
}

export type GameStore = {
  ready: boolean
  save: SaveFile
  storage: StoragePersistence
  level: Level | null
  game: GameState | null
  /** True while the worker is generating; the screen only shows a loader if it lasts. */
  loadingLevel: boolean
  loadError: string | null

  boot: () => Promise<void>
  openLevel: (levelNumber: number, options?: { resume?: boolean }) => Promise<void>
  restartLevel: () => void
  dispatch: (action: GameAction) => void
  requestHint: () => void
  requestReveal: () => void
  toggleSetting: (key: keyof Settings) => void
  applyImportedSave: (save: SaveFile) => Promise<void>
  resetProgress: () => Promise<void>
}

const now = (): number => Date.now()

export const useGameStore = create<GameStore>((set, get) => {
  /** Persists the save, folding in the board currently in progress. */
  const persist = (partial?: Partial<SaveFile>): SaveFile => {
    const state = get()
    const game = state.game
    const inProgress =
      game && game.status === 'playing'
        ? {
            ...serializeGame(game),
            generatorVersion: state.level?.generatorVersion ?? GENERATOR_VERSION,
            startedAt: state.save.inProgress?.startedAt ?? now(),
          }
        : null
    const next: SaveFile = { ...state.save, ...partial, inProgress, savedAt: now() }
    set({ save: next })
    saver.schedule(next)
    return next
  }

  /** Turns the reducer's event stamp into sound and haptics, once per event. */
  const announce = (previous: GameState | null, next: GameState): void => {
    if (next.event === 'none') return
    if (previous && previous.eventSeq === next.eventSeq) return
    const { sound, haptics } = get().save.settings
    playSound(EVENT_SOUND[next.event], sound)
    const pattern = EVENT_HAPTIC[next.event]
    if (pattern !== undefined) vibrate(pattern, haptics)
  }

  /** Records a completed level and unlocks the next one. */
  const recordWin = (game: GameState): void => {
    const state = get()
    const key = String(game.levelNumber)
    const previous = state.save.completed[key]
    const entry: CompletedLevel = {
      // A replay never takes a better result away.
      stars: previous && previous.stars > game.stars ? previous.stars : game.stars,
      score: previous && previous.score > game.score ? previous.score : game.score,
      completedAt: now(),
    }
    const completed = { ...state.save.completed, [key]: entry }
    persist({
      completed,
      lifetimeScore: computeLifetimeScore(completed),
      currentLevel: Math.max(state.save.currentLevel, game.levelNumber + 1),
    })
    // The next level is almost certainly where the player is going.
    prefetchLevels(game.levelNumber, tierFor(game.levelNumber + 1).prefetchDepth)
  }

  return {
    ready: false,
    save: freshSave(0),
    storage: 'unknown',
    level: null,
    game: null,
    loadingLevel: false,
    loadError: null,

    boot: async () => {
      const loaded = await loadSave(now())
      const save = loaded ?? freshSave(now())
      set({ save, ready: true })
      // Asking early means the grant is in place before the player has anything
      // worth losing.
      void requestPersistentStorage().then((storage) => set({ storage }))
    },

    openLevel: async (levelNumber, options) => {
      set({ loadingLevel: true, loadError: null })
      try {
        const level = await loadLevel(levelNumber)
        const save = get().save
        const settings = save.settings
        const saved = save.inProgress
        const resumable =
          options?.resume === true &&
          saved !== null &&
          saved.levelNumber === levelNumber &&
          saved.generatorVersion === level.generatorVersion

        const restored =
          resumable && saved ? restoreGame(level, saved, { autoX: settings.autoX }) : null
        const game = restored ?? createGame(level, { autoX: settings.autoX })
        set({ level, game, loadingLevel: false })
        if (!restored) persist()
        prefetchLevels(levelNumber, tierFor(levelNumber).prefetchDepth)
      } catch (error) {
        set({
          loadingLevel: false,
          loadError: error instanceof Error ? error.message : 'Could not build that puzzle',
        })
      }
    },

    restartLevel: () => {
      const { level, save } = get()
      if (!level) return
      set({ game: createGame(level, { autoX: save.settings.autoX }) })
      persist()
    },

    dispatch: (action) => {
      const previous = get().game
      if (!previous) return
      const next = reduce(previous, action)
      if (next === previous) return
      set({ game: next })
      announce(previous, next)
      if (next.status === 'winning' && previous.status !== 'winning') recordWin(next)
      else persist()
    },

    requestHint: () => {
      const game = get().game
      if (!game || game.hintsLeft <= 0 || game.status !== 'playing') return
      const hint = findHint(game)
      if (!hint) return
      get().dispatch({
        type: 'hint',
        cells: hint.cells,
        title: hint.title,
        message: hint.message,
        more: hint.more,
      })
    },

    requestReveal: () => get().dispatch({ type: 'reveal' }),

    toggleSetting: (key) => {
      const state = get()
      const settings = { ...state.save.settings, [key]: !state.save.settings[key] }
      set({ save: { ...state.save, settings } })
      // Switching a feedback setting on demonstrates it immediately, which is
      // both a nicety and the only way a player can tell whether their device
      // supports haptics at all.
      if (key === 'haptics' && settings.haptics) vibrate(HAPTICS.confirm, true)
      if (key === 'sound' && settings.sound) playSound('pop', true)
      if (key === 'autoX' && state.game) {
        set({ game: reduce(state.game, { type: 'setAutoX', value: settings.autoX }) })
      }
      persist({ settings })
    },

    applyImportedSave: async (save) => {
      const next: SaveFile = { ...save, savedAt: now() }
      set({ save: next, game: null, level: null })
      saver.schedule(next)
      saver.flush()
    },

    resetProgress: async () => {
      await clearSave()
      clearLevelMemoryCache()
      const save = freshSave(now())
      set({ save, game: null, level: null, loadError: null })
      saver.schedule(save)
      saver.flush()
    },
  }
})

/** Flushes any pending write. Called when the app is backgrounded or hidden. */
export const flushPendingSave = (): void => saver.flush()

let booting: Promise<void> | null = null

/**
 * Resolves once the save is loaded, booting it if nobody has yet.
 *
 * Route guards need this: a deep link is resolved before React has mounted, so
 * a guard that reads the store directly sees an empty save and waves every level
 * through. Awaiting here is safe because boot never rejects — a corrupt or
 * missing save falls back to a fresh one.
 */
export const ensureBooted = async (): Promise<void> => {
  if (useGameStore.getState().ready) return
  booting ??= useGameStore.getState().boot()
  await booting
}
