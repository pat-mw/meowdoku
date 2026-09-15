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
 *
 * An entry is in one of two states, and the difference matters more than it
 * looks. A RESERVATION is a code handed out by the lobby that no room object
 * has reported using yet; it holds its code for a minute. A CLAIMED entry has
 * been heartbeated by a room with players in it and holds its code for as long
 * as a match could plausibly last. Without that split, anything that can send
 * an HTTP request can fill the table with rooms that were never opened and keep
 * every code space in the deployment full until the long TTL runs out.
 */

/** How long a room may go unheard-of before its code is recycled. */
export const ROOM_IDLE_TTL_MS = 30 * 60_000

/**
 * How long a reservation nobody has connected to may hold its code.
 *
 * An allocation is a promise to open a room, and the app keeps it immediately:
 * the create-room screen asks for a code and opens the socket with it in the
 * same breath. A reservation that has never heard from a room object a minute
 * later was not a room, and holding its code for the idle TTL would let anyone
 * who can send an HTTP request fill the table with rooms that do not exist and
 * keep it full for half an hour. A minute is far longer than the round trip it
 * covers and far shorter than a match.
 */
export const UNCLAIMED_TTL_MS = 60_000

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
  /** Server epoch ms of the room's most recent heartbeat, or of its reservation. */
  seenAt: number
  /**
   * True once a room object with players in it has reported the code in use.
   *
   * The difference between a room and a reservation, and therefore the
   * difference between thirty minutes of protection and one.
   */
  claimed: boolean
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
  #rooms = new Map<string, { seenAt: number; claimed: boolean }>()

  constructor(entries: Iterable<RoomEntry> = []) {
    for (const entry of entries) {
      if (isRoomCode(entry.code)) {
        this.#rooms.set(entry.code, { seenAt: entry.seenAt, claimed: entry.claimed })
      }
    }
  }

  get size(): number {
    return this.#rooms.size
  }

  has(code: RoomCode): boolean {
    return this.#rooms.has(code)
  }

  seenAt(code: RoomCode): number | null {
    return this.#rooms.get(code)?.seenAt ?? null
  }

  /** Whether a room object with players in it has ever reported this code. */
  isClaimed(code: RoomCode): boolean {
    return this.#rooms.get(code)?.claimed ?? false
  }

  /**
   * Reserves a code no live room is using.
   *
   * The reservation starts unclaimed and stays that way until a room object
   * heartbeats it, so a code handed to someone who never connects is reclaimed
   * in a minute rather than in half an hour.
   *
   * Fails rather than loops. `at-capacity` and `no-free-code` are both answers
   * the caller can turn into "try again in a moment"; hanging a connection in a
   * retry loop would not be.
   */
  allocate(now: number, random?: RandomSource): AllocationResult {
    if (this.#rooms.size >= MAX_LIVE_ROOMS) return { ok: false, reason: 'at-capacity' }
    const code = generateUniqueRoomCode((c) => this.#rooms.has(c), ROOM_CODE_ATTEMPTS, random)
    if (!code) return { ok: false, reason: 'no-free-code' }
    this.#rooms.set(code, { seenAt: now, claimed: false })
    return { ok: true, code }
  }

  /**
   * Records a heartbeat, which also claims the code.
   *
   * Only a room object with players in it heartbeats, so this is the moment a
   * reservation becomes a room. False when the code is not in the table.
   */
  touch(code: RoomCode, now: number): boolean {
    if (!this.#rooms.has(code)) return false
    this.#rooms.set(code, { seenAt: now, claimed: true })
    return true
  }

  /**
   * Adds a code that is already in use, for restoring a persisted table.
   *
   * Distinct from `allocate` because it is not subject to the capacity guard:
   * refusing to remember a room that demonstrably exists would hand its code
   * out twice.
   */
  adopt(code: RoomCode, seenAt: number, claimed = true): void {
    this.#rooms.set(code, { seenAt, claimed })
  }

  release(code: RoomCode): boolean {
    return this.#rooms.delete(code)
  }

  /** When a code stops being protected, by server clock. */
  expiresAt(
    code: RoomCode,
    idleTtlMs: number = ROOM_IDLE_TTL_MS,
    unclaimedTtlMs: number = UNCLAIMED_TTL_MS,
  ): number | null {
    const entry = this.#rooms.get(code)
    if (!entry) return null
    return entry.seenAt + (entry.claimed ? idleTtlMs : unclaimedTtlMs)
  }

  /**
   * The earliest moment a sweep would free something, or null when empty.
   *
   * The registry schedules its alarm from this rather than from a fixed
   * interval, because the two deadlines are half an hour apart and a sweep that
   * always ran on the longer one would leave a flood of reservations sitting on
   * the table for twenty-nine minutes after they stopped meaning anything.
   */
  nextExpiryAt(
    idleTtlMs: number = ROOM_IDLE_TTL_MS,
    unclaimedTtlMs: number = UNCLAIMED_TTL_MS,
  ): number | null {
    let earliest: number | null = null
    for (const entry of this.#rooms.values()) {
      const at = entry.seenAt + (entry.claimed ? idleTtlMs : unclaimedTtlMs)
      if (earliest === null || at < earliest) earliest = at
    }
    return earliest
  }

  /**
   * Drops rooms that have not reported in, returning the codes freed.
   *
   * The backstop for a room object that died without releasing its code — a
   * crash, an eviction during a deploy — and the routine cleanup for a
   * reservation that never became a room. Rooms heartbeat far more often than
   * the idle TTL, so a swept claimed code belongs to a room that is genuinely
   * gone.
   */
  sweep(
    now: number,
    idleTtlMs: number = ROOM_IDLE_TTL_MS,
    unclaimedTtlMs: number = UNCLAIMED_TTL_MS,
  ): RoomCode[] {
    const expired: RoomCode[] = []
    for (const [code, entry] of this.#rooms) {
      const ttl = entry.claimed ? idleTtlMs : unclaimedTtlMs
      if (now - entry.seenAt >= ttl) expired.push(code as RoomCode)
    }
    for (const code of expired) this.#rooms.delete(code)
    return expired
  }

  snapshot(): RoomEntry[] {
    return [...this.#rooms].map(([code, entry]) => ({
      code: code as RoomCode,
      seenAt: entry.seenAt,
      claimed: entry.claimed,
    }))
  }
}
