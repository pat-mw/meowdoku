import { describe, expect, it } from 'vitest'
import { TokenBucket, commandBucket, progressBucket } from '../lib/rateLimit'
import { PROGRESS_TICK_INTERVAL_MS } from '../../src/multiplayer/protocol'

describe('TokenBucket', () => {
  it('starts full, so a burst is not punished', () => {
    const bucket = new TokenBucket(5, 1, 0)
    for (let i = 0; i < 5; i++) expect(bucket.take(0)).toBe(true)
    expect(bucket.take(0)).toBe(false)
  })

  it('refills at the stated rate', () => {
    const bucket = new TokenBucket(5, 10, 0)
    for (let i = 0; i < 5; i++) bucket.take(0)
    expect(bucket.take(99)).toBe(false)
    expect(bucket.take(100)).toBe(true)
  })

  it('never refills past its capacity', () => {
    const bucket = new TokenBucket(3, 100, 0)
    expect(bucket.tokens(60_000)).toBe(3)
  })

  it('ignores a clock that goes backwards', () => {
    const bucket = new TokenBucket(2, 1, 1000)
    expect(bucket.take(1000)).toBe(true)
    expect(bucket.take(0)).toBe(true)
    expect(bucket.take(0)).toBe(false)
  })

  it('treats a capacity below one as one', () => {
    const bucket = new TokenBucket(0, 1, 0)
    expect(bucket.capacity).toBe(1)
    expect(bucket.take(0)).toBe(true)
    expect(bucket.take(0)).toBe(false)
  })
})

describe('the room budgets', () => {
  it('lets a fast player report every cat they place', () => {
    // A 9x9 is the largest multiplayer board, so nine placements is a whole
    // level's worth of progress. Doing it inside one tick interval must not be
    // throttled, or the bar would lag the player who is actually winning.
    const bucket = progressBucket(0)
    for (let i = 0; i < 9; i++) expect(bucket.take(i)).toBe(true)
    expect(bucket.tokens(PROGRESS_TICK_INTERVAL_MS)).toBeGreaterThan(9)
  })

  it('absorbs a long burst of progress and then throttles it', () => {
    const bucket = progressBucket(0)
    let accepted = 0
    for (let i = 0; i < 200; i++) if (bucket.take(0)) accepted += 1
    expect(accepted).toBe(40)
  })

  it('leaves room for the commands a player sends in a normal level', () => {
    // join, a settings change, a start, a ready and a solve, with headroom for
    // a client that retries a claim it thinks was lost.
    const bucket = commandBucket(0)
    for (let i = 0; i < 10; i++) expect(bucket.take(i * 100)).toBe(true)
  })

  it('throttles a command flood', () => {
    const bucket = commandBucket(0)
    let accepted = 0
    for (let i = 0; i < 500; i++) if (bucket.take(0)) accepted += 1
    expect(accepted).toBe(20)
  })
})
