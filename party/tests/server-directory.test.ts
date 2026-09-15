import { describe, expect, it } from 'vitest'
import {
  MAX_LIVE_ROOMS,
  ROOM_IDLE_TTL_MS,
  RoomDirectory,
  UNCLAIMED_TTL_MS,
  type RoomEntry,
} from '../lib/directory'
import type { RoomCode } from '../../src/multiplayer/protocol'
import { ROOM_CODE_ALPHABET, type RandomSource } from '../../src/multiplayer/roomCode'

const code = (value: string): RoomCode => value as RoomCode

/** A random source that walks a scripted list, so a generated code is checkable. */
const scripted = (values: readonly number[]): RandomSource => {
  let i = 0
  return () => values[i++ % values.length] as number
}

/** The random value that selects a given alphabet character. */
const pick = (ch: string): number => ROOM_CODE_ALPHABET.indexOf(ch) / ROOM_CODE_ALPHABET.length

const codeFrom = (chars: string): RandomSource => scripted([...chars].map(pick))

describe('allocation', () => {
  it('hands out a code and remembers it immediately', () => {
    const directory = new RoomDirectory()
    const result = directory.allocate(1000)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(directory.has(result.code)).toBe(true)
    expect(directory.size).toBe(1)
    expect(directory.seenAt(result.code)).toBe(1000)
  })

  it('never hands the same code to two callers', () => {
    const directory = new RoomDirectory()
    const seen = new Set<string>()
    for (let i = 0; i < 500; i++) {
      const result = directory.allocate(i)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(seen.has(result.code)).toBe(false)
      seen.add(result.code)
    }
  })

  it('reserves before any caller can await, which is what settles the race', () => {
    // Two hosts arriving in the same tick are modelled by a random source that
    // insists on the same code twice: the first allocation must claim it and the
    // second must be handed something else rather than the same five characters.
    const directory = new RoomDirectory()
    const first = directory.allocate(0, codeFrom('ACDEFACDEF'))
    const second = directory.allocate(0, codeFrom('ACDEFACDEF'))
    expect(first.ok && first.code).toBe('ACDEF')
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.reason).toBe('no-free-code')
  })

  it('refuses rather than loops when the capacity guard is reached', () => {
    const directory = new RoomDirectory()
    for (let i = 0; i < MAX_LIVE_ROOMS; i++) directory.adopt(code(`X${i}`), 0)
    expect(directory.size).toBe(MAX_LIVE_ROOMS)
    const result = directory.allocate(0)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('at-capacity')
  })

  it('reports a full code space as a failure the caller can retry', () => {
    const directory = new RoomDirectory()
    directory.adopt(code('ACDEF'), 0)
    const result = directory.allocate(0, codeFrom('ACDEF'))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('no-free-code')
    expect(directory.size).toBe(1)
  })
})

describe('liveness', () => {
  it('records a heartbeat only for a code it knows', () => {
    const directory = new RoomDirectory()
    const result = directory.allocate(0)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(directory.touch(result.code, 5000)).toBe(true)
    expect(directory.seenAt(result.code)).toBe(5000)
    expect(directory.touch(code('ACDEF'), 5000)).toBe(false)
  })

  it('frees a code on release', () => {
    const directory = new RoomDirectory()
    const result = directory.allocate(0)
    if (!result.ok) return
    expect(directory.release(result.code)).toBe(true)
    expect(directory.has(result.code)).toBe(false)
    expect(directory.release(result.code)).toBe(false)
  })

  it('adopts a code that is already in use regardless of capacity', () => {
    const directory = new RoomDirectory()
    for (let i = 0; i < MAX_LIVE_ROOMS; i++) directory.adopt(code(`X${i}`), 0)
    directory.adopt(code('ACDEF'), 42)
    expect(directory.has(code('ACDEF'))).toBe(true)
    expect(directory.seenAt(code('ACDEF'))).toBe(42)
  })
})

/**
 * A reservation is not a room.
 *
 * `POST /rooms` is unauthenticated and consumes a code out of a table with a
 * hard ceiling. When every reservation held its code for the idle TTL, a few
 * seconds of requests filled the table and every host in the deployment was
 * refused for the next half hour, with nothing to free the codes early because
 * only a room object ever released one. A code nobody connected to has to come
 * back quickly and on its own.
 */
describe('reservations', () => {
  it('starts a fresh allocation unclaimed', () => {
    const directory = new RoomDirectory()
    const result = directory.allocate(1000)
    if (!result.ok) throw new Error('allocation failed')
    expect(directory.isClaimed(result.code)).toBe(false)
    // It is still live: the host is about to connect to it, and a guest typing
    // the code in that moment must find a room.
    expect(directory.has(result.code)).toBe(true)
  })

  it('becomes a room the moment a room with players in it reports in', () => {
    const directory = new RoomDirectory()
    const result = directory.allocate(1000)
    if (!result.ok) throw new Error('allocation failed')
    directory.touch(result.code, 2000)
    expect(directory.isClaimed(result.code)).toBe(true)
  })

  it('gives a code back in a minute when nobody ever connects', () => {
    const directory = new RoomDirectory()
    const result = directory.allocate(0)
    if (!result.ok) throw new Error('allocation failed')
    expect(directory.sweep(UNCLAIMED_TTL_MS - 1)).toEqual([])
    expect(directory.sweep(UNCLAIMED_TTL_MS)).toEqual([result.code])
  })

  it('holds a claimed room for the full idle TTL, which is far longer', () => {
    const directory = new RoomDirectory()
    const result = directory.allocate(0)
    if (!result.ok) throw new Error('allocation failed')
    directory.touch(result.code, 0)
    expect(directory.sweep(UNCLAIMED_TTL_MS)).toEqual([])
    expect(directory.sweep(ROOM_IDLE_TTL_MS)).toEqual([result.code])
    expect(UNCLAIMED_TTL_MS).toBeLessThan(ROOM_IDLE_TTL_MS)
  })

  it('cannot be kept full by a flood that never opens a room', () => {
    // The demonstrated attack, in miniature: fill the table with reservations,
    // watch honest hosts be refused, then let a minute pass without anybody
    // having to notice or intervene.
    const directory = new RoomDirectory()
    for (let i = 0; i < MAX_LIVE_ROOMS; i++) expect(directory.allocate(0).ok).toBe(true)
    expect(directory.allocate(0)).toEqual({ ok: false, reason: 'at-capacity' })

    expect(directory.sweep(UNCLAIMED_TTL_MS)).toHaveLength(MAX_LIVE_ROOMS)
    expect(directory.size).toBe(0)
    expect(directory.allocate(UNCLAIMED_TTL_MS).ok).toBe(true)
  })

  it('knows when the next thing expires, so a sweep can be scheduled for it', () => {
    const directory = new RoomDirectory()
    expect(directory.nextExpiryAt()).toBeNull()

    directory.adopt(code('ACDEF'), 0)
    expect(directory.nextExpiryAt()).toBe(ROOM_IDLE_TTL_MS)

    // One reservation is enough to pull the next sweep half an hour earlier.
    // Without that, a flood of them would sit on the table long after they
    // stopped meaning anything.
    directory.adopt(code('HJKMN'), 0, false)
    expect(directory.nextExpiryAt()).toBe(UNCLAIMED_TTL_MS)
  })
})

describe('the sweep', () => {
  it('drops only rooms that have stopped reporting in', () => {
    const directory = new RoomDirectory()
    directory.adopt(code('ACDEF'), 0)
    directory.adopt(code('HJKMN'), 1000)
    const expired = directory.sweep(ROOM_IDLE_TTL_MS, ROOM_IDLE_TTL_MS)
    expect(expired).toEqual(['ACDEF'])
    expect(directory.has(code('HJKMN'))).toBe(true)
  })

  it('returns the codes it freed so storage can be cleaned up with it', () => {
    const directory = new RoomDirectory()
    directory.adopt(code('ACDEF'), 0)
    directory.adopt(code('HJKMN'), 0)
    expect(new Set(directory.sweep(999_999_999))).toEqual(new Set(['ACDEF', 'HJKMN']))
    expect(directory.size).toBe(0)
  })

  it('leaves a room alone right up to the moment it expires', () => {
    const directory = new RoomDirectory()
    directory.adopt(code('ACDEF'), 0)
    expect(directory.sweep(ROOM_IDLE_TTL_MS - 1)).toEqual([])
    expect(directory.sweep(ROOM_IDLE_TTL_MS)).toEqual(['ACDEF'])
  })
})

describe('snapshots', () => {
  it('round-trips through the shape the registry stores', () => {
    const directory = new RoomDirectory()
    directory.adopt(code('ACDEF'), 10)
    directory.adopt(code('HJKMN'), 20, false)
    const entries: RoomEntry[] = directory.snapshot()
    const restored = new RoomDirectory(entries)
    expect(restored.size).toBe(2)
    expect(restored.seenAt(code('ACDEF'))).toBe(10)
    expect(restored.seenAt(code('HJKMN'))).toBe(20)
    // A reservation that survives a restart is still a reservation: restoring
    // it as a room would hand it the long TTL it never earned.
    expect(restored.isClaimed(code('ACDEF'))).toBe(true)
    expect(restored.isClaimed(code('HJKMN'))).toBe(false)
  })

  it('discards anything that is not a canonical code', () => {
    const restored = new RoomDirectory([
      { code: code('abc'), seenAt: 0, claimed: true },
      { code: code('OOOOO'), seenAt: 0, claimed: true },
      { code: code('ACDEF'), seenAt: 0, claimed: true },
    ])
    expect(restored.size).toBe(1)
    expect(restored.has(code('ACDEF'))).toBe(true)
  })
})
