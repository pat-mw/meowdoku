/**
 * Playing a level against other people.
 *
 * The board, the gestures and the rules are the single-player ones, unforked:
 * the same `Board`, the same `useBoardPointer` and `useBoardKeyboard`, the same
 * pure reducer reached through the multiplayer store's `dispatch`. What this
 * screen adds is everything around them — the race, the clock, and the three
 * different rhythms the three modes have.
 *
 * ---------------------------------------------------------------------------
 * What single-player affordances do not survive a race, and why
 *
 * Hints and reveals are gone, and the multiplayer store creates every board
 * with none of either. A reveal places a cat for free and a hint is a solver
 * talking out loud; in a race neither is a power-up, both are simply a faster
 * way to win, and a mode whose winner is whoever spent their hints first is not
 * a puzzle. Removing the pair also returns 72 px of screen, which is what pays
 * for the race strip.
 *
 * Lives stay, at five instead of three, and running out no longer ends
 * anything. In single-player, failing is the level's ending. In a race it
 * cannot be: a player whose board is dead would sit and watch for the rest of
 * a two-minute deadline, and in blaze — which has no per-level deadline — they
 * would stall the entire room. So the board resets instead and the player
 * carries on with the same level. The punishment is the seconds and the work,
 * which in a race is a heavy punishment; being knocked out of a match by a
 * mis-tap on a phone would not be.
 *
 * ---------------------------------------------------------------------------
 * The three rhythms
 *
 * BLAZE never pauses. The store opens the next board the moment the server
 * accepts a solve, so the screen's job is to make that roll-on legible — a
 * total-time clock that never stops, and a one-beat card naming the level just
 * banked while the next one is built.
 *
 * STEADY waits. Finishing is not the end of the level, it is the start of
 * waiting for it, so the wait is shown honestly: your time, how many people are
 * still solving, and their bars still moving.
 *
 * KNOCKOUT is steady with a different stake, and once you are out it is a
 * different screen entirely — the board goes away and the whole field becomes a
 * labelled leaderboard, which is the best view of the match anybody has.
 */

import { useEffect, useEffectEvent, useState } from 'react'
import { createGame } from '../../board/reducer'
import { type CellState } from '../../board/types'
import { useBoardKeyboard } from '../../input/useBoardKeyboard'
import { useBoardPointer, type BoardGesture } from '../../input/useBoardPointer'
import { isSyncedMode } from '../../multiplayer/match'
import type { GameMode } from '../../multiplayer/protocol'
import {
  MULTIPLAYER_LIVES,
  selectGame,
  selectMe,
  selectPhase,
  toLocalTime,
  useMultiplayerStore,
} from '../../multiplayer/store'
import { useGameStore } from '../../store/useGameStore'
import { Board } from '../../ui/Board'
import { BackButton, DangerButton, Overlay, Pill, PrimaryButton } from '../../ui/chrome'
import { CatFace, CatPip, Fish } from '../../ui/icons'
import { CountdownClock, ElapsedClock, useSecondsUntil } from '../../ui/multiplayer/clocks'
import { playRaceCue } from '../../ui/multiplayer/cues'
import { formatDuration } from '../../ui/multiplayer/format'
import { ProgressRace } from '../../ui/multiplayer/ProgressRace'

/** A stable empty board, so the input hooks never see a fresh array identity. */
const EMPTY_CELLS: readonly CellState[] = []

const MODE_LABEL: Record<GameMode, string> = {
  blaze: 'Blaze',
  steady: 'Steady',
  knockout: 'Knockout',
}

export type MatchScreenProps = {
  /**
   * Called once the player has confirmed they want out. Leaving mid-match
   * forfeits the level in progress, so the screen asks first and this is only
   * ever reached from the answer.
   */
  onLeave: () => void
}

export function MatchScreen({ onLeave }: MatchScreenProps) {
  const phase = useMultiplayerStore(selectPhase)
  const settings = useMultiplayerStore((state) => state.settings)
  const levelCount = useMultiplayerStore((state) => state.levelCount)
  const roomLevelIndex = useMultiplayerStore((state) => state.levelIndex)
  const myLevelIndex = useMultiplayerStore((state) => state.myLevelIndex)
  const game = useMultiplayerStore(selectGame)
  const level = useMultiplayerStore((state) => state.level)
  const loadingLevel = useMultiplayerStore((state) => state.loadingLevel)
  const levelError = useMultiplayerStore((state) => state.levelError)
  const levelStartedAt = useMultiplayerStore((state) => state.levelStartedAt)
  const levelDeadlineAt = useMultiplayerStore((state) => state.levelDeadlineAt)
  const matchStartsAt = useMultiplayerStore((state) => state.matchStartsAt)
  const serverOffsetMs = useMultiplayerStore((state) => state.serverOffsetMs)
  const accepted = useMultiplayerStore((state) => state.accepted)
  const players = useMultiplayerStore((state) => state.players)
  const me = useMultiplayerStore(selectMe)
  const dispatch = useMultiplayerStore((state) => state.dispatch)

  // Read, never written. The colour-blind setting is an accessibility choice a
  // player made once and must not have to make again because they opened a
  // different screen; multiplayer's promise is that it never *writes* the
  // single-player save, not that it ignores what the player has told the app.
  const colorBlind = useGameStore((state) => state.save.settings.colorBlind)

  const [leaving, setLeaving] = useState(false)

  const synced = isSyncedMode(settings)
  const spectating = me !== null && me.eliminatedAtLevel !== null
  const boardReady = game !== null && level !== null && !loadingLevel
  const interactive =
    boardReady && game.status === 'playing' && phase === 'playing' && !leaving && !spectating

  const cells = game?.cells ?? EMPTY_CELLS
  const onGesture = (gesture: BoardGesture) => {
    if (gesture.type === 'paint') {
      dispatch({ type: 'paint', indices: gesture.indices, mode: gesture.mode })
    } else dispatch({ type: gesture.type, index: gesture.index })
  }
  const gridRef = useBoardPointer({ size: game?.size ?? 1, enabled: interactive, cells, onGesture })
  const { cursor } = useBoardKeyboard({
    size: game?.size ?? 1,
    enabled: interactive,
    cells,
    onGesture,
  })

  // The win and fail sequences animate first and then settle, exactly as they
  // do in single-player. The claim has already gone to the server — the store
  // sends it the instant the board is decided, not when the animation ends — so
  // these timers cost the player nothing.
  useEffect(() => {
    if (!game) return undefined
    if (game.status === 'winning') {
      const timer = window.setTimeout(() => dispatch({ type: 'settle' }), 1200)
      return () => clearTimeout(timer)
    }
    if (game.status === 'failing') {
      const timer = window.setTimeout(() => dispatch({ type: 'settle' }), 700)
      return () => clearTimeout(timer)
    }
    return undefined
  }, [game, dispatch])

  if (phase === 'countdown') {
    return <GetReady mode={settings.mode} levelCount={levelCount} players={players.length} />
  }

  const levelOrdinal = (synced ? roomLevelIndex : myLevelIndex) + 1
  const headline =
    levelCount > 0 ? `Level ${Math.max(1, levelOrdinal)} of ${levelCount}` : 'Warming up'

  const header = (
    <header className="flex items-center justify-between gap-2">
      <BackButton label="Leave the match" onClick={() => setLeaving(true)} />
      <div className="min-w-0 text-center">
        <div className="text-[12px] font-extrabold uppercase tracking-wide text-[var(--mdk-ink-faint)]">
          {MODE_LABEL[settings.mode]}
        </div>
        <div className="truncate text-[17px] font-black leading-tight text-[var(--mdk-ink)]">
          {headline}
        </div>
      </div>
      <Pill label="Match clock" className="h-12 flex-none px-3.5">
        {synced ? (
          <CountdownClock
            deadlineAt={levelDeadlineAt}
            offsetMs={serverOffsetMs}
            className="text-[19px] font-black text-[var(--mdk-ink)]"
          />
        ) : (
          <ElapsedClock
            since={
              matchStartsAt === null ? levelStartedAt : toLocalTime(matchStartsAt, serverOffsetMs)
            }
            className="text-[19px] font-black text-[var(--mdk-ink)]"
          />
        )}
      </Pill>
    </header>
  )

  const leaveOverlay = leaving ? (
    <Overlay label="Leave the match" onScrimClick={() => setLeaving(false)}>
      <div className="mb-1 text-[26px] font-black text-[var(--mdk-ink)]">Leave the match?</div>
      <div className="mb-[18px] text-sm font-bold text-[var(--mdk-ink-muted)]">
        You forfeit the level you are on, and the rest of the match plays out without you.
      </div>
      <PrimaryButton onClick={() => setLeaving(false)}>Keep playing</PrimaryButton>
      <div className="mt-2">
        <DangerButton onClick={onLeave}>Leave</DangerButton>
      </div>
    </Overlay>
  ) : null

  if (spectating) {
    return (
      <section className="flex flex-col gap-3" style={{ animation: 'mdkFade .25s' }}>
        {header}
        <Spectating eliminatedAtLevel={me?.eliminatedAtLevel ?? null} />
        {leaveOverlay}
      </section>
    )
  }

  return (
    <section className="flex flex-col gap-3" style={{ animation: 'mdkFade .25s' }}>
      {header}

      <ProgressRace />

      <LivesPill
        lives={game?.lives ?? MULTIPLAYER_LIVES}
        maxLives={game?.maxLives ?? MULTIPLAYER_LIVES}
        failing={game?.status === 'failing'}
      />

      {levelError !== null ? (
        <BoardNotice
          title="That puzzle would not build"
          body={`${levelError} The next level will start on time.`}
        />
      ) : !boardReady ? (
        <BoardLoader />
      ) : (
        <Board
          size={game.size}
          regions={game.regions}
          cells={game.cells}
          lastCat={game.lastCat}
          lastWrong={game.lastWrong}
          hintCells={game.hintCells}
          cursor={cursor}
          colorBlind={colorBlind}
          celebrating={game.status === 'winning' || game.status === 'win'}
          dimmed={game.status === 'failing' || game.status === 'fail'}
          gridRef={gridRef}
        />
      )}

      {accepted !== null ? <SolvedPanel elapsedMs={accepted.elapsedMs} synced={synced} /> : null}

      {game?.status === 'fail' ? <OutOfFishOverlay /> : null}
      {leaveOverlay}
    </section>
  )
}

/**
 * The three-two-one before the first board.
 *
 * It has its own component because it has its own ticking clock, and a clock
 * that re-rendered the match screen ten times a second would re-render the
 * board with it. It is also the only moment in the match with nothing else to
 * look at, so it gets the whole screen.
 */
function GetReady({
  mode,
  levelCount,
  players,
}: {
  mode: GameMode
  levelCount: number
  players: number
}) {
  const matchStartsAt = useMultiplayerStore((state) => state.matchStartsAt)
  const serverOffsetMs = useMultiplayerStore((state) => state.serverOffsetMs)
  const preferences = useMultiplayerStore((state) => state.preferences)
  const seconds = useSecondsUntil(matchStartsAt, serverOffsetMs)

  // One beat per second, and the starting gun on zero. Both borrow cues the
  // player already knows: the tick of a mark, and the rise of a cat landing.
  // An effect event, so that a preference changing mid-countdown cannot make
  // a beat play twice — only the second it belongs to fires it.
  const beat = useEffectEvent((at: number) => {
    playRaceCue(at <= 0 ? 'start' : 'countdownBeat', preferences)
  })

  useEffect(() => {
    if (matchStartsAt === null) return
    beat(seconds)
  }, [seconds, matchStartsAt])

  return (
    <section
      className="flex flex-1 flex-col items-center justify-center gap-3 text-center"
      style={{ animation: 'mdkFade .25s' }}
    >
      <CatFace
        expression="wink"
        className="h-20 w-20"
        style={{ animation: 'mdkBounce .7s ease infinite' }}
      />
      <div className="text-[13px] font-extrabold uppercase tracking-wide text-[var(--mdk-ink-faint)]">
        {MODE_LABEL[mode]} · {players} cats · {levelCount} levels
      </div>
      <div
        key={seconds}
        className="text-[84px] font-black leading-none text-[var(--mdk-ink)]"
        style={{ animation: 'mdkPop .3s ease-out' }}
        aria-live="assertive"
      >
        {seconds > 0 ? seconds : 'Go!'}
      </div>
      <div className="text-base font-extrabold text-[var(--mdk-ink-muted)]">
        {seconds > 0 ? 'Paws ready…' : 'First board coming up'}
      </div>
    </section>
  )
}

/**
 * What a knocked-out player watches.
 *
 * Being out is not a reason to be shown nothing. Without a board there is room
 * for the whole field labelled by name, which is a better view of the match
 * than anyone still playing has — and in knockout, where what is left is a
 * head-to-head between the last two, it is the view worth having.
 */
function Spectating({ eliminatedAtLevel }: { eliminatedAtLevel: number | null }) {
  const remaining = useMultiplayerStore(
    (state) => state.players.filter((player) => player.eliminatedAtLevel === null).length,
  )
  return (
    <div className="flex flex-col gap-4">
      <div
        className="rounded-[var(--mdk-radius-card)] bg-[var(--mdk-card)] px-4 py-3.5 text-center"
        style={{ boxShadow: 'var(--mdk-shadow-card)' }}
      >
        <div className="text-[20px] font-black text-[var(--mdk-ink)]">You are out</div>
        <div className="mt-0.5 text-[13px] font-bold text-[var(--mdk-ink-muted)]">
          {eliminatedAtLevel === null
            ? 'Watching the rest of the match.'
            : `Knocked out on level ${eliminatedAtLevel}. ${remaining} still in it.`}
        </div>
      </div>
      <div
        className="rounded-[var(--mdk-radius-card)] bg-[var(--mdk-card)] px-3 py-3.5"
        style={{ boxShadow: 'var(--mdk-shadow-card)' }}
      >
        <ProgressRace variant="full" />
      </div>
    </div>
  )
}

/**
 * What a solved board says while the rest of the room finishes.
 *
 * In steady and knockout this is the whole of the waiting experience and it has
 * to be honest about it: here is your time, here is who you are waiting for,
 * and here is how far along each of them is — live, not a spinner.
 *
 * The full labelled standings appear only here, and that is deliberate. Below
 * the board there is around 300 px of empty screen on the smallest phone the
 * game targets (measured, not assumed), and while a player is solving it should
 * stay empty: eight names in thumb reach are a distraction from the board and
 * nothing a solving player can read anyway. The moment they finish, the same
 * space becomes the most interesting thing on screen. In blaze there is no wait
 * at all, so the panel is a single line as the next board arrives.
 */
function SolvedPanel({ elapsedMs, synced }: { elapsedMs: number; synced: boolean }) {
  const players = useMultiplayerStore((state) => state.players)
  const schedule = useMultiplayerStore((state) => state.schedule)
  const levelIndex = useMultiplayerStore((state) => state.levelIndex)
  const playerId = useMultiplayerStore((state) => state.playerId)
  // A solved board holds exactly `size` cats, so anyone below that is still
  // working. It is an inference rather than a fact the server publishes, but it
  // is the same inference the bars above are already drawn from. This client is
  // excluded outright: it is reading this panel because it has finished, and
  // the room's picture of its progress may be a round trip behind that.
  const size = schedule?.[levelIndex]?.size ?? 0
  const stillSolving = players.filter(
    (player) =>
      player.id !== playerId &&
      player.eliminatedAtLevel === null &&
      player.levelIndex === levelIndex &&
      (size === 0 || player.progress < size),
  ).length

  return (
    <div
      className="flex min-h-0 flex-col gap-2 rounded-[var(--mdk-radius-card)] bg-[var(--mdk-card)] px-3 py-2.5"
      style={{ boxShadow: 'var(--mdk-shadow-card)', animation: 'mdkRise .3s' }}
      aria-live="polite"
    >
      <div className="flex items-center gap-2">
        <CatPip className="h-6 w-6 flex-none" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-[15px] font-black text-[var(--mdk-ink)]">
            Solved in {formatDuration(elapsedMs, true)}
          </span>
          <span className="text-[12px] font-bold text-[var(--mdk-ink-muted)]">
            {!synced
              ? 'Next board coming up'
              : stillSolving === 0
                ? 'Waiting for the level to close'
                : `Still solving: ${stillSolving}`}
          </span>
        </span>
      </div>
      {synced ? (
        // Capped in pixels rather than left to the flex box. This panel hangs
        // below a board whose height is fixed by the viewport's width, so the
        // space under it is known and finite; a list that could grow past it
        // would push the board itself off the screen, which is the one thing a
        // match screen must never do.
        <div className="min-h-0 overflow-y-auto pb-1" style={{ maxHeight: 200 }}>
          <ProgressRace variant="full" />
        </div>
      ) : null}
    </div>
  )
}

/**
 * Losing every fish in a race.
 *
 * Not an ending, and deliberately not the single-player fail overlay, which
 * offers a retry and a way out of the level. Here the level is not yours to
 * leave: the board resets, you keep racing, and the time you spent is the
 * price. One button, no choice to agonise over — the clock is running.
 *
 * The reset is written straight into the multiplayer store rather than sent
 * through an action, because the store has no restart of its own and the board
 * it holds is entirely local: nothing about a rebuilt board needs the server's
 * permission. The room's picture of this player's progress catches up with the
 * first cat they place afterwards.
 */
function OutOfFishOverlay() {
  const level = useMultiplayerStore((state) => state.level)
  const autoX = useMultiplayerStore((state) => state.preferences.autoX)

  const restart = () => {
    if (level === null) return
    useMultiplayerStore.setState({
      game: createGame(level, { lives: MULTIPLAYER_LIVES, reveals: 0, hints: 0, autoX }),
    })
  }

  return (
    <Overlay label="Out of fish">
      <span
        className="inline-block"
        style={{ filter: 'grayscale(1)', opacity: 0.5, animation: 'mdkWobble .6s' }}
      >
        <Fish className="h-[42px] w-16" />
      </span>
      <div className="mb-0.5 mt-1.5 text-[26px] font-black text-[var(--mdk-ink)]">Out of fish</div>
      <div className="mb-[18px] text-sm font-bold text-[var(--mdk-ink-muted)]">
        The board resets and you stay in the race. The seconds are the only thing you lose.
      </div>
      <PrimaryButton onClick={restart}>Back in</PrimaryButton>
    </Overlay>
  )
}

/** The five fish, in the same pill single-player draws its three in. */
function LivesPill({
  lives,
  maxLives,
  failing,
}: {
  lives: number
  maxLives: number
  failing: boolean
}) {
  return (
    <div className="flex justify-center">
      <Pill label={`${lives} of ${maxLives} fish left`} className="gap-1.5 px-4 py-[6px]">
        {Array.from({ length: maxLives }, (_, index) => (
          <span
            key={index}
            className="inline-flex transition-[opacity,filter] duration-[400ms]"
            style={{
              opacity: index < lives ? 1 : 0.32,
              filter: index < lives ? 'none' : 'grayscale(1)',
              animation: failing ? 'mdkWobble .5s ease' : 'none',
            }}
          >
            <Fish className="h-[15px] w-[23px]" />
          </span>
        ))}
      </Pill>
    </div>
  )
}

/**
 * The board's own slot while a level is being generated.
 *
 * Square, because the board is, and a placeholder of the wrong height would
 * move everything under it the instant the puzzle arrived. It fades in after a
 * beat so the common case — a level already generated during the interlude —
 * never flashes a spinner. The delay is CSS, so it costs no timer.
 */
function BoardSlot({ children, role }: { children: React.ReactNode; role: 'status' | 'alert' }) {
  return (
    <div
      className="flex aspect-square flex-col items-center justify-center gap-3 rounded-[var(--mdk-radius-card)] bg-[var(--mdk-card)] px-5 text-center"
      role={role}
      style={{
        boxShadow: 'var(--mdk-shadow-card)',
        opacity: 0,
        animation: 'mdkFade .2s ease 150ms forwards',
      }}
    >
      {children}
    </div>
  )
}

function BoardLoader() {
  return (
    <BoardSlot role="status">
      <CatFace className="h-[60px] w-[60px]" />
      <div className="text-sm font-extrabold text-[var(--mdk-ink-muted)]">building the board…</div>
    </BoardSlot>
  )
}

/** Anything that went wrong with this client's board, said plainly. */
function BoardNotice({ title, body }: { title: string; body: string }) {
  return (
    <BoardSlot role="alert">
      <div className="text-base font-black text-[var(--mdk-ink)]">{title}</div>
      <div className="text-sm font-bold text-[var(--mdk-ink-muted)]">{body}</div>
    </BoardSlot>
  )
}
