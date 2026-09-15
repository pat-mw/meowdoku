/**
 * Message and request budgets.
 *
 * A room fans every accepted message out to eight sockets, so one client
 * sending faster than it should costs the room eight times what it costs
 * itself. A token bucket is the right shape for this traffic: progress arrives
 * in bursts as a player sweeps a row of cells and then stops entirely while
 * they think, and a bucket absorbs the burst without punishing the pause.
 *
 * The same shape guards the HTTP side, where the stakes are different: a room
 * code is a shared, finite resource, so an unbudgeted `POST /rooms` is not a
 * cost to one room but a way to take room creation down for everybody. See
 * `KeyedLimiter`.
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

  /** How long until `cost` tokens exist, in ms. Zero when they already do. */
  waitMs(now: number, cost = 1): number {
    const shortfall = cost - this.tokens(now)
    if (shortfall <= 0) return 0
    if (this.refillPerMs === 0) return Number.POSITIVE_INFINITY
    return Math.ceil(shortfall / this.refillPerMs)
  }
}

/**
 * One bucket per caller, with a bound on how many callers are remembered.
 *
 * A per-connection bucket dies with its connection; an HTTP bucket has nothing
 * to die with, so the table has to be kept from becoming the denial of service
 * it is there to prevent. Two rules do that: an idle caller is forgotten as
 * soon as space is needed, since a bucket that has refilled to capacity is
 * indistinguishable from one that was never created; and if every remembered
 * caller is still spending, the least recently seen is dropped anyway. The
 * second case costs an attacker who controls thousands of addresses one bucket
 * reset, which is worth far less to them than the memory it would otherwise
 * cost us.
 */
export class KeyedLimiter {
  readonly capacity: number
  #make: (now: number) => TokenBucket
  #buckets = new Map<string, TokenBucket>()

  constructor(make: (now: number) => TokenBucket, capacity = 4096) {
    this.#make = make
    this.capacity = Math.max(1, capacity)
  }

  get size(): number {
    return this.#buckets.size
  }

  /** Spends one of `key`'s tokens. False means the caller is over budget. */
  take(key: string, now: number): boolean {
    const bucket = this.#bucketFor(key, now)
    // Re-inserting keeps the map in least-recently-seen order, which is what
    // makes the eviction below cheap and correct.
    this.#buckets.delete(key)
    this.#buckets.set(key, bucket)
    return bucket.take(now)
  }

  /** How long `key` must wait before its next request is in budget. */
  waitMs(key: string, now: number): number {
    return this.#buckets.get(key)?.waitMs(now) ?? 0
  }

  #bucketFor(key: string, now: number): TokenBucket {
    const existing = this.#buckets.get(key)
    if (existing) return existing
    if (this.#buckets.size >= this.capacity) this.#evict(now)
    return this.#make(now)
  }

  #evict(now: number): void {
    for (const [key, bucket] of this.#buckets) {
      if (bucket.tokens(now) >= bucket.capacity) this.#buckets.delete(key)
    }
    // Still full: everyone in the table is mid-burst, so the oldest goes.
    while (this.#buckets.size >= this.capacity) {
      const oldest = this.#buckets.keys().next()
      if (oldest.done === true) return
      this.#buckets.delete(oldest.value)
    }
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

/**
 * Room creation budget, per caller address.
 *
 * Creating a room is the one unauthenticated request that consumes a shared,
 * finite resource: a five-character code out of a table with a hard ceiling on
 * it. Unbudgeted, a single client can reserve the whole table faster than a
 * person can read one code aloud, and every host in the world is then told to
 * try again later.
 *
 * The burst is sized for people rather than for scripts: a host creating a
 * room, changing their mind, and creating another is two requests, and a
 * household or a classroom behind one address doing the same together is a
 * handful. Sustained, one a second per address is generous for humans and
 * useless for exhausting anything — paired with the reservation TTL in
 * ./directory, an address can hold only about a minute's worth of codes at a
 * time, and a code nobody connected to comes back on its own.
 */
export const ROOM_CREATE_BURST = 20
export const ROOM_CREATE_PER_SECOND = 1

export const roomCreateBucket = (now: number): TokenBucket =>
  new TokenBucket(ROOM_CREATE_BURST, ROOM_CREATE_PER_SECOND, now)
