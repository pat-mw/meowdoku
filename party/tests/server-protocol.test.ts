import { describe, expect, it } from 'vitest'
import {
  MAX_TOKEN_LENGTH,
  PROTOCOL_VERSION,
  parseClientMessage,
} from '../../src/multiplayer/protocol'

/**
 * The join handshake, at the server's boundary.
 *
 * `parseClientMessage` is the last point at which a frame is untrusted data
 * rather than a decision, so what it hands on decides how much the room has to
 * be suspicious about. A join arrives with a seat token or it does not, and
 * "does not" has to include every shape that is not a usable token — otherwise
 * the room ends up asking two questions where one will do.
 */
describe('a join frame', () => {
  it('carries a seat token through untouched', () => {
    const token = 'a'.repeat(48)
    expect(parseClientMessage({ t: 'join', v: PROTOCOL_VERSION, name: 'Ada', token })).toEqual({
      t: 'join',
      v: PROTOCOL_VERSION,
      name: 'Ada',
      token,
    })
  })

  it('is a new player when no token is presented', () => {
    const parsed = parseClientMessage({ t: 'join', v: PROTOCOL_VERSION, name: 'Ada' })
    expect(parsed).toEqual({ t: 'join', v: PROTOCOL_VERSION, name: 'Ada' })
    expect(parsed && 'token' in parsed).toBe(false)
  })

  it('drops a token that could not be one, rather than refusing the join', () => {
    for (const token of [null, 42, {}, [], '', 'x'.repeat(MAX_TOKEN_LENGTH + 1)]) {
      const parsed = parseClientMessage({ t: 'join', v: PROTOCOL_VERSION, name: 'Ada', token })
      expect(parsed).toEqual({ t: 'join', v: PROTOCOL_VERSION, name: 'Ada' })
    }
  })

  it('bounds the token, so a huge one is not a way to spend the room’s time', () => {
    const token = 'b'.repeat(MAX_TOKEN_LENGTH)
    const parsed = parseClientMessage({ t: 'join', v: PROTOCOL_VERSION, name: 'Ada', token })
    expect(parsed).toEqual({ t: 'join', v: PROTOCOL_VERSION, name: 'Ada', token })
  })

  it('still refuses a frame that is not a join at all', () => {
    expect(parseClientMessage({ t: 'join', name: 'Ada' })).toBeNull()
    expect(parseClientMessage({ t: 'join', v: '1', name: 'Ada' })).toBeNull()
    expect(parseClientMessage({ t: 'join', v: PROTOCOL_VERSION })).toBeNull()
  })
})

describe('a rematch frame', () => {
  it('parses, because a room has to be able to return to its lobby', () => {
    expect(parseClientMessage({ t: 'rematch' })).toEqual({ t: 'rematch' })
    expect(parseClientMessage('{"t":"rematch"}')).toEqual({ t: 'rematch' })
  })

  it('is not confused with anything else the client can send', () => {
    expect(parseClientMessage({ t: 'rematsh' })).toBeNull()
  })
})
