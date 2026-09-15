/**
 * The live progress race: the feature multiplayer exists for.
 *
 * Its job is tension. A player mid-solve gets perhaps a third of a second of
 * attention to spare, so the whole thing has to be readable in a glance taken
 * without lifting a finger off the board, and it has to keep moving so that the
 * glance is worth taking.
 *
 * ---------------------------------------------------------------------------
 * Why one track and not eight bars
 *
 * Eight labelled bars is the obvious design and it does not fit. At the room
 * limit that is eight rows of name plus bar plus count — around 240 px, two
 * thirds of the height a 9x9 board needs on a 360 px phone, for information
 * the player cannot read while solving anyway.
 *
 * So the strip is a single track that everybody runs on. Your own progress is
 * the filled bar, every opponent is a marker travelling along the same track,
 * and the two things that must always be legible — where you are, and who is
 * in front — are named in words above it. Two lines, about 46 px, which the
 * screen affords because a multiplayer board carries no hint or reveal buttons
 * and so has 72 px of the single-player layout back to spend.
 *
 * The same component draws a `full` variant: one labelled row per player, used
 * where there is no board competing for the height — the interlude, and the
 * spectator view a knocked-out player watches the rest of the match on.
 *
 * ---------------------------------------------------------------------------
 * Why markers stack
 *
 * Progress is a count of cats on a board of at most nine, so the track has ten
 * distinct positions and collisions are the normal case: at the start of every
 * level the entire field is on zero. Markers therefore share the track's height
 * rather than overlap, so three players on the same cat read as three stacked
 * bands. See `stackLanes`.
 *
 * ---------------------------------------------------------------------------
 * Why the bar does not lie
 *
 * Progress arrives over a network four times a second and a player's own count
 * genuinely can fall, because a cat can come back off the board. What must not
 * happen is a bar that jumps backwards because a full-room snapshot landed a
 * moment after a fresher tick — that reads as a bug and costs the bar its
 * credibility. Rising is therefore near-instant and falling is slow (see
 * `RISE_HALF_LIFE_MS`), which lets a real retreat show while a spurious one is
 * corrected before it has travelled anywhere. Your own bar is read from your
 * own board rather than from the server's echo of it, so the one marker whose
 * accuracy you can personally check has no latency at all.
 */

import { useEffect, useEffectEvent, useState } from 'react'
import { catIndices } from '../../board/rules'
import { isSyncedMode } from '../../multiplayer/match'
import { useMultiplayerStore } from '../../multiplayer/store'
import { ordinal } from './format'
import { Collar, Crown } from './icons'
import { useReducedMotion } from './motion'
import {
  type Racer,
  type RacerInput,
  type RaceShape,
  advanceFractions,
  buildRacers,
  stackLanes,
} from './race'

/** Track height in the strip. Tall enough that eight stacked lanes still read. */
const TRACK_HEIGHT = 22
/** Track height in the full variant, where each row holds exactly one racer. */
const ROW_TRACK_HEIGHT = 10
/** Width of an opponent's marker. Also how far the travel is inset at each end. */
const MARKER_WIDTH = 6

/**
 * How close two racers have to be to share a position, as a share of the track.
 *
 * A twentieth is narrower than one cat on the smallest board multiplayer plays
 * (a fifth of a 5x5) and narrower than one level in the longest blaze match (a
 * tenth), so two racers only ever share lanes when they genuinely share a
 * position — never merely because they are near one another.
 */
const COLLISION_TOLERANCE = 0.05

export type ProgressRaceVariant = 'strip' | 'full'

export type ProgressRaceProps = {
  /** `strip` sits above the board mid-level; `full` is the labelled leaderboard. */
  variant?: ProgressRaceVariant
}

/**
 * The field, assembled from the room and from this client's own board.
 *
 * Everyone else comes from the server's progress map; you come from the board
 * in front of you, which is both fresher and unarguable.
 */
const useRacers = (): { racers: Racer[]; shape: RaceShape; resetKey: string } => {
  const players = useMultiplayerStore((state) => state.players)
  const progress = useMultiplayerStore((state) => state.progress)
  const schedule = useMultiplayerStore((state) => state.schedule)
  const settings = useMultiplayerStore((state) => state.settings)
  const levelCount = useMultiplayerStore((state) => state.levelCount)
  const roomLevelIndex = useMultiplayerStore((state) => state.levelIndex)
  const playerId = useMultiplayerStore((state) => state.playerId)
  const myLevelIndex = useMultiplayerStore((state) => state.myLevelIndex)
  const game = useMultiplayerStore((state) => state.game)

  const shape: RaceShape = { synced: isSyncedMode(settings), levelCount }

  const inputs: RacerInput[] = players.map((player) => {
    // Your own board beats the server's echo of it: it is a frame old rather
    // than a round trip old, and it is the one marker a player can check.
    const mine = player.id === playerId ? game : null
    const sample = progress[player.id]
    const levelIndex = mine === null ? (sample?.levelIndex ?? player.levelIndex) : myLevelIndex
    const cats = mine === null ? (sample?.cats ?? player.progress) : catIndices(mine.cells).length
    const size = mine === null ? (schedule?.[levelIndex]?.size ?? 0) : mine.size
    return {
      id: player.id,
      name: player.name,
      cats,
      size,
      levelIndex,
      connected: player.connected,
      eliminatedAtLevel: player.eliminatedAtLevel,
    }
  })

  // A synced mode puts everyone back on zero at the start of each level, and a
  // bar sliding backwards for two seconds is not an animation anybody wanted;
  // remounting the track on the level snaps it instead. Blaze has no such
  // moment — its fractions only ever climb — so its bars stay continuous.
  const resetKey = shape.synced ? `${players.length}:${roomLevelIndex}` : `${players.length}:blaze`

  return { racers: buildRacers(inputs, shape, playerId), shape, resetKey }
}

/**
 * Eases every bar towards where it should be, one animation frame at a time.
 *
 * `advanceFractions` returns the array it was handed when nothing moved, so a
 * settled race costs no renders: the loop keeps turning but React drops every
 * update. That is what makes it affordable to leave running for a whole level.
 * Under reduced motion the loop never starts and the targets are used directly.
 */
const useRaceMotion = (racers: readonly Racer[], enabled: boolean): readonly number[] => {
  const targets = racers.map((racer) => racer.fraction)
  const [shown, setShown] = useState<readonly number[]>(targets)

  // An effect event so the loop always eases towards the newest targets without
  // the effect — and therefore the whole animation — restarting four times a
  // second as progress ticks arrive.
  const advance = useEffectEvent((dtMs: number) => {
    setShown((current) => advanceFractions(current, targets, dtMs))
  })

  useEffect(() => {
    if (!enabled) return undefined
    let frame = 0
    let last = performance.now()
    const step = (at: number): void => {
      // Clamped so that a tab returning from the background does not resolve a
      // minute of elapsed time into one enormous jump.
      const dt = Math.min(at - last, 200)
      last = at
      advance(dt)
      frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [enabled])

  return enabled ? shown : targets
}

/** Where a marker's left edge goes, inset so it never hangs off either end. */
const markerLeft = (fraction: number): string =>
  `calc(${(fraction * 100).toFixed(2)}% - ${(fraction * MARKER_WIDTH).toFixed(2)}px)`

export function ProgressRace({ variant = 'strip' }: ProgressRaceProps) {
  const { racers, shape, resetKey } = useRacers()
  if (racers.length === 0) return null
  return variant === 'full' ? (
    <RaceBoard key={resetKey} racers={racers} shape={shape} />
  ) : (
    <RaceStrip key={resetKey} racers={racers} shape={shape} />
  )
}

/** The mid-level glance: a headline, one shared track, and the field as text. */
function RaceStrip({ racers, shape }: { racers: Racer[]; shape: RaceShape }) {
  const reduced = useReducedMotion()
  const shown = useRaceMotion(racers, !reduced)

  const me = racers.find((racer) => racer.isMe) ?? null
  const leader = racers.find((racer) => racer.isLeader) ?? null
  const running = racers.filter((racer) => !racer.out)
  const lanes = stackLanes(
    running.filter((racer) => !racer.isMe),
    COLLISION_TOLERANCE,
  )
  const shownOf = (racer: Racer): number => shown[racers.indexOf(racer)] ?? racer.fraction

  return (
    <section aria-label="Race progress" className="flex flex-col gap-[5px]">
      <div className="flex items-center justify-between gap-2 text-[13px] font-extrabold leading-none">
        <span className="flex items-center gap-1.5 text-[var(--mdk-ink-strong)]">
          {me === null ? (
            <span className="text-[var(--mdk-ink-muted)]">Watching {running.length} racers</span>
          ) : me.out ? (
            <span className="text-[var(--mdk-ink-muted)]">Out of the race</span>
          ) : (
            <>
              <Collar className="h-3.5 w-3.5 flex-none" color={me.color} />
              <span>You</span>
              <span className="tabular-nums">{progressLabel(me, shape)}</span>
              <span className="text-[var(--mdk-ink-muted)]">{ordinal(me.place)}</span>
            </>
          )}
        </span>
        <span className="flex min-w-0 items-center gap-1.5">
          {leader === null ? (
            <span className="text-[var(--mdk-ink-muted)]">{running.length} in the race</span>
          ) : (
            <>
              <Crown className="h-3.5 w-[17px] flex-none" />
              <span className="truncate text-[var(--mdk-ink-strong)]">
                {leader.isMe ? 'You lead' : leader.name}
              </span>
              <span className="flex-none tabular-nums text-[var(--mdk-ink-muted)]">
                {progressLabel(leader, shape)}
              </span>
            </>
          )}
        </span>
      </div>

      <div
        className="relative w-full rounded-full bg-[var(--mdk-surface-sunken)]"
        style={{ height: TRACK_HEIGHT }}
        aria-hidden="true"
      >
        {me !== null && !me.out ? (
          <div
            className="absolute left-0 top-0 rounded-full"
            style={{ height: TRACK_HEIGHT, width: `${shownOf(me) * 100}%`, background: me.color }}
          />
        ) : null}
        {lanes.map(({ racer, lane, lanes: count }) => (
          <div
            key={racer.id}
            className="absolute rounded-[3px]"
            style={{
              left: markerLeft(shownOf(racer)),
              top: `${(lane / count) * TRACK_HEIGHT}px`,
              width: MARKER_WIDTH,
              height: TRACK_HEIGHT / count,
              background: racer.color,
              opacity: racer.connected ? 1 : 0.4,
              // Every marker carries a hairline in the card colour. Behind your
              // own position a marker is drawn on top of your filled bar rather
              // than on the empty track, and two racer colours need only differ
              // slightly in lightness to be a legitimate pair; the outline is
              // what keeps a marker a distinct shape on either background. The
              // leader's gold ring sits outside it.
              boxShadow: racer.isLeader
                ? '0 0 0 1px var(--mdk-card), 0 0 0 3px var(--mdk-gold)'
                : '0 0 0 1px var(--mdk-card)',
            }}
          />
        ))}
        {/* The finish line, so the far end of the track reads as an ending. */}
        <div
          className="absolute right-0 top-0 rounded-full"
          style={{
            width: 3,
            height: TRACK_HEIGHT,
            background: 'var(--mdk-ink-faint)',
            opacity: 0.4,
          }}
        />
      </div>

      <StandingsForScreenReaders racers={racers} shape={shape} />
    </section>
  )
}

/**
 * The labelled leaderboard.
 *
 * Sorted by position, because this variant is read at leisure rather than
 * glanced at, and a reader who has time wants the order. The strip deliberately
 * does the opposite and keeps roster order, so its markers never swap places.
 */
function RaceBoard({ racers, shape }: { racers: Racer[]; shape: RaceShape }) {
  const reduced = useReducedMotion()
  const shown = useRaceMotion(racers, !reduced)
  const rows = racers
    .map((racer, index) => ({ racer, shown: shown[index] ?? racer.fraction }))
    .sort((a, b) => {
      if (a.racer.out !== b.racer.out) return a.racer.out ? 1 : -1
      return a.racer.place - b.racer.place
    })

  return (
    <ol className="flex flex-col gap-2" aria-label="Standings">
      {rows.map(({ racer, shown: fraction }) => (
        <li
          key={racer.id}
          className="flex items-center gap-2"
          style={{ opacity: racer.out ? 0.45 : racer.connected ? 1 : 0.6 }}
        >
          <span className="w-4 flex-none text-right text-[12px] font-black leading-none text-[var(--mdk-ink-faint)]">
            {racer.out ? '·' : racer.place}
          </span>
          <Collar className="h-3 w-3 flex-none" color={racer.color} />
          <span className="min-w-0 flex-1 truncate text-[13px] font-extrabold leading-none text-[var(--mdk-ink-strong)]">
            {racer.isMe ? `${racer.name} (you)` : racer.name}
            {racer.connected ? '' : ' · away'}
          </span>
          {racer.isLeader ? <Crown className="h-3 w-[15px] flex-none" /> : null}
          <div
            className="relative w-[34%] flex-none rounded-full bg-[var(--mdk-surface-sunken)]"
            style={{ height: ROW_TRACK_HEIGHT }}
            aria-hidden="true"
          >
            <div
              className="absolute left-0 top-0 rounded-full"
              style={{
                height: ROW_TRACK_HEIGHT,
                width: `${fraction * 100}%`,
                background: racer.color,
              }}
            />
          </div>
          <span className="w-9 flex-none text-right text-[12px] font-extrabold leading-none tabular-nums text-[var(--mdk-ink-muted)]">
            {racer.out ? 'out' : progressLabel(racer, shape)}
          </span>
        </li>
      ))}
    </ol>
  )
}

/** What a racer's number says: cats on this board, or levels through the match. */
const progressLabel = (racer: Racer, shape: RaceShape): string =>
  shape.synced
    ? `${racer.cats}/${racer.size > 0 ? racer.size : '?'}`
    : `L${racer.levelIndex + 1}·${racer.cats}`

/**
 * The whole field, in words.
 *
 * The track itself is `aria-hidden`: a row of coloured rectangles has nothing
 * useful to say to a screen reader, and eight of them have less. This says it
 * instead, and it is deliberately *not* a live region — progress changes four
 * times a second, and announcing that would bury the board under the race.
 * A player reads the standings when they choose to, as they would a caption.
 */
function StandingsForScreenReaders({ racers, shape }: { racers: Racer[]; shape: RaceShape }) {
  const ordered = racers.filter((racer) => !racer.out).sort((a, b) => a.place - b.place)
  return (
    <ol className="sr-only">
      {ordered.map((racer) => (
        <li key={racer.id}>
          {ordinal(racer.place)}: {racer.isMe ? 'you' : racer.name}, {racer.cats} cats placed
          {shape.synced && racer.size > 0 ? ` of ${racer.size}` : ''}
          {shape.synced ? '' : ` on level ${racer.levelIndex + 1}`}
        </li>
      ))}
    </ol>
  )
}
