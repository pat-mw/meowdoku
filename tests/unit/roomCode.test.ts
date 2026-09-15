import { describe, expect, it } from 'vitest'
import {
  formatRoomCodeInput,
  generateRoomCode,
  generateUniqueRoomCode,
  isRoomCode,
  normaliseRoomCode,
  parseRoomCode,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  ROOM_CODE_SPACE,
  roomCodeCollisionOdds,
  type RandomSource,
} from '../../src/multiplayer/roomCode'
import type { RoomCode } from '../../src/multiplayer/protocol'

/** A random source that walks a scripted list, so a generated code is checkable. */
const scripted = (values: readonly number[]): RandomSource => {
  let i = 0
  return () => values[i++ % values.length] as number
}

describe('the alphabet', () => {
  it('is 27 characters with no duplicates', () => {
    expect(ROOM_CODE_ALPHABET.length).toBe(27)
    expect(new Set(ROOM_CODE_ALPHABET).size).toBe(27)
  })

  it('excludes every character that is confusable with another', () => {
    for (const ch of 'BGILOQSUZ') expect(ROOM_CODE_ALPHABET).not.toContain(ch)
  })

  it('has a code space of 27^5', () => {
    expect(ROOM_CODE_SPACE).toBe(14_348_907)
    expect(ROOM_CODE_LENGTH).toBe(5)
  })
})

describe('generateRoomCode', () => {
  it('maps the bottom of the random range to the first character', () => {
    expect(generateRoomCode(scripted([0]))).toBe('00000')
  })

  it('maps the top of the random range to the last character', () => {
    expect(generateRoomCode(scripted([0.999_999]))).toBe('YYYYY')
  })

  it('walks the alphabet in order', () => {
    const at = (index: number) => index / ROOM_CODE_ALPHABET.length + 0.001
    expect(generateRoomCode(scripted([at(0), at(1), at(9), at(10), at(26)]))).toBe('019AY')
  })

  it('clamps a random source that returns exactly 1', () => {
    expect(generateRoomCode(scripted([1]))).toBe('YYYYY')
  })

  it('always produces a valid code', () => {
    let seed = 12345
    const random: RandomSource = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    for (let i = 0; i < 500; i++) {
      const code = generateRoomCode(random)
      expect(code).toHaveLength(ROOM_CODE_LENGTH)
      expect(isRoomCode(code)).toBe(true)
      expect(parseRoomCode(code)).toBe(code)
    }
  })

  it('uses the platform random source by default', () => {
    expect(isRoomCode(generateRoomCode())).toBe(true)
  })
})

describe('normaliseRoomCode', () => {
  it('uppercases', () => {
    expect(normaliseRoomCode('a4k7m')).toBe('A4K7M')
  })

  it('drops whitespace and punctuation so a pasted phrase still resolves', () => {
    expect(normaliseRoomCode('  code: A4K-7M!  ')).toBe('C0DEA4K7M')
  })

  it('folds every confusable onto the character it is mistaken for', () => {
    expect(normaliseRoomCode('OQ')).toBe('00')
    expect(normaliseRoomCode('IL')).toBe('11')
    expect(normaliseRoomCode('Z')).toBe('2')
    expect(normaliseRoomCode('S')).toBe('5')
    expect(normaliseRoomCode('G')).toBe('6')
    expect(normaliseRoomCode('B')).toBe('8')
    expect(normaliseRoomCode('U')).toBe('V')
  })

  it('folds lowercase confusables too', () => {
    expect(normaliseRoomCode('oilsb')).toBe('01158')
  })

  it('resolves a misheard code to the same room as the spoken one', () => {
    expect(normaliseRoomCode('7KOM9')).toBe(normaliseRoomCode('7k0m9'))
  })

  it('drops characters outside the alphabet entirely', () => {
    expect(normaliseRoomCode('🐱A4K7M')).toBe('A4K7M')
  })

  it('does not truncate, so an over-long typo cannot become a valid code', () => {
    expect(normaliseRoomCode('A4K7MX')).toBe('A4K7MX')
  })
})

describe('formatRoomCodeInput', () => {
  it('normalises and clips to the code length for a text field', () => {
    expect(formatRoomCodeInput('a4k-7mxyz')).toBe('A4K7M')
  })

  it('passes a partial code through untouched', () => {
    expect(formatRoomCodeInput('a4')).toBe('A4')
  })
})

describe('parseRoomCode', () => {
  it('accepts a code typed in any case, with spacing', () => {
    expect(parseRoomCode(' a4 k7m ')).toBe('A4K7M')
  })

  it('accepts a code typed with confusable characters', () => {
    expect(parseRoomCode('a4kom')).toBe('A4K0M')
  })

  it('rejects a short code', () => {
    expect(parseRoomCode('A4K7')).toBeNull()
  })

  it('rejects a long code', () => {
    expect(parseRoomCode('A4K7MM')).toBeNull()
  })

  it('rejects an empty string', () => {
    expect(parseRoomCode('')).toBeNull()
    expect(parseRoomCode('     ')).toBeNull()
  })

  it('rejects input with nothing usable in it', () => {
    expect(parseRoomCode('-----')).toBeNull()
  })
})

describe('isRoomCode', () => {
  it('rejects a lowercase code that has not been normalised', () => {
    expect(isRoomCode('a4k7m')).toBe(false)
  })

  it('rejects a code containing an excluded character', () => {
    expect(isRoomCode('A4K7O')).toBe(false)
  })
})

describe('generateUniqueRoomCode', () => {
  it('returns the first code no live room is using', () => {
    const taken = new Set(['00000'])
    const code = generateUniqueRoomCode(
      (candidate) => taken.has(candidate),
      4,
      scripted([0, 0, 0, 0, 0, 0.9, 0.9, 0.9, 0.9, 0.9]),
    )
    expect(code).toBe('WWWWW')
  })

  it('gives up cleanly rather than looping when every attempt collides', () => {
    let calls = 0
    const code = generateUniqueRoomCode(
      () => {
        calls += 1
        return true
      },
      3,
      scripted([0]),
    )
    expect(code).toBeNull()
    expect(calls).toBe(3)
  })

  it('never offers a code the server says is taken', () => {
    const live = new Set<string>()
    for (let i = 0; i < 50; i++) {
      const code = generateUniqueRoomCode((candidate) => live.has(candidate))
      expect(code).not.toBeNull()
      expect(live.has(code as RoomCode)).toBe(false)
      live.add(code as RoomCode)
    }
  })
})

describe('roomCodeCollisionOdds', () => {
  it('is the share of the code space that is live', () => {
    expect(roomCodeCollisionOdds(0)).toBe(0)
    expect(roomCodeCollisionOdds(1000)).toBeCloseTo(1000 / ROOM_CODE_SPACE, 12)
  })

  it('clamps rather than reporting nonsense', () => {
    expect(roomCodeCollisionOdds(-5)).toBe(0)
    expect(roomCodeCollisionOdds(ROOM_CODE_SPACE * 2)).toBe(1)
  })
})
