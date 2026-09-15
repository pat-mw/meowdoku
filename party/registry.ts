import { Server } from 'partyserver'
import { parseRoomCode } from '../src/multiplayer/roomCode'
import { MAX_LIVE_ROOMS, RoomDirectory } from './lib/directory'
import { KeyedLimiter, roomCreateBucket } from './lib/rateLimit'
import type { Env } from './env'

/**
 * The one object that knows which room codes exist.
 *
 * A room code has to be unique among rooms in progress, and a Durable Object
 * can see nothing outside itself: a room cannot ask the others whether its code
 * is taken. So one object owns the answer. Every allocation goes through this
 * singleton, and because a Durable Object processes one request at a time and
 * `RoomDirectory.allocate` reserves the code synchronously — before any await —
 * two hosts creating a room in the same millisecond cannot be handed the same
 * five characters. The second request simply sees the first one's reservation.
 *
 * The table is the room's own liveness signal, not a lease the registry
 * enforces. Rooms heartbeat while they have players and release their code when
 * they empty; the sweep below is the backstop for the room that never got to
 * release — a crash, an eviction during a deploy — so a code is never lost for
 * good. Thirty minutes of silence is far longer than any match and far shorter
 * than "forever".
 *
 * BECAUSE THE TABLE IS SHARED, SO IS THE DAMAGE. Every room code in the
 * deployment comes from this one object, against one ceiling, so an
 * unconstrained `allocate` is not a cost borne by the caller — it is a way to
 * stop anyone, anywhere, from creating a room. Two things keep that from being
 * possible, and both are needed: a per-caller budget on allocation, and a short
 * TTL on a reservation nobody has connected to, so that codes taken by a flood
 * come back in a minute rather than in half an hour.
 *
 * Storage is one key per code rather than one key holding the table. Allocating
 * and releasing then cost a single small write instead of rewriting every live
 * room, and the table can never outgrow the 128 KiB a single stored value is
 * allowed.
 */

/** The name of the singleton. There is exactly one registry per deployment. */
export const REGISTRY_NAME = 'global'

const KEY_PREFIX = 'r:'

/**
 * The longest the table may go unswept.
 *
 * A ceiling rather than a schedule: the sweep is normally armed for the moment
 * the earliest entry expires, and this only matters when every entry has a
 * deadline further away than that.
 */
const MAX_SWEEP_INTERVAL_MS = 5 * 60_000

/** No alarm sooner than this, so a burst of allocations cannot become a wake-up storm. */
const MIN_SWEEP_DELAY_MS = 1_000

/** Do not rewrite an alarm that is already close enough to the one we want. */
const ALARM_SLACK_MS = 1_000

/** How long a caller is told to wait after a momentary allocation failure. */
const RETRY_SOON_MS = 1_000

/** What one caller is allowed to hold buckets for. Beyond this, the idle are forgotten. */
const MAX_TRACKED_CALLERS = 4096

export type AllocateFailure = 'at-capacity' | 'no-free-code' | 'rate-limited'

export type AllocateResponse =
  { ok: true; code: string } | { ok: false; reason: AllocateFailure; retryAfterMs: number }

export type RegistryStats = {
  liveRooms: number
  capacity: number
}

/** What one code looks like in storage. A bare number is a record from before reservations. */
type StoredEntry = { seenAt: number; claimed: boolean }

const decodeStored = (value: unknown): StoredEntry | null => {
  // A code written by an older deployment is treated as a claimed room rather
  // than as a reservation: it was allocated under the old rules, and the safe
  // direction to be wrong in is leaving a possibly-live room its code.
  if (typeof value === 'number') return { seenAt: value, claimed: true }
  if (typeof value !== 'object' || value === null) return null
  const { seenAt, claimed } = value as Record<string, unknown>
  if (typeof seenAt !== 'number') return null
  return { seenAt, claimed: claimed === true }
}

export class Registry extends Server<Env> {
  /**
   * No hibernation: the registry never holds a WebSocket, so there is nothing
   * to hibernate. It wakes for an RPC or a sweep alarm and goes back to sleep.
   */
  static override options = { hibernate: false }

  #directory = new RoomDirectory()

  /**
   * Allocation budgets, keyed by caller address.
   *
   * In memory rather than in storage, and deliberately: the limiter is there to
   * blunt a burst, a burst arrives at one object over seconds, and paying a
   * durable write per request to survive an eviction would cost more than the
   * requests it is rationing. An eviction hands every caller a fresh budget,
   * which is a burst's worth of codes — and the reservation TTL takes those
   * back a minute later.
   */
  #creates = new KeyedLimiter(roomCreateBucket, MAX_TRACKED_CALLERS)

  override async onStart(): Promise<void> {
    const stored = await this.ctx.storage.list({ prefix: KEY_PREFIX })
    for (const [key, value] of stored) {
      const code = parseRoomCode(key.slice(KEY_PREFIX.length))
      const entry = decodeStored(value)
      if (code && entry) this.#directory.adopt(code, entry.seenAt, entry.claimed)
    }
    await this.#armSweep()
  }

  /**
   * Reserves a code for a room that is about to be created.
   *
   * The caller connects to the room named by the returned code; the room then
   * heartbeats, which turns the reservation into a claimed room. A reservation
   * that is never connected to expires in a minute, so the cost of asking for a
   * code and walking away is paid by whoever asked and not by the code space.
   *
   * `caller` is the address the request came from, or an empty string when
   * there is none to be had. Callers that cannot be told apart share a budget,
   * which is the right way round: the unidentifiable are rationed together.
   */
  async allocate(caller = ''): Promise<AllocateResponse> {
    const now = Date.now()
    if (!this.#creates.take(caller.length > 0 ? caller : 'unknown', now)) {
      return {
        ok: false,
        reason: 'rate-limited',
        retryAfterMs: this.#creates.waitMs(caller.length > 0 ? caller : 'unknown', now),
      }
    }
    // Expired entries are cleared before the capacity guard runs, so a flood of
    // reservations that have since lapsed cannot keep an honest host out.
    await this.#prune(now)

    const result = this.#directory.allocate(now)
    if (!result.ok) return { ok: false, reason: result.reason, retryAfterMs: RETRY_SOON_MS }
    const entry: StoredEntry = { seenAt: now, claimed: false }
    await this.ctx.storage.put(KEY_PREFIX + result.code, entry)
    await this.#armSweep()
    return { ok: true, code: result.code }
  }

  /**
   * A room reporting that it still has players, which also claims the code.
   *
   * Only a room with somebody in it heartbeats, so this is what separates a
   * room from a reservation. False if its code was swept.
   */
  async keepAlive(code: string): Promise<boolean> {
    const parsed = parseRoomCode(code)
    if (!parsed) return false
    const now = Date.now()
    if (!this.#directory.touch(parsed, now)) {
      // The room outlived its entry, which means a sweep was wrong about it.
      // Re-adopting is strictly better than letting a live room's code be
      // handed to somebody else.
      this.#directory.adopt(parsed, now)
    }
    const entry: StoredEntry = { seenAt: now, claimed: true }
    await this.ctx.storage.put(KEY_PREFIX + parsed, entry)
    return true
  }

  /** A room reporting that it has closed. The code becomes available again. */
  async release(code: string): Promise<void> {
    const parsed = parseRoomCode(code)
    if (!parsed) return
    this.#directory.release(parsed)
    await this.ctx.storage.delete(KEY_PREFIX + parsed)
  }

  /**
   * Whether a code belongs to a live room.
   *
   * Checked before a socket is allowed through to a room object, so that a
   * mistyped code answers "no room with that code" instead of silently
   * conjuring an empty room nobody else can find.
   */
  async lookup(code: string): Promise<boolean> {
    const parsed = parseRoomCode(code)
    return parsed !== null && this.#directory.has(parsed)
  }

  async stats(): Promise<RegistryStats> {
    return { liveRooms: this.#directory.size, capacity: MAX_LIVE_ROOMS }
  }

  override async onAlarm(): Promise<void> {
    await this.#prune(Date.now())
    await this.#armSweep()
  }

  /** Drops whatever has expired and forgets it in storage too. */
  async #prune(now: number): Promise<void> {
    const expired = this.#directory.sweep(now)
    if (expired.length === 0) return
    await this.ctx.storage.delete(expired.map((code) => KEY_PREFIX + code))
  }

  /**
   * Schedules the next sweep for the moment the earliest entry expires.
   *
   * Driven by the table rather than by a fixed interval, because the two
   * deadlines are half an hour apart: a sweep that always ran on the long one
   * would leave a flood of one-minute reservations sitting on the table for
   * twenty-nine minutes after they stopped meaning anything. Nothing is armed
   * at all once the table is empty — an alarm that re-arms unconditionally
   * would keep the registry waking forever, long after the last room closed.
   */
  async #armSweep(): Promise<void> {
    const next = this.#directory.nextExpiryAt()
    if (next === null) return
    const now = Date.now()
    const at = Math.min(Math.max(next, now + MIN_SWEEP_DELAY_MS), now + MAX_SWEEP_INTERVAL_MS)
    const existing = await this.ctx.storage.getAlarm()
    // Only move the alarm earlier. A later one would delay a sweep that is
    // already due, and rewriting it for a few milliseconds costs a storage
    // write per allocation during exactly the burst this is meant to survive.
    if (existing !== null && existing <= at + ALARM_SLACK_MS) return
    await this.ctx.storage.setAlarm(at)
  }
}
