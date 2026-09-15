import { REGION_KEYS } from '../../board/types'
import { CatPip } from '../icons'
import { REGION_COLORS } from '../palette'
import { Badge } from './controls'

/**
 * Who is in the room.
 *
 * Each player gets one of the board's own region colours as an avatar, taken in
 * order from `REGION_KEYS`. The palette is already proven to be distinguishable
 * at a glance — it exists so that neighbouring regions on a 15x15 board are
 * never a close call — so eight players in a list are trivially so, and reusing
 * it means multiplayer introduces no new colour of its own. The assignment is
 * positional and every client sorts the roster the same way, so a player is the
 * same colour on everybody's screen.
 *
 * The empty seats are drawn rather than implied. A room's capacity is part of
 * what the host is deciding about when they choose a mode, and "three of eight"
 * reads faster as five outlines than as a sentence.
 */

export type PlayerRow = {
  id: string
  name: string
  isHost: boolean
  isYou: boolean
  /** False while a player is dropped but still inside their reconnection grace. */
  connected: boolean
  /** Trailing detail: a score, a placing, whatever the screen is about. */
  detail?: string
}

/** The avatar colour for a seat, cycling if a room ever grows past the palette. */
export const seatColor = (index: number): string => {
  const key = REGION_KEYS[index % REGION_KEYS.length]
  return key === undefined ? 'var(--mdk-surface-sunken)' : REGION_COLORS[key]
}

export function PlayerList({
  players,
  capacity,
  label = 'Players',
}: {
  players: readonly PlayerRow[]
  /** Total seats. Anything past `players.length` is drawn as an empty seat. */
  capacity?: number
  label?: string
}) {
  const empty = capacity === undefined ? 0 : Math.max(0, capacity - players.length)

  return (
    <ul aria-label={label} className="flex list-none flex-col gap-1.5 p-0">
      {players.map((player, index) => (
        <li
          key={player.id}
          className="flex items-center gap-2.5 rounded-[var(--mdk-radius-panel)] bg-[var(--mdk-card)] px-3 py-2.5"
          style={{ boxShadow: 'var(--mdk-shadow-card)' }}
        >
          <span
            aria-hidden="true"
            className="flex h-9 w-9 flex-none items-center justify-center rounded-full"
            style={{ background: seatColor(index) }}
          >
            <CatPip className="h-6 w-6" fill="var(--mdk-cat-body)" />
          </span>

          <span className="min-w-0 flex-1 truncate text-[16px] font-extrabold text-[var(--mdk-ink-strong)]">
            {player.name}
          </span>

          {player.detail !== undefined ? (
            <span className="flex-none text-[14px] font-extrabold text-[var(--mdk-ink-muted)]">
              {player.detail}
            </span>
          ) : null}
          {/* A dropped player has not left: they keep their seat, their place in
              the match and their clock until the grace period runs out, so the
              row says what is happening rather than removing them. */}
          {player.connected ? null : (
            <span className="flex-none text-[13px] font-extrabold text-[var(--mdk-ink-muted)]">
              Reconnecting…
            </span>
          )}
          {player.isYou ? <Badge>You</Badge> : null}
          {player.isHost ? <Badge tone="loud">Host</Badge> : null}
        </li>
      ))}

      {Array.from({ length: empty }, (_, index) => (
        <li
          key={`empty-${index}`}
          className="flex items-center gap-2.5 rounded-[var(--mdk-radius-panel)] px-3 py-2.5"
          style={{ boxShadow: 'inset 0 0 0 2px var(--mdk-surface-sunken)' }}
        >
          <span
            aria-hidden="true"
            className="h-9 w-9 flex-none rounded-full bg-[var(--mdk-surface-sunken)]"
          />
          <span className="flex-1 text-[15px] font-bold text-[var(--mdk-ink-muted)]">
            Empty seat
          </span>
        </li>
      ))}
    </ul>
  )
}
