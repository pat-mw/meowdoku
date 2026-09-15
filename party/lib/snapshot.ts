import type { PlayerId, PodiumEntry, RoomPhase, RoomSettings } from '../../src/multiplayer/protocol'
import { DEFAULT_SETTINGS, decodeSettings } from '../../src/multiplayer/protocol'
import type { MatchState } from '../../src/multiplayer/match'
import type { LevelVaultSnapshot } from './levels'

/**
 * What a room writes down.
 *
 * A room lives in memory. Durable Object storage exists here for exactly one
 * failure: the object is evicted or restarted while a match is running, and the
 * players — whose clients will reconnect within seconds — must find the match
 * where they left it rather than an empty lobby.
 *
 * That framing decides what is persisted and what is not. Written: the roster,
 * the host, the settings, the phase clock, the match itself (which is already
 * append-only and plain data), and the level solutions already generated, so a
 * restart does not pay to rebuild boards it has played. Not written: progress
 * samples, rate-limit buckets, connection state. Progress is the
 * highest-frequency thing in the room and the cheapest to lose — it is re-sent
 * within a tick of a client reconnecting — so persisting it would trade a
 * storage write every 250 ms for nothing at all.
 *
 * Writes happen on state transitions (someone joins or leaves, a level starts,
 * a level resolves, the match ends), never on the message path that carries
 * progress.
 */

/** Bumped when the stored shape changes. A mismatch is discarded, not migrated. */
export const SNAPSHOT_VERSION = 2

/** The storage key holding the whole snapshot. One key, one round trip. */
export const SNAPSHOT_KEY = 'room'

/** A seat as it survives a restart. Connection state deliberately does not. */
export type SeatSnapshot = {
  id: PlayerId
  name: string
  joinedAt: number
  /**
   * The seat's resume token.
   *
   * Written because an eviction is precisely when a resume matters: every
   * socket died with the previous instance and every player is about to
   * reconnect. A restored room that had forgotten its tokens would greet its
   * own players as strangers and refuse them for having a match in progress.
   *
   * This is the one secret in the snapshot. It never leaves storage except to
   * go back to the seat it belongs to.
   */
  token: string
  /** Server epoch ms of the drop that started the reconnect grace, or null. */
  disconnectedAt: number | null
}

export type RoomSnapshot = {
  v: number
  phase: RoomPhase
  hostId: PlayerId | null
  settings: RoomSettings
  seats: SeatSnapshot[]
  match: MatchState | null
  /** Per-player level start times, which in blaze differ from the match's. */
  levelStartedAt: Record<PlayerId, number>
  phaseStartedAt: number
  phaseEndsAt: number | null
  podium: PodiumEntry[] | null
  levels: LevelVaultSnapshot
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isPhase = (value: unknown): value is RoomPhase =>
  value === 'lobby' ||
  value === 'countdown' ||
  value === 'playing' ||
  value === 'interlude' ||
  value === 'finished'

const decodeSeat = (value: unknown): SeatSnapshot | null => {
  if (!isRecord(value)) return null
  const { id, name, joinedAt, token, disconnectedAt } = value
  if (typeof id !== 'string' || typeof name !== 'string') return null
  if (typeof joinedAt !== 'number') return null
  return {
    id,
    name,
    joinedAt,
    // An empty token is a seat nobody can resume, which is the safe direction
    // to fail in: the player rejoins as a newcomer rather than a stranger
    // arriving in their seat.
    token: typeof token === 'string' ? token : '',
    disconnectedAt: typeof disconnectedAt === 'number' ? disconnectedAt : null,
  }
}

/**
 * Reads a snapshot back, or returns null.
 *
 * Defensive rather than exhaustive. The only writer is this same module, so the
 * realistic failure is a stored shape from an older deploy, which the version
 * check catches outright. Everything below that is a cheap guard so a corrupt
 * record makes a room start empty instead of throwing on every wake.
 */
export const decodeRoomSnapshot = (value: unknown): RoomSnapshot | null => {
  if (!isRecord(value) || value.v !== SNAPSHOT_VERSION) return null
  if (!isPhase(value.phase) || !Array.isArray(value.seats)) return null

  const seats: SeatSnapshot[] = []
  for (const raw of value.seats) {
    const seat = decodeSeat(raw)
    if (seat) seats.push(seat)
  }

  const match = isRecord(value.match) ? (value.match as unknown as MatchState) : null

  return {
    v: SNAPSHOT_VERSION,
    phase: value.phase,
    hostId: typeof value.hostId === 'string' ? value.hostId : null,
    settings: decodeSettings(value.settings) ?? DEFAULT_SETTINGS,
    seats,
    match,
    levelStartedAt: isRecord(value.levelStartedAt)
      ? (value.levelStartedAt as Record<PlayerId, number>)
      : {},
    phaseStartedAt: typeof value.phaseStartedAt === 'number' ? value.phaseStartedAt : 0,
    phaseEndsAt: typeof value.phaseEndsAt === 'number' ? value.phaseEndsAt : null,
    podium: Array.isArray(value.podium) ? (value.podium as PodiumEntry[]) : null,
    levels: isRecord(value.levels) ? (value.levels as LevelVaultSnapshot) : {},
  }
}
