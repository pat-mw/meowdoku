import type { RoomCode } from '../../src/multiplayer/protocol'
import {
  ROOM_CODE_ATTEMPTS,
  type RandomSource,
  generateUniqueRoomCode,
  isRoomCode,
} from '../../src/multiplayer/roomCode'

/**
 * The live-room table.
 *
 * A room code only has to be unique among rooms that currently exist, and a
 * Durable Object cannot see its siblings, so exactly one object has to hold the
 * list. This is the data structure that object keeps: a pure map from code to
 * "when we last heard from it", with no storage, no clock and no randomness of
 * its own. Everything that decides an outcome — now, the random source — is an
 * argument, which is what makes the allocation race and the expiry sweep
 * testable without a Worker.
 */

/** How long a room may go unheard-of before its code is recycled. */
export const ROOM_IDLE_TTL_MS = 30 * 60_000

/**
 * The ceiling on simultaneous live rooms.
 *
 * Not a platform limit — it is a guard on the code space. At two thousand live
 * rooms a fresh five-character code collides with a live one about once in
 * seven thousand tries, and the eight retries below make an allocation failure
 * vanishingly unlikely. Letting the table grow without bound would quietly
 * erode that margin instead of surfacing a problem.
 */
export const MAX_LIVE_ROOMS = 2000

/** One live room: the code and the last time it reported in. */
export type RoomEntry = {
  code: RoomCode
  /** Server epoch ms of the room's most recent heartbeat. */
  seenAt: number
}

export type AllocationResult =
  { ok: true; code: RoomCode } | { ok: false; reason: 'at-capacity' | 'no-free-code' }

/**
 * The set of codes currently in use.
 *
 * Mutating methods are synchronous and complete before any caller can await,
 * which is what settles the two-hosts-at-once race: the reservation is visible
 * in the table the instant `allocate` returns, long before the durable write
 * that mirrors it has resolved.
 */
export class RoomDirectory {
  #rooms = new Map<string, number>()

  constructor(entries: Iterable<RoomEntry> = []) {
    for (const entry of entries) {
      if (isRoomCode(entry.code)) this.#rooms.set(entry.code, entry.seenAt)
    }
  }

  get size(): number {
    return this.#rooms.size
  }

  has(code: RoomCode): boolean {
    return this.#rooms.has(code)
  }

  seenAt(code: RoomCode): number | null {
    return this.#rooms.get(code) ?? null
  }

  /**
   * Reserves a code no live room is using.
   *
   * Fails rather than loops. `at-capacity` and `no-free-code` are both answers
   * the caller can turn into "try again in a moment"; hanging a connection in a
   * retry loop would not be.
   */
  allocate(now: number, random?: RandomSource): AllocationResult {
    if (this.#rooms.size >= MAX_LIVE_ROOMS) return { ok: false, reason: 'at-capacity' }
    const code = generateUniqueRoomCode((c) => this.#rooms.has(c), ROOM_CODE_ATTEMPTS, random)
    if (!code) return { ok: false, reason: 'no-free-code' }
    this.#rooms.set(code, now)
    return { ok: true, code }
  }

  /** Records a heartbeat. False when the code is not in the table. */
  touch(code: RoomCode, now: number): boolean {
    if (!this.#rooms.has(code)) return false
    this.#rooms.set(code, now)
    return true
  }

  /**
   * Adds a code that is already in use, for restoring a persisted table.
   *
   * Distinct from `allocate` because it is not subject to the capacity guard:
   * refusing to remember a room that demonstrably exists would hand its code
   * out twice.
   */
  adopt(code: RoomCode, seenAt: number): void {
    this.#rooms.set(code, seenAt)
  }

  release(code: RoomCode): boolean {
    return this.#rooms.delete(code)
  }

  /**
   * Drops rooms that have not reported in, returning the codes freed.
   *
   * The backstop for a room object that died without releasing its code — a
   * crash, an eviction during a deploy. Rooms heartbeat far more often than the
   * TTL, so a swept code belongs to a room that is genuinely gone.
   */
  sweep(now: number, ttlMs: number = ROOM_IDLE_TTL_MS): RoomCode[] {
    const expired: RoomCode[] = []
    for (const [code, seenAt] of this.#rooms) {
      if (now - seenAt >= ttlMs) expired.push(code as RoomCode)
    }
    for (const code of expired) this.#rooms.delete(code)
    return expired
  }

  snapshot(): RoomEntry[] {
    return [...this.#rooms].map(([code, seenAt]) => ({ code: code as RoomCode, seenAt }))
  }
}
