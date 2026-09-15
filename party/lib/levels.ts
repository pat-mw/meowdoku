import { generateLevel } from '../../src/board/generator/index'
import { solutionMatches } from '../../src/multiplayer/match'

/**
 * The server's copy of the puzzle.
 *
 * A client that says "I finished in 4.2 seconds" has to prove it, and because
 * level N is a pure function of N and the generator version, proving it costs
 * the server nothing but the generation it can do itself. It builds the same
 * board from the same number and compares the claimed cat columns against the
 * one solution that board has. There is no scoring to re-derive and no way to
 * win by asserting.
 *
 * Generation is the only expensive thing the room does, so the vault exists to
 * make sure it happens at most once per level per room. Measured on the
 * multiplayer bands (levels 1-100, tiers 1-5, boards 5x5 to 9x9): a mean of
 * 1 ms on easy, 22 ms on standard and 12 ms on hard, with a worst case of
 * 113 ms at level 40. That is affordable once per level and unaffordable per
 * claim, which is why the cache is not an optimisation but a requirement, and
 * why `warm` is called during the countdown and each interlude rather than on
 * the first claim of a level — a pre-warmed level turns verification into an
 * array comparison at the exact moment eight players are racing to submit.
 *
 * The solver is injectable so the cache's behaviour can be tested without
 * paying generation cost, and the cache seeds from a stored snapshot so a room
 * that is evicted mid-match does not regenerate the levels it has already
 * played.
 */

/** Produces the one solution of a level: `cols[row]` is that row's cat column. */
export type LevelSolver = (levelNumber: number) => readonly number[]

const generateSolution: LevelSolver = (levelNumber) => generateLevel(levelNumber).solution

export type LevelVaultSnapshot = Record<string, number[]>

export class LevelVault {
  #solve: LevelSolver
  #cache = new Map<number, readonly number[]>()
  #generated = 0

  constructor(solve: LevelSolver = generateSolution, snapshot?: LevelVaultSnapshot) {
    this.#solve = solve
    for (const [key, cols] of Object.entries(snapshot ?? {})) {
      const levelNumber = Number(key)
      if (Number.isInteger(levelNumber) && Array.isArray(cols)) this.#cache.set(levelNumber, cols)
    }
  }

  /** How many levels this vault has actually generated, as opposed to recalled. */
  get generated(): number {
    return this.#generated
  }

  has(levelNumber: number): boolean {
    return this.#cache.has(levelNumber)
  }

  solutionFor(levelNumber: number): readonly number[] {
    const cached = this.#cache.get(levelNumber)
    if (cached) return cached
    const solution = this.#solve(levelNumber)
    this.#generated += 1
    this.#cache.set(levelNumber, solution)
    return solution
  }

  /** Generates a level ahead of the moment it is needed. Cheap when already cached. */
  warm(levelNumber: number | null | undefined): void {
    if (typeof levelNumber !== 'number') return
    this.solutionFor(levelNumber)
  }

  /** Whether a claim is the level's solution. The whole of completion checking. */
  verify(levelNumber: number, claim: readonly number[]): boolean {
    return solutionMatches(this.solutionFor(levelNumber), claim)
  }

  snapshot(): LevelVaultSnapshot {
    const out: LevelVaultSnapshot = {}
    for (const [levelNumber, cols] of this.#cache) out[String(levelNumber)] = [...cols]
    return out
  }
}
