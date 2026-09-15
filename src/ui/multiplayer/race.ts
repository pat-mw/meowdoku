/**
 * The arithmetic behind the progress race.
 *
 * Kept apart from the component that draws it because all of it is decidable
 * without a DOM: where a player sits on the track, who is leading, what happens
 * when four players sit on the same pixel, and how fast a bar is allowed to
 * move. Those are the parts that can be wrong, so they are the parts that are
 * tested.
 *
 * Nothing here imports anything but types, so it costs no bytes at runtime
 * beyond its own.
 */

import type { PlayerId } from '../../multiplayer/protocol'

/**
 * Where a racer's colour comes from.
 *
 * The region palette, reused. Those seventeen colours are already guaranteed at
 * least 11 apart in CIEDE2000 (see src/ui/palette.ts), they are the one part of
 * the design that is deliberately identical in both themes, and a player has
 * already spent every level learning to tell them apart.
 *
 * Eight of them are chosen against three constraints that the board itself
 * never had to satisfy, each of which rules out colours the board is happy
 * with. A racer's marker is six pixels wide rather than a whole cell, so the
 * pair must also differ in plain luminance — two colours of equal lightness
 * blur into one at that size, and CIEDE2000 will happily call them far apart.
 * A marker is drawn on the sunken surface rather than on white, so every colour
 * has to stand off that surface in *both* themes, which excludes the palest of
 * the pastels. And the eight are spread around the hue circle, in an order
 * where adjacent indices are never adjacent hues — a room fills in join order,
 * so neighbouring seats are exactly the pairs most likely to be compared.
 * tests/unit/race.test.ts measures all three.
 *
 * Colour is never the only thing distinguishing a racer. Your own progress is
 * drawn as a filled bar rather than a marker, the leader carries a crown and a
 * name, and the whole field is also published as text for a screen reader. The
 * palette is how the race looks, not how it is read.
 */
export const RACER_REGION_KEYS = ['U', 'Y', 'T', 'K', 'M', 'R', 'W', 'C'] as const

/** The custom property holding the colour for the nth racer in the room. */
export const racerColorVar = (index: number): string => {
  const length = RACER_REGION_KEYS.length
  const key = RACER_REGION_KEYS[((index % length) + length) % length] ?? 'G'
  return `var(--mdk-region-${key})`
}

/**
 * Every player's colour, keyed by id.
 *
 * Takes the roster in the order the server publishes it, which every client
 * holds identically, so a player is the same colour on every screen in the room
 * without anybody having to agree on it over the wire.
 */
export const racerColorsFor = (ids: readonly PlayerId[]): Map<PlayerId, string> => {
  const colors = new Map<PlayerId, string>()
  ids.forEach((id, index) => colors.set(id, racerColorVar(index)))
  return colors
}

/** One player as the race needs them, before any ordering has been worked out. */
export type RacerInput = {
  id: PlayerId
  name: string
  /** Cats correctly placed on the board they are looking at. */
  cats: number
  /** Edge length of that board. Zero when this client does not know it yet. */
  size: number
  /** 0-based index into the match schedule. */
  levelIndex: number
  connected: boolean
  /** 1-based level at which they were knocked out or left; null while racing. */
  eliminatedAtLevel: number | null
}

/** What the match is a race *to*, which differs by mode. */
export type RaceShape = {
  /**
   * True when every player is solving the same board at the same time, which
   * is steady and knockout. False in blaze, where players run ahead.
   */
  synced: boolean
  /** Levels in the match. The denominator in blaze; unused when synced. */
  levelCount: number
}

/** One player as the race draws them. */
export type Racer = {
  id: PlayerId
  name: string
  /** Position on the track, 0 to 1. */
  fraction: number
  cats: number
  size: number
  levelIndex: number
  connected: boolean
  /** Knocked out or gone. Still drawn, greyed, because their absence is news. */
  out: boolean
  isMe: boolean
  isLeader: boolean
  /** 1-based standing at this instant. Not a result; it changes every tick. */
  place: number
  /** A `var(--mdk-region-*)` reference, assigned from roster order. */
  color: string
}

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value)

/**
 * How far along the track one racer is.
 *
 * In steady and knockout the track is the level in front of everyone, so the
 * fraction is simply cats over board size. In blaze it is the whole match:
 * levels already banked plus progress through the current one, which is the
 * only reading that puts two players on different boards in a meaningful order.
 *
 * A size of zero means this client has not been told what board that player is
 * on. That happens for about one message at the start of a blaze level, and the
 * honest answer is "at the start of it" rather than a guess.
 */
export const racerFraction = (racer: RacerInput, shape: RaceShape): number => {
  const withinLevel = racer.size > 0 ? clamp01(racer.cats / racer.size) : 0
  if (shape.synced) return withinLevel
  if (shape.levelCount <= 0) return withinLevel
  return clamp01((racer.levelIndex + withinLevel) / shape.levelCount)
}

/**
 * The field, in roster order, with standings and the leader worked out.
 *
 * Roster order is deliberately preserved rather than sorted by position: the
 * strip draws a marker per racer, and markers that swapped places every time
 * two players traded a cat would be impossible to follow. Colour is assigned
 * from this order too, so a racer's colour is fixed for the whole match and
 * every client agrees on it without being told.
 *
 * Nobody leads until somebody has moved. A crown handed out while the whole
 * field sits on zero would name a leader who has done nothing, and would
 * change hands for no reason.
 */
export const buildRacers = (
  inputs: readonly RacerInput[],
  shape: RaceShape,
  meId: PlayerId | null,
): Racer[] => {
  const scored = inputs.map((input, index) => ({
    input,
    index,
    fraction: racerFraction(input, shape),
    out: input.eliminatedAtLevel !== null,
  }))

  // Best first. Ties keep roster order, so equal players rank by who joined
  // first rather than by whatever order the server happened to serialise.
  const ranked = scored
    .filter((entry) => !entry.out)
    .slice()
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index)

  const places = new Map<PlayerId, number>()
  ranked.forEach((entry, position) => places.set(entry.input.id, position + 1))

  const front = ranked[0]
  const leaderId = front !== undefined && front.fraction > 0 ? front.input.id : null

  return scored.map((entry) => ({
    id: entry.input.id,
    name: entry.input.name,
    fraction: entry.fraction,
    cats: entry.input.cats,
    size: entry.input.size,
    levelIndex: entry.input.levelIndex,
    connected: entry.input.connected,
    out: entry.out,
    isMe: entry.input.id === meId,
    isLeader: entry.input.id === leaderId,
    place: places.get(entry.input.id) ?? inputs.length,
    color: racerColorVar(entry.index),
  }))
}

/** A racer's marker, and which slice of the track's height it gets. */
export type Lane = {
  racer: Racer
  /** 0-based slice from the top of the track. */
  lane: number
  /** How many markers share this position, including this one. */
  lanes: number
}

/**
 * Splits the track's height between markers that would otherwise be drawn on
 * top of each other.
 *
 * Progress is an integer count of cats on a board of at most nine, so there are
 * never more than ten distinct positions on the track and collisions are the
 * normal case rather than an edge case — at the start of a level the entire
 * field is stacked on zero. Hiding that would be the bar's first lie.
 *
 * So markers at the same place share the height instead: three players on the
 * same cat become three stacked bands of colour at that point, which reads as
 * "three of them are here" without needing a number. `tolerance` is how close
 * two fractions have to be to count as the same place, expressed as a share of
 * the track.
 */
export const stackLanes = (racers: readonly Racer[], tolerance: number): Lane[] => {
  const step = tolerance > 0 ? tolerance : 0.01
  const counts = new Map<number, number>()
  for (const racer of racers) {
    const bucket = Math.round(racer.fraction / step)
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1)
  }
  const used = new Map<number, number>()
  return racers.map((racer) => {
    const bucket = Math.round(racer.fraction / step)
    const lane = used.get(bucket) ?? 0
    used.set(bucket, lane + 1)
    return { racer, lane, lanes: counts.get(bucket) ?? 1 }
  })
}

/**
 * How quickly a bar catches up with the truth, as a half-life in milliseconds.
 *
 * Deliberately asymmetric, and that asymmetry is the whole defence against a
 * bar that lies. Progress genuinely can fall — a player may take a cat back off
 * the board — so a retreating bar has to remain possible. But a fall is also
 * what a stale full-room snapshot looks like when it lands a moment after a
 * fresher progress tick: the value dips and the next tick, 250 ms later, puts
 * it back.
 *
 * Rising is therefore near-instant and falling is slow. A real retreat still
 * reads as a retreat, half a second later. A spurious one is corrected long
 * before the bar has travelled far enough to be noticed, so the two cases are
 * distinguished without the component needing to know which it is looking at.
 */
export const RISE_HALF_LIFE_MS = 70
export const FALL_HALF_LIFE_MS = 420

/** Below this, a bar is close enough to its target to be snapped onto it. */
const SETTLED = 0.0015

/** One racer's bar, moved towards where it should be after `dtMs`. */
export const approachFraction = (current: number, target: number, dtMs: number): number => {
  const delta = target - current
  if (Math.abs(delta) < SETTLED) return target
  const halfLife = delta > 0 ? RISE_HALF_LIFE_MS : FALL_HALF_LIFE_MS
  // Frame-rate independent exponential ease: the same journey takes the same
  // time whether the browser is giving us 120 frames a second or 24.
  return current + delta * (1 - Math.pow(2, -dtMs / halfLife))
}

/**
 * Every bar, moved one frame towards its target.
 *
 * Returns the array it was given, unchanged, when nothing moved. That identity
 * is load-bearing: the animation loop feeds this straight into `setState`, and
 * React drops an update that produces the same value, so a settled race costs
 * no renders at all while the loop idles.
 *
 * A change in the number of racers snaps rather than animates. There is no
 * sensible way to interpolate a player who was not there a frame ago.
 */
export const advanceFractions = (
  current: readonly number[],
  targets: readonly number[],
  dtMs: number,
): readonly number[] => {
  if (current.length !== targets.length) return targets
  let moved = false
  const next = targets.map((target, index) => {
    const from = current[index] ?? target
    const to = approachFraction(from, target, dtMs)
    if (to !== from) moved = true
    return to
  })
  return moved ? next : current
}
