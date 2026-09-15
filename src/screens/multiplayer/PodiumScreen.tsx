/**
 * The final result.
 *
 * The three modes are won for three different reasons and the podium has to say
 * which — a blaze champion was fastest over the whole schedule, a steady
 * champion took the most levels, a knockout champion simply outlasted everyone.
 * Showing all three the same way would flatten the only thing that made the
 * modes worth having.
 *
 * The podium itself is a podium: three blocks of different heights, because
 * that shape says "these three, in this order" before a word has been read, and
 * because on a phone it is the one arrangement that puts first place in the
 * middle where the eye already is. Everyone from fourth down is a table, which
 * is what fourth place deserves and no less.
 *
 * `PodiumEntry.place` comes from the server. Nothing here re-ranks anybody.
 */

import { useEffect, useEffectEvent } from 'react'
import type { GameMode, PodiumEntry, PlayerId } from '../../multiplayer/protocol'
import { selectPodium, useMultiplayerStore } from '../../multiplayer/store'
import { QuietButton } from '../../ui/chrome'
import { Confetti } from '../../ui/Confetti'
import { CatFace } from '../../ui/icons'
import { PrimaryAction } from '../../ui/multiplayer/controls'
import { SCREEN_BOX } from '../../ui/multiplayer/layout'
import { playRaceCue, type RaceCueName } from '../../ui/multiplayer/cues'
import { formatDuration, ordinal } from '../../ui/multiplayer/format'
import { Crown } from '../../ui/multiplayer/icons'
import { racerColorsFor } from '../../ui/multiplayer/race'
import { ResultTable, type ResultRow } from '../../ui/multiplayer/ResultTable'

/** Block heights for second, first and third, in the order they are drawn. */
const BLOCK_HEIGHT: Record<number, number> = { 1: 82, 2: 58, 3: 44 }

const MODE_SUMMARY: Record<GameMode, string> = {
  blaze: 'Fastest over the whole schedule',
  steady: 'Most levels won',
  knockout: 'Last cat standing',
}

export type PodiumScreenProps = {
  /** Leaves the room for good. */
  onLeave: () => void
  /**
   * Takes the whole room back to its lobby for another match — it is a request
   * to the server, not a local navigation, so everybody moves together and the
   * scores reset for all of them at once. Any player in the room may ask.
   *
   * Omitted when the room cannot be reused, which is either a connection that
   * is down or a client with no seat: the button is then simply absent rather
   * than present and dead.
   */
  onRematch?: (() => void) | undefined
}

export function PodiumScreen({ onLeave, onRematch }: PodiumScreenProps) {
  const podium = useMultiplayerStore(selectPodium)
  const players = useMultiplayerStore((state) => state.players)
  const settings = useMultiplayerStore((state) => state.settings)
  const playerId = useMultiplayerStore((state) => state.playerId)
  const preferences = useMultiplayerStore((state) => state.preferences)

  const champion = podium?.find((entry) => entry.place === 1) ?? null
  const iWon = champion !== null && champion.playerId === playerId
  const settled = podium !== null

  // Once, when the podium arrives. Winning gets the fanfare; everybody else
  // gets the warm swell rather than the fail cue, because finishing a match is
  // not losing a board.
  const announce = useEffectEvent((name: RaceCueName) => playRaceCue(name, preferences))
  useEffect(() => {
    if (!settled) return
    announce(iWon ? 'champion' : 'podium')
  }, [settled, iWon])

  if (podium === null || podium.length === 0) {
    // A beat between the last level closing and the standings arriving. It
    // still carries a way out: a room that somehow never sends a podium would
    // otherwise be a screen with no buttons on it at all.
    return (
      <section
        className="flex flex-1 flex-col items-center justify-center gap-3"
        style={{ animation: 'mdkFade .25s' }}
      >
        <div className="flex flex-col items-center gap-3" role="status">
          <CatFace className="h-[72px] w-[72px]" />
          <div className="text-base font-extrabold text-[var(--mdk-ink-muted)]">adding it up…</div>
        </div>
        <QuietButton onClick={onLeave}>Leave the room</QuietButton>
      </section>
    )
  }

  const colors = racerColorsFor(players.map((player) => player.id))
  const nameOf = (id: PlayerId): string =>
    players.find((player) => player.id === id)?.name ?? 'A cat who left'
  const colorOf = (id: PlayerId): string => colors.get(id) ?? 'var(--mdk-ink-faint)'

  const ordered = [...podium].sort((a, b) => a.place - b.place)
  const top = ordered.filter((entry) => entry.place <= 3)
  const rest = ordered.filter((entry) => entry.place > 3)
  // Second, first, third: the order they stand in, not the order they finished.
  const arranged = [2, 1, 3]
    .map((place) => top.find((entry) => entry.place === place) ?? null)
    .filter((entry): entry is PodiumEntry => entry !== null)

  const me = ordered.find((entry) => entry.playerId === playerId) ?? null

  return (
    <section
      className="flex min-h-0 flex-1 flex-col gap-3"
      style={{ ...SCREEN_BOX, animation: 'mdkFade .25s' }}
    >
      {iWon ? <Confetti seed={podium.length} /> : null}

      <div className="flex-none text-center">
        <div className="text-[13px] font-extrabold uppercase tracking-wide text-[var(--mdk-ink-faint)]">
          {MODE_SUMMARY[settings.mode]}
        </div>
        <h1 className="text-[32px] font-black leading-tight text-[var(--mdk-ink)]">
          {iWon
            ? 'You win!'
            : champion === null
              ? 'Match over'
              : `${nameOf(champion.playerId)} wins`}
        </h1>
        {me === null || me.place === 1 ? null : (
          <div className="text-sm font-extrabold text-[var(--mdk-ink-muted)]">
            You finished {ordinal(me.place)} of {ordered.length}
          </div>
        )}
      </div>

      {/* A room of eight makes the tail longer than a small phone. It scrolls;
          the two buttons that decide what happens next never do. */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pb-1">
        <div
          className="flex flex-none items-end justify-center gap-2 rounded-[var(--mdk-radius-card)] bg-[var(--mdk-card)] px-3 pb-3 pt-4"
          style={{ boxShadow: 'var(--mdk-shadow-card)' }}
        >
          {arranged.map((entry) => (
            <PodiumBlock
              key={entry.playerId}
              entry={entry}
              mode={settings.mode}
              name={nameOf(entry.playerId)}
              color={colorOf(entry.playerId)}
              isMe={entry.playerId === playerId}
            />
          ))}
        </div>

        {rest.length === 0 ? null : (
          <div
            className="flex-none rounded-[var(--mdk-radius-card)] bg-[var(--mdk-card)] px-2.5 py-3"
            style={{ boxShadow: 'var(--mdk-shadow-card)' }}
          >
            <ResultTable
              caption="And the rest"
              rows={rest.map((entry) => podiumRow(entry, settings.mode, nameOf, colorOf, playerId))}
            />
          </div>
        )}
      </div>

      <div className="flex flex-none flex-col gap-1">
        {onRematch === undefined ? null : (
          <PrimaryAction onClick={onRematch}>Play again</PrimaryAction>
        )}
        <QuietButton onClick={onLeave}>Leave the room</QuietButton>
      </div>
    </section>
  )
}

/** One of the three standing on the podium. */
function PodiumBlock({
  entry,
  mode,
  name,
  color,
  isMe,
}: {
  entry: PodiumEntry
  mode: GameMode
  name: string
  color: string
  isMe: boolean
}) {
  const stat = podiumStat(entry, mode)
  const first = entry.place === 1
  return (
    <div className="flex min-w-0 flex-1 flex-col items-center gap-1">
      {first ? <Crown className="h-4 w-[19px]" /> : null}
      <CatFace
        expression={first ? 'happy' : 'calm'}
        className={first ? 'h-12 w-12' : 'h-9 w-9'}
        style={{
          filter: entry.status === 'left' ? 'grayscale(1)' : 'none',
          opacity: entry.status === 'left' ? 0.5 : 1,
          animation: first ? 'mdkBounce .7s' : 'none',
        }}
      />
      <div className="w-full truncate text-center text-[13px] font-extrabold text-[var(--mdk-ink-strong)]">
        {isMe ? 'You' : name}
      </div>
      {/* The racer's colour is the block's cap rather than its fill. Region
          colours do not change between themes while the inks do, so text drawn
          on one is readable in at most one of them; every figure here sits on
          the sunken surface instead, which is a pairing the contrast test
          already measures. */}
      <div
        className="flex w-full flex-col items-center justify-start overflow-hidden rounded-t-[var(--mdk-radius-tile)] bg-[var(--mdk-surface-sunken)]"
        style={{ height: BLOCK_HEIGHT[entry.place] ?? 40 }}
      >
        <span aria-hidden="true" className="h-1.5 w-full flex-none" style={{ background: color }} />
        <span className="mt-1 text-[19px] font-black leading-none text-[var(--mdk-ink)]">
          {entry.place}
        </span>
        <span className="mt-1 px-1 text-center text-[11px] font-black leading-tight text-[var(--mdk-ink)]">
          {stat.value}
        </span>
      </div>
    </div>
  )
}

/**
 * What a placing is worth, in the units the mode was played in.
 *
 * Blaze is a time trial, so the figure is the total; steady is scored, so it is
 * points; knockout is survival, so it is how far they got. Each mode's podium
 * therefore answers the question that mode was actually asking.
 */
const podiumStat = (entry: PodiumEntry, mode: GameMode): { value: string; note: string } => {
  if (mode === 'blaze') {
    return {
      value: formatDuration(entry.totalTimeMs, true),
      note: `${entry.levelsSolved} solved`,
    }
  }
  if (mode === 'steady') {
    return {
      value: `${entry.points} pt`,
      note: `${entry.levelsSolved} levels solved`,
    }
  }
  return {
    value: entry.status === 'champion' ? 'survived' : `lvl ${entry.eliminatedAtLevel ?? '—'}`,
    note:
      entry.status === 'champion'
        ? 'Last cat standing'
        : entry.status === 'left'
          ? 'Left the match'
          : `Knocked out on level ${entry.eliminatedAtLevel ?? '?'}`,
  }
}

const podiumRow = (
  entry: PodiumEntry,
  mode: GameMode,
  nameOf: (id: PlayerId) => string,
  colorOf: (id: PlayerId) => string,
  playerId: PlayerId | null,
): ResultRow => {
  const stat = podiumStat(entry, mode)
  return {
    key: entry.playerId,
    place: entry.place,
    name: entry.playerId === playerId ? `${nameOf(entry.playerId)} (you)` : nameOf(entry.playerId),
    color: colorOf(entry.playerId),
    value: stat.value,
    note: stat.note,
    tone: entry.status === 'knocked-out' || entry.status === 'left' ? 'out' : 'normal',
    isMe: entry.playerId === playerId,
  }
}
