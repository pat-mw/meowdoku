import { describe, expect, it } from 'vitest'
import {
  FALL_HALF_LIFE_MS,
  RACER_REGION_KEYS,
  RISE_HALF_LIFE_MS,
  advanceFractions,
  approachFraction,
  buildRacers,
  racerColorVar,
  racerColorsFor,
  racerFraction,
  stackLanes,
  type RaceShape,
  type RacerInput,
} from '../../src/ui/multiplayer/race'
import { formatDuration, formatFinishTime, ordinal } from '../../src/ui/multiplayer/format'
import { MAX_PLAYERS } from '../../src/multiplayer/protocol'
import { REGION_COLORS } from '../../src/ui/palette'
import { contrastRatio, deltaE, deuteranope, protanope } from '../../src/ui/colorMetrics'
import { readFileSync } from 'node:fs'

/**
 * The sunken surface in both themes, read out of the stylesheets rather than
 * copied here, so that restyling it fails this test instead of quietly making
 * a racer invisible.
 */
const surfaceSunken = (): string[] => {
  const css = ['tokens.css', 'theme.css']
    .map((file) => readFileSync(new URL(`../../src/ui/${file}`, import.meta.url), 'utf8'))
    .join('\n')
  const values = [...css.matchAll(/--mdk-(?:dark-)?surface-sunken:\s*(#[0-9a-fA-F]{6})/g)].map(
    (match) => match[1] as string,
  )
  if (values.length < 2) throw new Error('both themes must declare a sunken surface')
  return values
}

/**
 * The progress race, minus the pixels.
 *
 * Everything asserted here is something the player would read as a bug rather
 * than as a design: a bar that jumps backwards, a leader crowned for doing
 * nothing, eight players drawn on top of each other, two racers the same
 * colour. None of it needs a DOM to be wrong, so none of it needs one to check.
 */

const SYNCED: RaceShape = { synced: true, levelCount: 5 }
const BLAZE: RaceShape = { synced: false, levelCount: 5 }

const racer = (id: string, patch: Partial<RacerInput> = {}): RacerInput => ({
  id,
  name: id,
  cats: 0,
  size: 7,
  levelIndex: 0,
  connected: true,
  eliminatedAtLevel: null,
  ...patch,
})

describe('racerFraction', () => {
  it('measures the current board in a synced mode', () => {
    expect(racerFraction(racer('a', { cats: 0 }), SYNCED)).toBe(0)
    expect(racerFraction(racer('a', { cats: 7 }), SYNCED)).toBe(1)
    expect(racerFraction(racer('a', { cats: 3 }), SYNCED)).toBeCloseTo(3 / 7)
  })

  it('ignores the level index in a synced mode, where everyone shares one', () => {
    const early = racerFraction(racer('a', { cats: 4, levelIndex: 0 }), SYNCED)
    const late = racerFraction(racer('a', { cats: 4, levelIndex: 3 }), SYNCED)
    expect(early).toBe(late)
  })

  it('measures the whole match in blaze, where players run ahead', () => {
    // Level three of five, four of seven cats down.
    const fraction = racerFraction(racer('a', { cats: 4, levelIndex: 2 }), BLAZE)
    expect(fraction).toBeCloseTo((2 + 4 / 7) / 5)
  })

  it('reaches exactly one when a blaze player finishes the schedule', () => {
    expect(racerFraction(racer('a', { cats: 7, levelIndex: 4 }), BLAZE)).toBe(1)
  })

  it('never leaves the track, whatever the server says', () => {
    expect(racerFraction(racer('a', { cats: 99 }), SYNCED)).toBe(1)
    expect(racerFraction(racer('a', { cats: 99, levelIndex: 99 }), BLAZE)).toBe(1)
    expect(racerFraction(racer('a', { cats: -3 }), SYNCED)).toBe(0)
  })

  it('reads an unknown board as the start of it rather than guessing', () => {
    // Happens for about one message at the start of a blaze level, before this
    // client knows which board an opponent moved on to.
    expect(racerFraction(racer('a', { cats: 4, size: 0 }), SYNCED)).toBe(0)
  })
})

describe('buildRacers', () => {
  it('keeps roster order, so markers never swap places mid-level', () => {
    const racers = buildRacers(
      [racer('a', { cats: 1 }), racer('b', { cats: 6 }), racer('c', { cats: 3 })],
      SYNCED,
      'a',
    )
    expect(racers.map((entry) => entry.id)).toEqual(['a', 'b', 'c'])
  })

  it('ranks by position and names the leader', () => {
    const racers = buildRacers(
      [racer('a', { cats: 1 }), racer('b', { cats: 6 }), racer('c', { cats: 3 })],
      SYNCED,
      'a',
    )
    expect(racers.map((entry) => entry.place)).toEqual([3, 1, 2])
    expect(racers.filter((entry) => entry.isLeader).map((entry) => entry.id)).toEqual(['b'])
  })

  it('crowns nobody while the whole field is on zero', () => {
    const racers = buildRacers([racer('a'), racer('b'), racer('c')], SYNCED, 'a')
    expect(racers.some((entry) => entry.isLeader)).toBe(false)
  })

  it('breaks a tie by roster order rather than arbitrarily', () => {
    const racers = buildRacers([racer('a', { cats: 4 }), racer('b', { cats: 4 })], SYNCED, 'b')
    expect(racers.find((entry) => entry.id === 'a')?.place).toBe(1)
    expect(racers.find((entry) => entry.id === 'b')?.place).toBe(2)
  })

  it('leaves a knocked-out player out of the running order but still in the field', () => {
    const racers = buildRacers(
      [racer('a', { cats: 7, eliminatedAtLevel: 2 }), racer('b', { cats: 1 })],
      SYNCED,
      'b',
    )
    expect(racers).toHaveLength(2)
    expect(racers[0]?.out).toBe(true)
    // The eliminated player is furthest along and must still not be the leader.
    expect(racers[0]?.isLeader).toBe(false)
    expect(racers[1]?.isLeader).toBe(true)
    expect(racers[1]?.place).toBe(1)
  })

  it('marks exactly one racer as this client', () => {
    const racers = buildRacers([racer('a'), racer('b')], SYNCED, 'b')
    expect(racers.filter((entry) => entry.isMe).map((entry) => entry.id)).toEqual(['b'])
  })

  it('gives a full room eight different colours', () => {
    const ids = Array.from({ length: MAX_PLAYERS }, (_, index) => `p${index}`)
    const racers = buildRacers(
      ids.map((id) => racer(id)),
      SYNCED,
      null,
    )
    expect(new Set(racers.map((entry) => entry.color)).size).toBe(MAX_PLAYERS)
  })
})

describe('racer colours', () => {
  it('draws from the region palette, which both themes share', () => {
    for (const key of RACER_REGION_KEYS) {
      expect(REGION_COLORS).toHaveProperty(key)
    }
  })

  it('offers one colour per seat and no more', () => {
    expect(RACER_REGION_KEYS).toHaveLength(MAX_PLAYERS)
  })

  it('holds every pair far enough apart to be told apart at marker size', () => {
    // A marker is six pixels wide, not a whole cell. The palette's own floor of
    // 11 in CIEDE2000 is asserted in palette.test.ts and holds for any subset;
    // what these add is that the eight chosen for the race are separated in
    // plain luminance too, and stay separated under both common forms of
    // colour blindness. Two colours of the same lightness read as one shape at
    // this size however far apart CIEDE2000 says they are.
    const values = RACER_REGION_KEYS.map((key) => REGION_COLORS[key])
    for (let i = 0; i < values.length; i++) {
      for (let j = i + 1; j < values.length; j++) {
        const a = values[i] as string
        const b = values[j] as string
        expect(contrastRatio(a, b), `luminance: ${a} vs ${b}`).toBeGreaterThan(1.06)
        expect(deltaE(a, b), `hue: ${a} vs ${b}`).toBeGreaterThan(15)
        expect(deltaE(protanope(a), protanope(b)), `protanopia: ${a} vs ${b}`).toBeGreaterThan(7)
        expect(
          deltaE(deuteranope(a), deuteranope(b)),
          `deuteranopia: ${a} vs ${b}`,
        ).toBeGreaterThan(7)
      }
    }
  })

  it('shows up against the track it is drawn on, in both themes', () => {
    // The track is `--mdk-surface-sunken`, which is cream in one theme and a
    // dark brown in the other. A marker that vanished into either would be a
    // player the race silently stopped reporting.
    for (const track of surfaceSunken()) {
      for (const key of RACER_REGION_KEYS) {
        const color = REGION_COLORS[key]
        expect(contrastRatio(color, track), `${color} on ${track}`).toBeGreaterThan(1.3)
      }
    }
  })

  it('never seats two adjacent players in neighbouring hues', () => {
    // A room fills in join order, so seats n and n+1 are the pair a player is
    // most likely to have to tell apart.
    for (let index = 0; index < RACER_REGION_KEYS.length; index++) {
      const here = REGION_COLORS[RACER_REGION_KEYS[index] as never] as string
      const next = REGION_COLORS[
        RACER_REGION_KEYS[(index + 1) % RACER_REGION_KEYS.length] as never
      ] as string
      expect(deltaE(here, next), `seats ${index} and ${index + 1}`).toBeGreaterThan(24)
    }
  })

  it('wraps rather than falling off the end of the palette', () => {
    expect(racerColorVar(MAX_PLAYERS)).toBe(racerColorVar(0))
    expect(racerColorVar(-1)).toBe(racerColorVar(MAX_PLAYERS - 1))
  })

  it('keys colours by roster position, which every client holds identically', () => {
    const colors = racerColorsFor(['x', 'y', 'z'])
    expect(colors.get('x')).toBe(racerColorVar(0))
    expect(colors.get('z')).toBe(racerColorVar(2))
  })
})

describe('stackLanes', () => {
  it('gives a lone marker the whole track', () => {
    const racers = buildRacers([racer('a', { cats: 3 })], SYNCED, null)
    expect(stackLanes(racers, 0.05)).toEqual([{ racer: racers[0], lane: 0, lanes: 1 }])
  })

  it('splits the height between everyone sitting on the same cat', () => {
    // The normal case, not an edge case: every level starts with the whole
    // field on zero.
    const racers = buildRacers([racer('a'), racer('b'), racer('c')], SYNCED, null)
    const lanes = stackLanes(racers, 0.05)
    expect(lanes.map((slot) => slot.lanes)).toEqual([3, 3, 3])
    expect(lanes.map((slot) => slot.lane)).toEqual([0, 1, 2])
  })

  it('keeps separate positions separate', () => {
    const racers = buildRacers(
      [racer('a', { cats: 0 }), racer('b', { cats: 4 }), racer('c', { cats: 4 })],
      SYNCED,
      null,
    )
    const lanes = stackLanes(racers, 0.05)
    expect(lanes[0]?.lanes).toBe(1)
    expect(lanes[1]?.lanes).toBe(2)
    expect(lanes[2]?.lanes).toBe(2)
  })

  it('does not merge two adjacent cats on the smallest board', () => {
    // Five cats is the coarsest board multiplayer plays: one cat is a fifth of
    // the track, which must stay well clear of the collision tolerance.
    const racers = buildRacers(
      [racer('a', { cats: 1, size: 5 }), racer('b', { cats: 2, size: 5 })],
      SYNCED,
      null,
    )
    expect(stackLanes(racers, 0.05).every((slot) => slot.lanes === 1)).toBe(true)
  })
})

describe('bar motion', () => {
  it('climbs most of the way to a new target inside one tick interval', () => {
    // Progress arrives every 250 ms, so a rise has to be substantially complete
    // before the next one lands or the bar is permanently behind the truth.
    const after = approachFraction(0, 1, 250)
    expect(after).toBeGreaterThan(0.9)
  })

  it('retreats slowly, so a stale snapshot is corrected before it is seen', () => {
    // The failure this prevents: a full-room snapshot lands just after a fresher
    // progress tick and briefly reports one cat fewer. At 250 ms the bar must
    // barely have moved.
    const slipped = approachFraction(4 / 7, 3 / 7, 250)
    expect(4 / 7 - slipped).toBeLessThan(0.05)
  })

  it('still shows a real retreat, a moment later', () => {
    const from = 4 / 7
    const to = 3 / 7
    const travel = (ms: number): number => {
      let value = from
      for (let step = 0; step < ms / 20; step++) value = approachFraction(value, to, 20)
      return (from - value) / (from - to)
    }
    // A cat genuinely taken back off the board is most of the way down the bar
    // within a second, and all the way down within two.
    expect(travel(1000)).toBeGreaterThan(0.75)
    expect(travel(2000)).toBeGreaterThan(0.95)
  })

  it('is harder to fall than to rise, which is the whole defence', () => {
    expect(FALL_HALF_LIFE_MS).toBeGreaterThan(RISE_HALF_LIFE_MS * 4)
  })

  it('travels the same distance whatever the frame rate', () => {
    // Four hundred milliseconds of easing, delivered as 24 frames or as 8.
    const over = (frames: number): number => {
      let value = 0
      for (let step = 0; step < frames; step++) value = approachFraction(value, 1, 400 / frames)
      return value
    }
    expect(over(24)).toBeCloseTo(over(8), 2)
  })

  it('snaps onto a target it has effectively reached', () => {
    expect(approachFraction(0.9999, 1, 16)).toBe(1)
  })

  it('returns the same array when nothing moved, so a settled race costs nothing', () => {
    const current = [0.25, 0.5]
    expect(advanceFractions(current, [0.25, 0.5], 16)).toBe(current)
  })

  it('snaps when the field changes size, because there is nothing to ease from', () => {
    const targets = [0, 0, 0]
    expect(advanceFractions([0.4, 0.9], targets, 16)).toBe(targets)
  })

  it('never overshoots', () => {
    let value = 0
    for (let step = 0; step < 200; step++) value = approachFraction(value, 0.5, 16)
    expect(value).toBeLessThanOrEqual(0.5)
  })
})

describe('formatting', () => {
  it('writes a race time to a tenth, because races are decided inside a second', () => {
    expect(formatDuration(38_420, true)).toBe('0:38.4')
    expect(formatDuration(94_050, true)).toBe('1:34.0')
  })

  it('keeps a clock the same width as it runs down', () => {
    expect(formatDuration(600_000)).toHaveLength(formatDuration(9000).length + 1)
    expect(formatDuration(65_000)).toBe('1:05')
    expect(formatDuration(5000)).toBe('0:05')
  })

  it('reads a negative or missing duration as zero rather than as nonsense', () => {
    expect(formatDuration(-1)).toBe('0:00')
    expect(formatFinishTime(null)).toBe('—')
  })

  it('gets the ordinals right, teens included', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22].map(ordinal)).toEqual([
      '1st',
      '2nd',
      '3rd',
      '4th',
      '11th',
      '12th',
      '13th',
      '21st',
      '22nd',
    ])
  })
})
