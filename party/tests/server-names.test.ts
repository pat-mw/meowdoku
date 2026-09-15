import { describe, expect, it } from 'vitest'
import { fallbackName, uniqueName } from '../lib/names'
import { MAX_NAME_LENGTH } from '../../src/multiplayer/protocol'

describe('fallbackName', () => {
  it('names an empty seat by its ordinal', () => {
    expect(fallbackName(1)).toBe('Player 1')
    expect(fallbackName(8)).toBe('Player 8')
  })

  it('never produces a zeroth or negative player', () => {
    expect(fallbackName(0)).toBe('Player 1')
    expect(fallbackName(-3)).toBe('Player 1')
  })
})

describe('uniqueName', () => {
  it('leaves a free name alone', () => {
    expect(uniqueName('Milo', ['Suki', 'Tofu'], 3)).toBe('Milo')
  })

  it('numbers a name that is already in the room', () => {
    expect(uniqueName('Milo', ['Milo'], 2)).toBe('Milo 2')
    expect(uniqueName('Milo', ['Milo', 'Milo 2'], 3)).toBe('Milo 3')
  })

  it('treats names as the same regardless of case', () => {
    expect(uniqueName('milo', ['MILO'], 2)).toBe('milo 2')
  })

  it('falls back to the seat ordinal when nothing usable was sent', () => {
    expect(uniqueName('', ['Milo'], 2)).toBe('Player 2')
    expect(uniqueName('   ', ['Milo'], 4)).toBe('Player 4')
  })

  it('numbers a fallback that somebody has already typed by hand', () => {
    expect(uniqueName('', ['Player 2'], 2)).toBe('Player 2 2')
  })

  it('keeps a numbered name inside the length a progress bar row allows', () => {
    const long = 'A'.repeat(MAX_NAME_LENGTH)
    const result = uniqueName(long, [long], 2)
    expect(result.length).toBeLessThanOrEqual(MAX_NAME_LENGTH)
    expect(result.endsWith(' 2')).toBe(true)
  })

  it('terminates with a full room all asking for the same name', () => {
    const taken: string[] = []
    for (let i = 0; i < 8; i++) taken.push(uniqueName('Cat', taken, i + 1))
    expect(new Set(taken).size).toBe(8)
    expect(taken[0]).toBe('Cat')
  })
})
