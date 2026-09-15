/**
 * The clocks a race runs on.
 *
 * Three rules shape them.
 *
 * They tick in their own component. A clock showing tenths re-renders ten times
 * a second, and the screen it sits on holds a board of up to eighty-one cells;
 * putting the ticking state in the screen would re-render all of it, ten times
 * a second, for the whole level. Each clock therefore owns its own interval and
 * nothing above it re-renders at all.
 *
 * They read the right clock. Anything counting down is counting down to a
 * *server* timestamp and goes through `remainingMs`, which subtracts the
 * measured offset between this device's clock and the server's. Anything
 * counting up is measuring against a local mark and must not be offset, or a
 * phone whose clock is a minute out would show a minute of elapsed time the
 * moment a level opened.
 *
 * They do not change width as they run. Digits are tabular, and a countdown
 * shows minutes and seconds all the way down rather than switching to tenths
 * near the end, because a clock that reflows while the player is reading it is
 * worse than one that is slightly less exciting.
 */

import { useEffect, useState } from 'react'
import { remainingMs } from '../../multiplayer/store'
import { formatDuration } from './format'

/** Below this the clock is drawn as a warning rather than as information. */
export const URGENT_MS = 15_000

/**
 * The current time, re-read on an interval.
 *
 * The interval is the component's whole cost, so it matches what is actually
 * displayed: 100 ms where tenths are shown, 250 ms where only seconds are.
 * Anything faster buys nothing a player can see.
 */
const useNow = (intervalMs: number): number => {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs])
  return now
}

const NUMERALS = { fontVariantNumeric: 'tabular-nums' } as const

/**
 * Time since a local mark, to a tenth of a second.
 *
 * This is blaze's headline: the running total the podium is ordered by, and so
 * the one number on screen worth watching climb.
 */
export function ElapsedClock({
  since,
  className = '',
}: {
  /** Local epoch milliseconds, or null before the clock has anything to measure. */
  since: number | null
  className?: string
}) {
  const now = useNow(100)
  const elapsed = since === null ? 0 : now - since
  return (
    <span className={className} style={NUMERALS} aria-label={`Elapsed ${formatDuration(elapsed)}`}>
      {formatDuration(elapsed, true)}
    </span>
  )
}

/**
 * Time left until a server deadline.
 *
 * Turns to the danger ink and pulses under `URGENT_MS`. The pulse is a CSS
 * animation rather than a JavaScript one precisely so that the app's global
 * reduced-motion rule switches it off without this component knowing.
 */
export function CountdownClock({
  deadlineAt,
  offsetMs,
  className = '',
}: {
  /** Server epoch milliseconds, or null when this phase has no deadline. */
  deadlineAt: number | null
  offsetMs: number
  className?: string
}) {
  const now = useNow(250)
  const left = remainingMs(deadlineAt, offsetMs, now)
  const urgent = deadlineAt !== null && left <= URGENT_MS
  return (
    <span
      className={className}
      style={{
        ...NUMERALS,
        color: urgent ? 'var(--mdk-danger-ink)' : 'inherit',
        animation: urgent ? 'mdkWobble 1s ease-in-out infinite' : 'none',
      }}
      aria-label={`${formatDuration(left)} left`}
    >
      {formatDuration(left)}
    </span>
  )
}

/**
 * Whole seconds left until a server timestamp, floored at zero.
 *
 * Used by the "get ready" three-two-one and by the interlude's own countdown,
 * both of which want a number to show and a moment to react to rather than a
 * formatted duration.
 */
export const useSecondsUntil = (serverMs: number | null, offsetMs: number): number => {
  const now = useNow(100)
  if (serverMs === null) return 0
  return Math.max(0, Math.ceil((serverMs - offsetMs - now) / 1000))
}

/** Milliseconds left until a server timestamp, for a draining bar. */
export const useRemainingUntil = (serverMs: number | null, offsetMs: number): number => {
  const now = useNow(250)
  return remainingMs(serverMs, offsetMs, now)
}
