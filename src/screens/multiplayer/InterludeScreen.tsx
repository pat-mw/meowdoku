/**
 * The pause between levels, and the reveal that justifies it.
 *
 * Steady and knockout both stop here; blaze never does. The pause exists so
 * that finishing a level means something beyond a number going up, and the two
 * modes use it for opposite things. Steady reveals who *won*. Knockout reveals
 * who is *gone*, which is a heavier thing and is given the bigger treatment:
 * the whole card, the cat greyed out, and the deflating cue the game already
 * uses for losing a board.
 *
 * Everything on this screen comes from the server's `LevelResult`, which is the
 * same object every client in the room received. Nobody is computing their own
 * version of who won.
 */

import { useEffect, useEffectEvent, useState } from 'react'
import type { LevelResult, PlayerId } from '../../multiplayer/protocol'
import { selectLastResult, useMultiplayerStore } from '../../multiplayer/store'
import { CatFace } from '../../ui/icons'
import { useSecondsUntil } from '../../ui/multiplayer/clocks'
import { PrimaryAction } from '../../ui/multiplayer/controls'
import { SCREEN_BOX } from '../../ui/multiplayer/layout'
import { playRaceCue, type RaceCueName } from '../../ui/multiplayer/cues'
import { formatFinishTime } from '../../ui/multiplayer/format'
import { OutMark } from '../../ui/multiplayer/icons'
import { racerColorsFor } from '../../ui/multiplayer/race'
import { ResultTable, type ResultRow } from '../../ui/multiplayer/ResultTable'

/** What a finish that was not a solve should say in a result row. */
const STATUS_NOTE = {
  solved: null,
  timeout: 'ran out of time',
  abandoned: 'left the level',
} as const

export function InterludeScreen() {
  const result = useMultiplayerStore(selectLastResult)
  const players = useMultiplayerStore((state) => state.players)
  const settings = useMultiplayerStore((state) => state.settings)
  const levelCount = useMultiplayerStore((state) => state.levelCount)
  const playerId = useMultiplayerStore((state) => state.playerId)
  const preferences = useMultiplayerStore((state) => state.preferences)
  const markReady = useMultiplayerStore((state) => state.markReady)

  const [ready, setReady] = useState(false)

  // One cue per level, chosen by what the reveal means *to this player*. An
  // effect event so that a preference change cannot replay it.
  const announce = useEffectEvent((name: RaceCueName) => playRaceCue(name, preferences))
  const levelIndex = result?.levelIndex ?? null
  const cue: RaceCueName | null =
    result === null
      ? null
      : result.eliminatedId !== null && result.eliminatedId === playerId
        ? 'eliminated'
        : result.winnerId !== null && result.winnerId === playerId
          ? 'levelWon'
          : 'reveal'

  useEffect(() => {
    if (levelIndex === null || cue === null) return
    announce(cue)
  }, [levelIndex, cue])

  if (result === null) {
    return (
      <section
        className="flex flex-1 flex-col items-center justify-center gap-3"
        role="status"
        style={{ animation: 'mdkFade .25s' }}
      >
        <CatFace className="h-[72px] w-[72px]" />
        <div className="text-base font-extrabold text-[var(--mdk-ink-muted)]">counting up…</div>
      </section>
    )
  }

  const colors = racerColorsFor(players.map((player) => player.id))
  const nameOf = (id: PlayerId): string =>
    players.find((player) => player.id === id)?.name ?? 'A cat who left'
  const colorOf = (id: PlayerId): string => colors.get(id) ?? 'var(--mdk-ink-faint)'

  const knockout = settings.mode === 'knockout'
  const remaining = players.filter((player) => player.eliminatedAtLevel === null).length
  // Steady is played for points, so every row carries the running total: the
  // level's result matters only in so far as it moved the table.
  const totalOf = (id: PlayerId): string | null => {
    if (knockout) return null
    const points = players.find((player) => player.id === id)?.points ?? 0
    return `${points} ${points === 1 ? 'point' : 'points'} so far`
  }
  const rows = resultRows(result, playerId, nameOf, colorOf, totalOf)

  return (
    <section
      className="flex min-h-0 flex-1 flex-col gap-3"
      style={{ ...SCREEN_BOX, animation: 'mdkFade .25s' }}
    >
      <div className="text-center text-[13px] font-extrabold uppercase tracking-wide text-[var(--mdk-ink-faint)]">
        Level {result.levelIndex + 1} of {levelCount}
      </div>

      {/* The reveal and the table scroll together; the countdown and the ready
          button do not. A full room of eight makes this list longer than a
          small phone, and the one control that ends the pause early must never
          be the thing below the fold. */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pb-1">
        {knockout ? (
          <KnockoutReveal
            eliminatedId={result.eliminatedId}
            isMe={result.eliminatedId !== null && result.eliminatedId === playerId}
            name={result.eliminatedId === null ? null : nameOf(result.eliminatedId)}
            remaining={remaining}
          />
        ) : (
          <WinnerReveal
            winnerId={result.winnerId}
            isMe={result.winnerId !== null && result.winnerId === playerId}
            name={result.winnerId === null ? null : nameOf(result.winnerId)}
            timeMs={winningTime(result)}
          />
        )}

        <div
          className="rounded-[var(--mdk-radius-card)] bg-[var(--mdk-card)] px-2.5 py-3"
          style={{ boxShadow: 'var(--mdk-shadow-card)' }}
        >
          <ResultTable rows={rows} caption="This level" />
        </div>
      </div>

      <div className="flex flex-none flex-col items-center gap-2">
        <NextLevelCountdown />
        <div className="w-full max-w-[260px]">
          <PrimaryAction
            disabled={ready}
            onClick={() => {
              setReady(true)
              markReady()
            }}
          >
            {ready ? 'Waiting for the others…' : 'Ready'}
          </PrimaryAction>
        </div>
      </div>
    </section>
  )
}

/** Steady's reveal: who took the level, and in what. */
function WinnerReveal({
  winnerId,
  isMe,
  name,
  timeMs,
}: {
  winnerId: PlayerId | null
  isMe: boolean
  name: string | null
  timeMs: number | null
}) {
  return (
    <div
      className="flex flex-col items-center gap-1 rounded-[var(--mdk-radius-card)] bg-[var(--mdk-card)] px-5 py-5 text-center"
      style={{ boxShadow: 'var(--mdk-shadow-card)', animation: 'mdkRise .3s' }}
    >
      <CatFace
        expression={winnerId === null ? 'calm' : 'happy'}
        className="h-[62px] w-[62px]"
        style={{ animation: winnerId === null ? 'none' : 'mdkBounce .6s' }}
      />
      <div className="text-[27px] font-black leading-tight text-[var(--mdk-ink)]">
        {winnerId === null ? 'Nobody solved it' : isMe ? 'You won the level!' : `${name} wins it`}
      </div>
      <div className="text-sm font-bold text-[var(--mdk-ink-muted)]">
        {winnerId === null
          ? 'The level ran out of time. No point awarded.'
          : `Solved in ${formatFinishTime(timeMs)} · one point`}
      </div>
    </div>
  )
}

/**
 * Knockout's reveal: who is gone.
 *
 * An elimination is the most consequential thing that happens in the mode, so
 * it gets the card to itself and the cat is drawn out rather than celebrating.
 * When it is the reader who is out, the copy says so first and explains second;
 * the spectator view they land on next is where the consolation lives.
 */
function KnockoutReveal({
  eliminatedId,
  isMe,
  name,
  remaining,
}: {
  eliminatedId: PlayerId | null
  isMe: boolean
  name: string | null
  remaining: number
}) {
  return (
    <div
      className="flex flex-col items-center gap-1 rounded-[var(--mdk-radius-card)] bg-[var(--mdk-card)] px-5 py-5 text-center"
      style={{ boxShadow: 'var(--mdk-shadow-card)', animation: 'mdkRise .3s' }}
    >
      <span className="relative inline-flex">
        <CatFace
          className="h-[62px] w-[62px]"
          style={{
            filter: eliminatedId === null ? 'none' : 'grayscale(1)',
            opacity: eliminatedId === null ? 1 : 0.55,
            animation: eliminatedId === null ? 'none' : 'mdkWobble .6s',
          }}
        />
        {eliminatedId === null ? null : <OutMark className="absolute -bottom-1 -right-1 h-7 w-7" />}
      </span>
      <div className="text-[27px] font-black leading-tight text-[var(--mdk-ink)]">
        {eliminatedId === null
          ? 'Everybody survives'
          : isMe
            ? 'You are knocked out'
            : `${name} is out`}
      </div>
      <div className="text-sm font-bold text-[var(--mdk-ink-muted)]">
        {eliminatedId === null
          ? 'Nobody was slowest this time.'
          : remaining <= 2
            ? 'Two cats left. Next level decides it.'
            : `${remaining} cats still in the race.`}
      </div>
    </div>
  )
}

/**
 * How long the pause has left.
 *
 * Its own component because it ticks ten times a second, and the table beside
 * it must not re-render at that rate for the sake of one digit.
 */
function NextLevelCountdown() {
  const phaseEndsAt = useMultiplayerStore((state) => state.phaseEndsAt)
  const serverOffsetMs = useMultiplayerStore((state) => state.serverOffsetMs)
  const seconds = useSecondsUntil(phaseEndsAt, serverOffsetMs)
  return (
    <div className="text-[13px] font-extrabold text-[var(--mdk-ink-muted)]" aria-live="off">
      {phaseEndsAt === null || seconds <= 0
        ? 'Next level starting…'
        : `Next level in ${seconds}s — or when everyone is ready`}
    </div>
  )
}

/** The winner's own elapsed time, out of the finishes the server recorded. */
const winningTime = (result: LevelResult): number | null =>
  result.finishes.find((finish) => finish.playerId === result.winnerId)?.elapsedMs ?? null

/**
 * The level's finishes as table rows, in the server's ranking order.
 *
 * `ranking` is the authority on order — it is what the mode's rules produced,
 * and re-sorting by time here would quietly disagree with it the moment two
 * players tie to the millisecond and the server broke it by arrival order.
 */
const resultRows = (
  result: LevelResult,
  playerId: PlayerId | null,
  nameOf: (id: PlayerId) => string,
  colorOf: (id: PlayerId) => string,
  totalOf: (id: PlayerId) => string | null,
): ResultRow[] =>
  result.ranking.map((id, index) => {
    const finish = result.finishes.find((entry) => entry.playerId === id) ?? null
    const note = (finish === null ? 'did not finish' : STATUS_NOTE[finish.status]) ?? totalOf(id)
    const out = id === result.eliminatedId
    return {
      key: id,
      place: index + 1,
      name: id === playerId ? `${nameOf(id)} (you)` : nameOf(id),
      color: colorOf(id),
      value: out ? 'OUT' : formatFinishTime(finish?.elapsedMs ?? null),
      note: note ?? undefined,
      tone: out ? 'out' : id === result.winnerId ? 'winner' : 'normal',
      isMe: id === playerId,
    }
  })
