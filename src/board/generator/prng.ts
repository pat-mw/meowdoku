/**
 * Deterministic pseudo-randomness for level generation.
 *
 * Every operation here is 32-bit integer arithmetic (`Math.imul`, `>>> 0`) so
 * the same seed yields the same stream on every engine, every platform and
 * every future build. Nothing in the generator may call `Math.random`, use
 * float arithmetic to make a choice, or rely on `Array.prototype.sort` for a
 * seeded shuffle — those are the three ways this guarantee usually breaks.
 */

/** FNV-1a over UTF-16 code units. Stable across engines. */
export const hashString = (input: string): number => {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** SplitMix32 finalizer: expands one word of entropy into a well-mixed word. */
export const splitmix32 = (seed: number): number => {
  let a = (seed + 0x9e3779b9) | 0
  a ^= a >>> 16
  a = Math.imul(a, 0x21f0aaad)
  a ^= a >>> 15
  a = Math.imul(a, 0x735a2d97)
  a ^= a >>> 15
  return a >>> 0
}

/**
 * Mixes a seed with a counter to produce an independent sub-seed. The
 * generator's retry loop uses this so attempt k is reproducible on its own,
 * rather than depending on how much of the stream earlier attempts consumed.
 */
export const deriveSeed = (seed: number, counter: number): number =>
  splitmix32((splitmix32(seed) ^ Math.imul(counter + 1, 0x9e3779b9)) >>> 0)

const rotl = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0

/** xoshiro128** — small, fast, and good enough for puzzle shape. */
export class Rng {
  private s0: number
  private s1: number
  private s2: number
  private s3: number

  constructor(seed: number) {
    // Expand one seed word into four state words; reject the all-zero state,
    // which xoshiro cannot escape.
    let x = seed >>> 0
    this.s0 = x = splitmix32(x)
    this.s1 = x = splitmix32(x)
    this.s2 = x = splitmix32(x)
    this.s3 = splitmix32(x)
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 0x9e3779b9
  }

  /** Next 32-bit unsigned integer. */
  nextU32(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0
    const t = (this.s1 << 9) >>> 0
    this.s2 ^= this.s0
    this.s3 ^= this.s1
    this.s1 ^= this.s2
    this.s0 ^= this.s3
    this.s2 ^= t
    this.s3 = rotl(this.s3, 11)
    this.s0 >>>= 0
    this.s1 >>>= 0
    this.s2 >>>= 0
    this.s3 >>>= 0
    return result
  }

  /**
   * Uniform integer in [0, bound). Rejection-sampled rather than taken modulo,
   * so small boards do not inherit a bias toward low columns.
   */
  nextInt(bound: number): number {
    if (bound <= 1) return 0
    const limit = 0x100000000 - (0x100000000 % bound)
    let v = this.nextU32()
    while (v >= limit) v = this.nextU32()
    return v % bound
  }

  /** Uniform integer in [min, max], inclusive. */
  nextRange(min: number, max: number): number {
    return min + this.nextInt(max - min + 1)
  }

  /** True with probability `numerator / denominator`. */
  chance(numerator: number, denominator: number): boolean {
    return this.nextInt(denominator) < numerator
  }

  /** Fisher-Yates, in place. The only sanctioned way to shuffle in the generator. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.nextInt(i + 1)
      const a = items[i] as T
      items[i] = items[j] as T
      items[j] = a
    }
    return items
  }

  /** Picks one element. Callers must guarantee a non-empty array. */
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T
  }
}

/** The Rng for level N under a given generator version. */
export const rngForLevel = (seedString: string, attempt: number): Rng =>
  new Rng(deriveSeed(hashString(seedString), attempt))
