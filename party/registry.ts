import { Server } from 'partyserver'
import { parseRoomCode } from '../src/multiplayer/roomCode'
import { MAX_LIVE_ROOMS, ROOM_IDLE_TTL_MS, RoomDirectory } from './lib/directory'
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
 * Storage is one key per code rather than one key holding the table. Allocating
 * and releasing then cost a single small write instead of rewriting every live
 * room, and the table can never outgrow the 128 KiB a single stored value is
 * allowed.
 */

/** The name of the singleton. There is exactly one registry per deployment. */
export const REGISTRY_NAME = 'global'

const KEY_PREFIX = 'r:'

/** How often the table is swept for rooms that stopped reporting in. */
const SWEEP_INTERVAL_MS = 5 * 60_000

export type AllocateResponse =
  { ok: true; code: string } | { ok: false; reason: 'at-capacity' | 'no-free-code' }

export type RegistryStats = {
  liveRooms: number
  capacity: number
}

export class Registry extends Server<Env> {
  /**
   * No hibernation: the registry never holds a WebSocket, so there is nothing
   * to hibernate. It wakes for an RPC or a sweep alarm and goes back to sleep.
   */
  static override options = { hibernate: false }

  #directory = new RoomDirectory()

  override async onStart(): Promise<void> {
    const stored = await this.ctx.storage.list<number>({ prefix: KEY_PREFIX })
    for (const [key, seenAt] of stored) {
      const code = parseRoomCode(key.slice(KEY_PREFIX.length))
      if (code && typeof seenAt === 'number') this.#directory.adopt(code, seenAt)
    }
    await this.#armSweep()
  }

  /**
   * Reserves a code for a room that is about to be created.
   *
   * The caller connects to the room named by the returned code; the room then
   * heartbeats to keep the reservation alive. A reservation that is never
   * connected to is swept like any other silent room.
   */
  async allocate(): Promise<AllocateResponse> {
    const now = Date.now()
    const result = this.#directory.allocate(now)
    if (!result.ok) return { ok: false, reason: result.reason }
    await this.ctx.storage.put(KEY_PREFIX + result.code, now)
    await this.#armSweep()
    return { ok: true, code: result.code }
  }

  /** A room reporting that it still has players. False if its code was swept. */
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
    await this.ctx.storage.put(KEY_PREFIX + parsed, now)
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
    const expired = this.#directory.sweep(Date.now(), ROOM_IDLE_TTL_MS)
    for (const code of expired) await this.ctx.storage.delete(KEY_PREFIX + code)
    await this.#armSweep()
  }

  /**
   * Schedules the next sweep, but only while there is something to sweep.
   *
   * An alarm that re-arms unconditionally would keep the registry waking every
   * five minutes forever, long after the last room closed, for no purpose.
   */
  async #armSweep(): Promise<void> {
    if (this.#directory.size === 0) return
    const existing = await this.ctx.storage.getAlarm()
    if (existing !== null) return
    await this.ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS)
  }
}
