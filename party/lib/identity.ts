import type { PlayerId, SeatToken } from '../../src/multiplayer/protocol'

/**
 * Who a connection is allowed to be.
 *
 * A room broadcasts a `PlayerId` for every player to every player: it is on the
 * progress bars, in every result and all over the podium. So the id cannot also
 * be the thing that proves ownership of a seat, or reading the room would be
 * enough to take somebody else's place in it. This module keeps the two apart.
 *
 * A seat gets two values, minted together and used for opposite purposes:
 *
 *   PlayerId   public, broadcast constantly, grants nothing. Opaque so that it
 *              carries no name, no join order and no hint of the token.
 *   SeatToken  secret, sent once to its owner inside their own `welcome`, and
 *              the only thing that puts a connection back in an occupied seat.
 *
 * Both come from the same CSPRNG and neither is derived from the other, so
 * holding every id in the room tells you nothing about any token. The token is
 * the longer of the two because it is the value an attacker would have to
 * guess: 24 random bytes is far past the point where guessing over a WebSocket
 * is a strategy rather than a fantasy.
 *
 * No clock, no storage and no I/O: the randomness is an argument, which is what
 * lets the guarantees below be tested rather than asserted.
 */

/** Bytes behind a seat token. Secret, and the only thing worth guessing. */
export const TOKEN_BYTES = 24

/** Bytes behind a player id. Public; long enough that ids never collide. */
export const PLAYER_ID_BYTES = 12

export type SeatIdentity = {
  /** Broadcast to the whole room. */
  id: PlayerId
  /** Sent to this seat's owner and to nobody else. */
  token: SeatToken
}

/** Fills a buffer with cryptographically strong bytes. */
export type RandomBytes = (length: number) => Uint8Array

const cryptoRandomBytes: RandomBytes = (length) => crypto.getRandomValues(new Uint8Array(length))

/**
 * Hex rather than base64url.
 *
 * These values travel in JSON, get logged, and in the token's case get written
 * to `sessionStorage` and read back. Hex has no characters that anything along
 * that path treats specially, and the extra bytes on the wire are irrelevant
 * next to a room state.
 */
const randomHex = (bytes: number, random: RandomBytes): string => {
  let out = ''
  for (const byte of random(bytes)) out += byte.toString(16).padStart(2, '0')
  return out
}

/**
 * The room's seat secrets.
 *
 * Deliberately separate from the seats themselves: a `Seat` is mapped into the
 * `Player` objects the room broadcasts, and a secret stored on it would be one
 * careless spread away from going out to everybody. Nothing in here is ever
 * part of a payload; the room asks for a token only when it is addressing that
 * token's owner.
 */
export class SeatKeyring {
  #random: RandomBytes
  #byToken = new Map<SeatToken, PlayerId>()
  #byPlayer = new Map<PlayerId, SeatToken>()

  constructor(random: RandomBytes = cryptoRandomBytes) {
    this.#random = random
  }

  get size(): number {
    return this.#byPlayer.size
  }

  /** A fresh public id and the private token that owns it. */
  mint(): SeatIdentity {
    let id = randomHex(PLAYER_ID_BYTES, this.#random)
    // Two seats sharing an id would merge two players in every map the room
    // keeps. A collision at these widths is not something that happens, but
    // "not something that happens" is cheaper to guarantee than to reason about.
    while (this.#byPlayer.has(id)) id = randomHex(PLAYER_ID_BYTES, this.#random)
    return { id, token: this.tokenFor(id) }
  }

  /**
   * The seat's token, minted on first ask.
   *
   * Total rather than nullable so that welcoming a player is never a case
   * analysis. A seat restored from a snapshot that predates its token gets a
   * new one, which costs that player a resume they were not going to get
   * anyway and costs the room nothing.
   */
  tokenFor(id: PlayerId): SeatToken {
    const existing = this.#byPlayer.get(id)
    if (existing !== undefined) return existing
    const token = randomHex(TOKEN_BYTES, this.#random)
    this.#byPlayer.set(id, token)
    this.#byToken.set(token, id)
    return token
  }

  /** Restores a seat's token, for a room rebuilt from its snapshot. */
  adopt(id: PlayerId, token: SeatToken): void {
    if (token.length === 0) return
    const previous = this.#byPlayer.get(id)
    if (previous !== undefined) this.#byToken.delete(previous)
    this.#byPlayer.set(id, token)
    this.#byToken.set(token, id)
  }

  /**
   * The seat a token owns, or null.
   *
   * The only way a connection is ever matched to an existing seat. A player id,
   * a room code, a name or anything else a client can have read off the wire
   * resolves to null here, because none of them was ever put in the table.
   */
  resolve(token: SeatToken | undefined): PlayerId | null {
    if (token === undefined) return null
    return this.#byToken.get(token) ?? null
  }

  /** Drops a seat's secret. The token stops resolving immediately. */
  forget(id: PlayerId): void {
    const token = this.#byPlayer.get(id)
    if (token === undefined) return
    this.#byPlayer.delete(id)
    this.#byToken.delete(token)
  }
}
