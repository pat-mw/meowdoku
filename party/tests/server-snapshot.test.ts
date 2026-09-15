import { describe, expect, it } from 'vitest'
import { SNAPSHOT_VERSION, decodeRoomSnapshot, type RoomSnapshot } from '../lib/snapshot'
import { createMatch } from '../../src/multiplayer/match'
import { DEFAULT_SETTINGS } from '../../src/multiplayer/protocol'

const match = createMatch({
  settings: { mode: 'steady', levelCount: 3, difficulty: 'easy' },
  seed: 'ACDEF:1000',
  players: ['a', 'b'],
  startedAt: 1000,
})

const snapshot: RoomSnapshot = {
  v: SNAPSHOT_VERSION,
  phase: 'playing',
  hostId: 'a',
  settings: { mode: 'steady', levelCount: 3, difficulty: 'easy' },
  seats: [
    { id: 'a', name: 'Milo', joinedAt: 1, token: 'tok-a', disconnectedAt: null },
    { id: 'b', name: 'Suki', joinedAt: 2, token: 'tok-b', disconnectedAt: 5000 },
  ],
  match,
  levelStartedAt: { a: 4000, b: 4000 },
  phaseStartedAt: 4000,
  phaseEndsAt: 94_000,
  podium: null,
  levels: { '3': [0, 2, 4, 1, 3] },
}

/** Storage round-trips through structured clone; JSON is the honest stand-in. */
const roundTrip = (value: unknown): Record<string, unknown> =>
  JSON.parse(JSON.stringify(value)) as Record<string, unknown>

describe('decodeRoomSnapshot', () => {
  it('restores a mid-match room unchanged', () => {
    const restored = decodeRoomSnapshot(roundTrip(snapshot))
    expect(restored).not.toBeNull()
    expect(restored).toEqual(snapshot)
  })

  it('keeps the recorded finishes, which is what makes a restart survivable', () => {
    const played: RoomSnapshot = {
      ...snapshot,
      match: {
        ...match,
        phase: 'playing',
        finishes: [
          { playerId: 'a', levelIndex: 0, status: 'solved', elapsedMs: 4200, progress: 5, seq: 1 },
        ],
        seq: 2,
      },
    }
    const restored = decodeRoomSnapshot(roundTrip(played))
    expect(restored?.match?.finishes).toHaveLength(1)
    expect(restored?.match?.finishes[0]?.elapsedMs).toBe(4200)
  })

  it('discards a snapshot written by an older deploy', () => {
    expect(decodeRoomSnapshot({ ...snapshot, v: SNAPSHOT_VERSION + 1 })).toBeNull()
    expect(decodeRoomSnapshot({ ...snapshot, v: undefined })).toBeNull()
  })

  it('discards anything that is not a snapshot at all', () => {
    expect(decodeRoomSnapshot(undefined)).toBeNull()
    expect(decodeRoomSnapshot(null)).toBeNull()
    expect(decodeRoomSnapshot('room')).toBeNull()
    expect(decodeRoomSnapshot([])).toBeNull()
    expect(decodeRoomSnapshot({ v: SNAPSHOT_VERSION, phase: 'dancing', seats: [] })).toBeNull()
    expect(decodeRoomSnapshot({ v: SNAPSHOT_VERSION, phase: 'lobby' })).toBeNull()
  })

  it('drops seats it cannot make sense of instead of failing the whole room', () => {
    const restored = decodeRoomSnapshot({
      ...roundTrip(snapshot),
      seats: [
        { id: 'a', name: 'Milo', joinedAt: 1, token: 'tok-a', disconnectedAt: null },
        { id: 7 },
        null,
      ],
    })
    expect(restored?.seats).toHaveLength(1)
    expect(restored?.seats[0]?.id).toBe('a')
  })

  it('carries each seat token, because a restart is when resuming matters most', () => {
    const restored = decodeRoomSnapshot(roundTrip(snapshot))
    expect(restored?.seats.map((seat) => seat.token)).toEqual(['tok-a', 'tok-b'])
  })

  it('leaves a seat with no stored token unresumable rather than open to anyone', () => {
    // The seat survives so the podium can still name the player. What it does
    // not get is a token anybody could satisfy: an empty one resolves to
    // nothing, so that player rejoins as a newcomer instead of a stranger being
    // handed their place.
    const restored = decodeRoomSnapshot({
      ...roundTrip(snapshot),
      seats: [{ id: 'a', name: 'Milo', joinedAt: 1, disconnectedAt: null }],
    })
    expect(restored?.seats[0]?.token).toBe('')
  })

  it('falls back to the default settings rather than an unplayable mode', () => {
    const restored = decodeRoomSnapshot({ ...roundTrip(snapshot), settings: { mode: 'chess' } })
    expect(restored?.settings).toEqual(DEFAULT_SETTINGS)
  })

  it('treats a missing match as a room between matches', () => {
    const restored = decodeRoomSnapshot({ ...roundTrip(snapshot), match: null, phase: 'lobby' })
    expect(restored?.match).toBeNull()
    expect(restored?.phase).toBe('lobby')
  })

  it('never carries progress samples, because they are not worth a write', () => {
    const restored = decodeRoomSnapshot(roundTrip(snapshot))
    expect(restored).not.toBeNull()
    expect(Object.keys(restored ?? {})).not.toContain('progress')
    for (const seat of restored?.seats ?? []) {
      expect(Object.keys(seat)).toEqual(['id', 'name', 'joinedAt', 'token', 'disconnectedAt'])
    }
  })
})
