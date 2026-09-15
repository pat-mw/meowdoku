import { describe, expect, it } from 'vitest'
import { PLAYER_ID_BYTES, SeatKeyring, TOKEN_BYTES, type RandomBytes } from '../lib/identity'

/**
 * The line between what a room broadcasts and what proves who you are.
 *
 * A room publishes every player's id to every player, constantly. If an id were
 * also the thing that re-enters a seat, then reading one state frame would be
 * enough to take somebody's place in a running match: forfeit their level,
 * change the settings if they host, and knock them off their own socket. These
 * tests are the guarantee that reading the room tells you nothing useful.
 */

/** A random source that counts, so every minted value is predictable and distinct. */
const counting = (): RandomBytes => {
  let n = 0
  return (length) => Uint8Array.from({ length }, () => n++ & 0xff)
}

describe('minting a seat', () => {
  it('hands out a public id and a private token that are nothing like each other', () => {
    const keyring = new SeatKeyring()
    const seat = keyring.mint()
    expect(seat.id).toHaveLength(PLAYER_ID_BYTES * 2)
    expect(seat.token).toHaveLength(TOKEN_BYTES * 2)
    expect(seat.token).not.toContain(seat.id)
    expect(seat.id).not.toContain(seat.token)
  })

  it('never repeats an id or a token', () => {
    const keyring = new SeatKeyring()
    const ids = new Set<string>()
    const tokens = new Set<string>()
    for (let i = 0; i < 500; i++) {
      const seat = keyring.mint()
      expect(ids.has(seat.id)).toBe(false)
      expect(tokens.has(seat.token)).toBe(false)
      ids.add(seat.id)
      tokens.add(seat.token)
    }
  })

  it('draws both from the given randomness and nothing else', () => {
    // Same scripted bytes, two keyrings: identical output. Anything derived
    // from a clock, a counter or a name would differ here, and a token derived
    // from anything guessable is not a secret.
    const first = new SeatKeyring(counting()).mint()
    const second = new SeatKeyring(counting()).mint()
    expect(first).toEqual(second)
  })
})

describe('resolving a token', () => {
  it('returns the seat that owns it', () => {
    const keyring = new SeatKeyring()
    const seat = keyring.mint()
    expect(keyring.resolve(seat.token)).toBe(seat.id)
  })

  it('refuses the player id, which is the value the whole room can see', () => {
    const keyring = new SeatKeyring()
    const seat = keyring.mint()
    expect(keyring.resolve(seat.id)).toBeNull()
  })

  it('refuses another seat token as proof of this seat', () => {
    const keyring = new SeatKeyring()
    const victim = keyring.mint()
    const attacker = keyring.mint()
    expect(keyring.resolve(attacker.token)).not.toBe(victim.id)
  })

  it('refuses a forgery, an absence and an empty string', () => {
    const keyring = new SeatKeyring()
    const seat = keyring.mint()
    expect(keyring.resolve(undefined)).toBeNull()
    expect(keyring.resolve('')).toBeNull()
    expect(keyring.resolve(`${seat.token}0`)).toBeNull()
    expect(keyring.resolve(seat.token.slice(0, -1))).toBeNull()
    expect(keyring.resolve(seat.token.toUpperCase())).toBeNull()
  })

  it('stops resolving the moment the seat is forgotten', () => {
    const keyring = new SeatKeyring()
    const seat = keyring.mint()
    keyring.forget(seat.id)
    expect(keyring.resolve(seat.token)).toBeNull()
    expect(keyring.size).toBe(0)
  })
})

describe('restoring a room', () => {
  it('adopts the tokens a snapshot carried, so a reconnect still finds its seat', () => {
    const keyring = new SeatKeyring()
    keyring.adopt('player-a', 'tok-a')
    keyring.adopt('player-b', 'tok-b')
    expect(keyring.resolve('tok-a')).toBe('player-a')
    expect(keyring.resolve('tok-b')).toBe('player-b')
    expect(keyring.resolve('player-a')).toBeNull()
  })

  it('ignores an empty token rather than letting one resolve a seat', () => {
    const keyring = new SeatKeyring()
    keyring.adopt('player-a', '')
    expect(keyring.resolve('')).toBeNull()
    expect(keyring.size).toBe(0)
  })

  it('replaces a seat token cleanly, leaving the old one dead', () => {
    const keyring = new SeatKeyring()
    keyring.adopt('player-a', 'tok-old')
    keyring.adopt('player-a', 'tok-new')
    expect(keyring.resolve('tok-old')).toBeNull()
    expect(keyring.resolve('tok-new')).toBe('player-a')
  })

  it('mints a token for a seat that arrived without one', () => {
    // A seat restored from a snapshot written before tokens existed still has
    // to be welcomable. It gets a fresh secret its owner has never seen, which
    // costs that player a resume and costs the room nothing.
    const keyring = new SeatKeyring()
    const token = keyring.tokenFor('player-a')
    expect(token).toHaveLength(TOKEN_BYTES * 2)
    expect(keyring.tokenFor('player-a')).toBe(token)
    expect(keyring.resolve(token)).toBe('player-a')
  })
})
