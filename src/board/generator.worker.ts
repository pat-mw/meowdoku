/// <reference lib="webworker" />
import type { Level } from './types'
import { generateLevel } from './generator'

/**
 * Level generation, off the main thread.
 *
 * Generating a hard 15x15 puzzle can take hundreds of milliseconds of solver
 * work across many rejected candidates, which would drop frames if it ran where
 * the board is rendered. The protocol is a plain `postMessage` pair rather than
 * an RPC library, because two message shapes do not justify a dependency.
 *
 * This is the one file under `src/board` allowed to touch a worker global; the
 * generator it calls stays pure.
 */

export type GenerateRequest = {
  id: number
  levelNumber: number
}

export type GenerateResponse =
  | { id: number; ok: true; level: Level }
  | { id: number; ok: false; error: string }

const scope = self as unknown as DedicatedWorkerGlobalScope

scope.addEventListener('message', (event: MessageEvent<GenerateRequest>) => {
  const { id, levelNumber } = event.data
  try {
    const level = generateLevel(levelNumber)
    const response: GenerateResponse = { id, ok: true, level }
    scope.postMessage(response)
  } catch (error) {
    const response: GenerateResponse = {
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
    scope.postMessage(response)
  }
})
