/**
 * Per-connection message budgets.
 *
 * A room fans every accepted message out to eight sockets, so one client
 * sending faster than it should costs the room eight times what it costs
 * itself. A token bucket is the right shape for this traffic: progress arrives
 * in bursts as a player sweeps a row of cells and then stops entirely while
 * they think, and a bucket absorbs the burst without punishing the pause.
 *
 * Time is an argument, never `Date.now()`, so a bucket is a pure state machine
 * and its refill maths can be exercised without waiting for real seconds.
 */
export class TokenBucket {
  readonly capacity: number
  readonly refillPerMs: number
  #tokens: number
  #last: number

  constructor(capacity: number, refillPerSecond: number, now: number) {
    this.capacity = Math.max(1, capacity)
    this.refillPerMs = Math.max(0, refillPerSecond) / 1000
    this.#tokens = this.capacity
    this.#last = now
  }

  /** Tokens available at `now`, after crediting the elapsed time. */
  tokens(now: number): number {
    const elapsed = Math.max(0, now - this.#last)
    return Math.min(this.capacity, this.#tokens + elapsed * this.refillPerMs)
  }

  /** Spends a token if one is available. False means the message is over budget. */
  take(now: number, cost = 1): boolean {
    this.#tokens = this.tokens(now)
    this.#last = now
    if (this.#tokens < cost) return false
    this.#tokens -= cost
    return true
  }
}

/**
 * Progress budget: bursty and cheap.
 *
 * Placing a cat is a deliberate act, and even a fast player on a 9x9 produces
 * well under twenty messages a second. The allowance is generous because the
 * server coalesces progress into one broadcast per tick interval regardless of
 * how many samples arrived, so an over-eager client costs bandwidth inbound
 * only, and never multiplies outbound.
 */
export const progressBucket = (now: number): TokenBucket => new TokenBucket(40, 20, now)

/**
 * Command budget: everything that changes room state.
 *
 * Joins, renames, settings changes, starts, solution claims and readies are all
 * human-paced. A handful a second with a small burst covers every legitimate
 * use, including a client that retries a claim it thinks was lost.
 */
export const commandBucket = (now: number): TokenBucket => new TokenBucket(20, 5, now)
