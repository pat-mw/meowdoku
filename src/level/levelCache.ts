import { get as idbGet, set as idbSet } from 'idb-keyval'
import type { Level } from '../board/types'
import { levelCacheKey } from '../board/generator/version'

/**
 * A durable cache of generated levels.
 *
 * Generation is deterministic, so a cached level is always the same level the
 * generator would produce again — the cache only ever saves work, never changes
 * an answer. Entries are keyed by generator version, so a version bump leaves
 * the old entries harmlessly unreferenced rather than serving a stale puzzle.
 *
 * A small in-memory layer sits in front so a level revisited within a session
 * costs nothing at all.
 */

const memory = new Map<string, Level>()

/** Bounded so a long play session cannot grow the map without limit. */
const MEMORY_LIMIT = 64

const remember = (key: string, level: Level): void => {
  if (memory.size >= MEMORY_LIMIT) {
    const oldest = memory.keys().next()
    if (!oldest.done) memory.delete(oldest.value)
  }
  memory.set(key, level)
}

const looksLikeLevel = (value: unknown): value is Level => {
  if (typeof value !== 'object' || value === null) return false
  const level = value as Partial<Level>
  return (
    typeof level.number === 'number' &&
    typeof level.size === 'number' &&
    Array.isArray(level.regions) &&
    level.regions.length === level.size &&
    Array.isArray(level.solution) &&
    level.solution.length === level.size
  )
}

export const readCachedLevel = async (
  version: number,
  levelNumber: number,
): Promise<Level | null> => {
  const key = levelCacheKey(version, levelNumber)
  const inMemory = memory.get(key)
  if (inMemory) return inMemory
  try {
    const stored: unknown = await idbGet(key)
    if (!looksLikeLevel(stored)) return null
    remember(key, stored)
    return stored
  } catch {
    return null
  }
}

export const writeCachedLevel = async (level: Level): Promise<void> => {
  const key = levelCacheKey(level.generatorVersion, level.number)
  remember(key, level)
  try {
    await idbSet(key, level)
  } catch {
    // A cache that will not persist just means the worker regenerates later.
  }
}

/** Used by tests and by Reset progress, which should not leave puzzles behind. */
export const clearLevelMemoryCache = (): void => memory.clear()
