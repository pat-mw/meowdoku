import type { Stars } from '../board/score'

/**
 * The on-device save file.
 *
 * Levels are procedural and unbounded, so completion is keyed by level number
 * as a decimal string and nothing anywhere records a total. An in-progress
 * board records the generator version that produced it, so a version bump
 * cannot silently hand the player a different puzzle than the one they left.
 */

export const SAVE_SCHEMA_VERSION = 1

export type Settings = {
  sound: boolean
  haptics: boolean
  colorBlind: boolean
  autoX: boolean
  /**
   * Whether to use the dark theme. A fresh install takes its starting value
   * from the device's own colour-scheme preference rather than this default, so
   * a player whose phone is dark is not handed a cream screen at midnight; from
   * the first time they touch the toggle it is theirs.
   */
  darkMode: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  sound: true,
  haptics: true,
  colorBlind: false,
  autoX: false,
  darkMode: false,
}

export type CompletedLevel = {
  stars: Stars
  score: number
  completedAt: number
}

export type InProgress = {
  levelNumber: number
  generatorVersion: number
  /** One digit per cell, row-major, using the CellState numbering. */
  cells: string
  lives: number
  revealsLeft: number
  hintsLeft: number
  livesLost: number
  powerUsed: number
  startedAt: number
}

export type SaveFile = {
  schemaVersion: number
  /** The highest level the player has unlocked. Progress unlocks strictly in order. */
  currentLevel: number
  /** Keyed by level number as a decimal string. */
  completed: Record<string, CompletedLevel>
  inProgress: InProgress | null
  settings: Settings
  lifetimeScore: number
  /** Wall-clock of the last write, used to pick a winner between the two stores. */
  savedAt: number
}

export const freshSave = (now: number): SaveFile => ({
  schemaVersion: SAVE_SCHEMA_VERSION,
  currentLevel: 1,
  completed: {},
  inProgress: null,
  settings: { ...DEFAULT_SETTINGS },
  lifetimeScore: 0,
  savedAt: now,
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const num = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

const bool = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback

const clampStars = (value: unknown): Stars => {
  const n = Math.trunc(num(value, 0))
  return n <= 0 ? 0 : n >= 3 ? 3 : (n as Stars)
}

const parseCompleted = (value: unknown): Record<string, CompletedLevel> => {
  if (!isRecord(value)) return {}
  const out: Record<string, CompletedLevel> = {}
  for (const [key, entry] of Object.entries(value)) {
    // Keys are level numbers. Anything else is from a foreign or corrupt file.
    if (!/^[1-9][0-9]{0,9}$/.test(key) || !isRecord(entry)) continue
    out[key] = {
      stars: clampStars(entry.stars),
      score: Math.max(0, Math.trunc(num(entry.score, 0))),
      completedAt: Math.max(0, Math.trunc(num(entry.completedAt, 0))),
    }
  }
  return out
}

const parseInProgress = (value: unknown): InProgress | null => {
  if (!isRecord(value)) return null
  const levelNumber = Math.trunc(num(value.levelNumber, 0))
  const cells = value.cells
  if (levelNumber < 1 || typeof cells !== 'string' || !/^[0-3]+$/.test(cells)) return null
  // A board is square, so the cell count must be a perfect square.
  const size = Math.round(Math.sqrt(cells.length))
  if (size < 2 || size * size !== cells.length) return null
  return {
    levelNumber,
    generatorVersion: Math.trunc(num(value.generatorVersion, 1)),
    cells,
    lives: Math.max(0, Math.trunc(num(value.lives, 3))),
    revealsLeft: Math.max(0, Math.trunc(num(value.revealsLeft, 0))),
    hintsLeft: Math.max(0, Math.trunc(num(value.hintsLeft, 0))),
    livesLost: Math.max(0, Math.trunc(num(value.livesLost, 0))),
    powerUsed: Math.max(0, Math.trunc(num(value.powerUsed, 0))),
    startedAt: Math.max(0, Math.trunc(num(value.startedAt, 0))),
  }
}

/**
 * Turns anything at all into a usable save file.
 *
 * A corrupt or foreign blob must never stop the game booting, so every field
 * falls back to its default rather than throwing. Returns null only when the
 * input is not an object, which lets the caller keep the original blob under a
 * backup key before overwriting it.
 */
export const parseSave = (raw: unknown, now: number): SaveFile | null => {
  if (!isRecord(raw)) return null
  const settings = isRecord(raw.settings) ? raw.settings : {}
  const completed = parseCompleted(raw.completed)
  const inProgress = parseInProgress(raw.inProgress)
  const currentLevel = Math.max(1, Math.trunc(num(raw.currentLevel, 1)))
  return {
    schemaVersion: SAVE_SCHEMA_VERSION,
    currentLevel,
    completed,
    inProgress,
    settings: {
      sound: bool(settings.sound, DEFAULT_SETTINGS.sound),
      haptics: bool(settings.haptics, DEFAULT_SETTINGS.haptics),
      colorBlind: bool(settings.colorBlind, DEFAULT_SETTINGS.colorBlind),
      autoX: bool(settings.autoX, DEFAULT_SETTINGS.autoX),
      darkMode: bool(settings.darkMode, DEFAULT_SETTINGS.darkMode),
    },
    lifetimeScore: Math.max(
      0,
      Math.trunc(
        num(
          raw.lifetimeScore,
          Object.values(completed).reduce((sum, entry) => sum + entry.score, 0),
        ),
      ),
    ),
    savedAt: Math.max(0, Math.trunc(num(raw.savedAt, now))),
  }
}

/**
 * Runs the migration chain. There is only one schema so far; when a second
 * arrives, add a step here rather than widening `parseSave`, and never drop
 * fields a future version might still want.
 */
export const migrateSave = (save: SaveFile): SaveFile => save

/** Total points earned, recomputed from the completion record. */
export const computeLifetimeScore = (completed: Record<string, CompletedLevel>): number =>
  Object.values(completed).reduce((sum, entry) => sum + entry.score, 0)
