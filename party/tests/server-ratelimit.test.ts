import { describe, expect, it } from 'vitest'
import {
  KeyedLimiter,
  ROOM_CREATE_BURST,
  TokenBucket,
  commandBucket,
  progressBucket,
  roomCreateBucket,
} from '../lib/rateLimit'
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

/**
 * Room creation is the one unauthenticated request that spends a shared
 * resource. Two thousand codes could be reserved in a few seconds from one
 * client, which took room creation down for everybody until the reservations
 * timed out. The budget below is what makes that a few dozen instead.
 */
describe('the room creation budget', () => {
  it('lets a person create a room, change their mind, and create another', () => {
    const bucket = roomCreateBucket(0)
    for (let i = 0; i < 5; i++) expect(bucket.take(i * 2000)).toBe(true)
  })

  it('cuts a flood off at the burst and then drips', () => {
    const bucket = roomCreateBucket(0)
    let accepted = 0
    for (let i = 0; i < 2000; i++) if (bucket.take(0)) accepted += 1
    expect(accepted).toBe(ROOM_CREATE_BURST)
    // A second later there is exactly one more, which is nobody's idea of a
    // way to exhaust a code space.
    expect(bucket.take(1000)).toBe(true)
    expect(bucket.take(1000)).toBe(false)
  })

  it('says how long the wait is, so a refusal can carry Retry-After', () => {
    const bucket = roomCreateBucket(0)
    for (let i = 0; i < ROOM_CREATE_BURST; i++) bucket.take(0)
    expect(bucket.waitMs(0)).toBe(1000)
    expect(bucket.waitMs(600)).toBe(400)
    expect(bucket.waitMs(1000)).toBe(0)
  })
})

describe('KeyedLimiter', () => {
  it('gives every caller their own budget', () => {
    const limiter = new KeyedLimiter((now) => new TokenBucket(2, 1, now))
    expect(limiter.take('1.1.1.1', 0)).toBe(true)
    expect(limiter.take('1.1.1.1', 0)).toBe(true)
    expect(limiter.take('1.1.1.1', 0)).toBe(false)
    // One caller running out must not refuse anybody else; that would turn the
    // limiter into the denial of service it exists to prevent.
    expect(limiter.take('2.2.2.2', 0)).toBe(true)
  })

  it('reports the wait for a caller it is holding back', () => {
    const limiter = new KeyedLimiter((now) => new TokenBucket(1, 2, now))
    limiter.take('1.1.1.1', 0)
    expect(limiter.take('1.1.1.1', 0)).toBe(false)
    expect(limiter.waitMs('1.1.1.1', 0)).toBe(500)
    // A caller it has never heard of waits for nothing.
    expect(limiter.waitMs('9.9.9.9', 0)).toBe(0)
  })

  it('forgets idle callers rather than growing without bound', () => {
    const limiter = new KeyedLimiter((now) => new TokenBucket(2, 10, now), 4)
    for (let i = 0; i < 100; i++) limiter.take(`caller-${i}`, i * 1000)
    expect(limiter.size).toBeLessThanOrEqual(4)
  })

  it('keeps holding back a caller who keeps knocking while others come and go', () => {
    const limiter = new KeyedLimiter((now) => new TokenBucket(2, 0.001, now), 4)
    expect(limiter.take('flooder', 0)).toBe(true)
    expect(limiter.take('flooder', 0)).toBe(true)
    expect(limiter.take('flooder', 0)).toBe(false)
    // Fresh callers arrive and are forgotten again; the one still spending is
    // the most recently seen, so eviction does not hand it a new budget.
    for (let i = 0; i < 20; i++) {
      limiter.take(`caller-${i}`, 10)
      expect(limiter.take('flooder', 10)).toBe(false)
    }
  })
})
