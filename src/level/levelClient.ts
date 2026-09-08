import type { Level } from '../board/types'
import type { GenerateRequest, GenerateResponse } from '../board/generator.worker'
import { GENERATOR_VERSION } from '../board/generator/version'
import { readCachedLevel, writeCachedLevel } from './levelCache'

/**
 * The main thread's handle on the generator worker.
 *
 * One worker serves the whole app. Requests are correlated by id so a prefetch
 * of level N+2 that finishes after the player has already asked for N+1 cannot
 * be mistaken for the answer to the wrong question.
 */

type Pending = {
  resolve: (level: Level) => void
  reject: (error: Error) => void
}

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, Pending>()
/** Requests already in flight, so a prefetch and a real request coalesce. */
const inFlight = new Map<number, Promise<Level>>()

const getWorker = (): Worker => {
  if (worker) return worker
  worker = new Worker(new URL('../board/generator.worker.ts', import.meta.url), { type: 'module' })
  worker.addEventListener('message', (event: MessageEvent<GenerateResponse>) => {
    const message = event.data
    const waiting = pending.get(message.id)
    if (!waiting) return
    pending.delete(message.id)
    if (message.ok) waiting.resolve(message.level)
    else waiting.reject(new Error(message.error))
  })
  worker.addEventListener('error', (event) => {
    const failure = new Error(event.message || 'The level generator stopped unexpectedly')
    for (const waiting of pending.values()) waiting.reject(failure)
    pending.clear()
    // Drop the handle so the next request starts a fresh worker rather than
    // queueing against a dead one.
    worker?.terminate()
    worker = null
  })
  return worker
}

const requestFromWorker = (levelNumber: number): Promise<Level> =>
  new Promise<Level>((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    const request: GenerateRequest = { id, levelNumber }
    getWorker().postMessage(request)
  })

/**
 * The level for a number: from memory, then from IndexedDB, then from the
 * worker. Concurrent callers for the same level share one generation.
 */
export const loadLevel = async (levelNumber: number): Promise<Level> => {
  const cached = await readCachedLevel(GENERATOR_VERSION, levelNumber)
  if (cached) return cached

  const existing = inFlight.get(levelNumber)
  if (existing) return existing

  const generation = requestFromWorker(levelNumber)
    .then(async (level) => {
      await writeCachedLevel(level)
      return level
    })
    .finally(() => {
      inFlight.delete(levelNumber)
    })

  inFlight.set(levelNumber, generation)
  return generation
}

/**
 * Warms the cache for the levels the player is most likely to open next, so
 * "Next level" never shows a loader. Failures are swallowed: a prefetch that
 * does not land simply means the real request generates it.
 */
export const prefetchLevels = (from: number, count: number): void => {
  for (let offset = 1; offset <= count; offset++) {
    void loadLevel(from + offset).catch(() => {})
  }
}

/** Releases the worker. Used when the app is being torn down in tests. */
export const disposeLevelClient = (): void => {
  worker?.terminate()
  worker = null
  pending.clear()
  inFlight.clear()
}
