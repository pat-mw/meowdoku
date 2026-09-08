import { useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { CellState } from '../board/types'
import { liveScore, scoreBreakdown } from '../board/score'
import { tierFor } from '../board/generator/tiers'
import { useGameStore } from '../store/useGameStore'
import { useBoardPointer, type BoardGesture } from '../input/useBoardPointer'
import { useBoardKeyboard } from '../input/useBoardKeyboard'
import { Board } from '../ui/Board'
import { RulesStrip } from '../ui/RulesPictogram'
import { LARGE_BOARD_SIZE, ZoomPan } from '../ui/ZoomPan'
import { BackButton, Pill, SettingsButton } from '../ui/chrome'
import { Bulb, CatFace, CatPip, Fish } from '../ui/icons'
import { Confetti } from '../ui/Confetti'
import { HintToast } from '../ui/HintToast'
import { FailOverlay, WinOverlay } from '../ui/overlays'
import { SettingsPanel } from './SettingsPanel'

/** A stable empty board, so the input hooks never see a fresh array identity. */
const EMPTY_CELLS: readonly CellState[] = []

/**
 * The game screen: ninety percent of the product.
 *
 * Everything the player touches flows through one pointer listener on the board
 * and one keyboard listener on the window; both produce the same gesture
 * vocabulary, which the store hands straight to the pure reducer.
 */
export function GameScreen({ levelNumber }: { levelNumber: number }) {
  const navigate = useNavigate()
  // Selectors return a single stable value each: Zustand 5 compares with Object.is,
  // so a selector that builds an object would re-render on every store write.
  const game = useGameStore((state) => state.game)
  const level = useGameStore((state) => state.level)
  const loadingLevel = useGameStore((state) => state.loadingLevel)
  const loadError = useGameStore((state) => state.loadError)
  const colorBlind = useGameStore((state) => state.save.settings.colorBlind)
  const openLevel = useGameStore((state) => state.openLevel)
  const dispatch = useGameStore((state) => state.dispatch)
  const requestHint = useGameStore((state) => state.requestHint)
  const requestReveal = useGameStore((state) => state.requestReveal)

  const [showSettings, setShowSettings] = useState(false)

  useEffect(() => {
    void openLevel(levelNumber, { resume: true })
  }, [levelNumber, openLevel])

  const onGesture = (gesture: BoardGesture) => {
    if (gesture.type === 'paint') dispatch({ type: 'paint', indices: gesture.indices })
    else dispatch({ type: gesture.type, index: gesture.index })
  }

  const interactive = game !== null && game.status === 'playing' && !showSettings
  const cells = game?.cells ?? EMPTY_CELLS
  const gridRef = useBoardPointer({ size: game?.size ?? 1, enabled: interactive, cells, onGesture })
  const { cursor } = useBoardKeyboard({
    size: game?.size ?? 1,
    enabled: interactive,
    cells,
    onGesture,
  })

  // The win and fail sequences animate first, then settle into their overlay.
  useEffect(() => {
    if (!game) return
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

  useEffect(() => {
    if (!game?.hintMessage) return
    const timer = window.setTimeout(() => dispatch({ type: 'dismissHint' }), 3500)
    return () => clearTimeout(timer)
  }, [game?.hintMessage, game?.hintCell, dispatch])

  if (loadError) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <div className="text-base font-extrabold text-[var(--mdk-ink)]">{loadError}</div>
        <button
          type="button"
          onClick={() => void openLevel(levelNumber)}
          className="rounded-full border-none bg-[var(--mdk-ink)] px-5 py-2.5 text-sm font-extrabold text-[#FFF7F0]"
        >
          Try again
        </button>
      </div>
    )
  }

  // While a different level is being generated the previous board must not stay
  // on screen: it would look interactive and accept taps meant for the new one.
  if (loadingLevel || !game || !level || game.levelNumber !== levelNumber) return <LevelLoader />

  const catsPlaced = game.cells.reduce<number>(
    (total, cell) => total + (cell === CellState.Cat ? 1 : 0),
    0,
  )
  const displayScore =
    game.status === 'win' || game.status === 'winning'
      ? game.score
      : liveScore({
          size: game.size,
          livesLost: game.livesLost,
          powerUsed: game.powerUsed,
          catsPlaced,
        })
  const tier = tierFor(game.levelNumber)
  const failing = game.status === 'failing' || game.status === 'fail'
  const large = game.size >= LARGE_BOARD_SIZE

  return (
    <section className="flex flex-col gap-[13px]" style={{ animation: 'mdkFade .25s' }}>
      <header className="flex items-center justify-between">
        <BackButton label="Back to home" onClick={() => navigate({ to: '/' })} />
        <div className="flex gap-[38px]">
          <Counter label="Level" value={game.levelNumber} />
          <Counter label="Score" value={displayScore} />
        </div>
        <SettingsButton onClick={() => setShowSettings(true)} />
      </header>

      <div className="flex justify-center gap-3">
        <Pill label="Cats placed" className="gap-2 px-[18px] py-[7px]">
          <CatPip className="h-[22px] w-[22px]" />
          <span className="text-lg font-black">
            <span className="text-[var(--mdk-green)]">{catsPlaced}</span>
            <span className="text-[var(--mdk-ink)]">/{game.size}</span>
          </span>
        </Pill>
        <Pill
          label={`${game.lives} of ${game.maxLives} fish left`}
          className="gap-[5px] px-4 py-[7px]"
        >
          {Array.from({ length: game.maxLives }, (_, index) => (
            <span
              key={index}
              className="inline-flex transition-[opacity,filter] duration-[400ms]"
              style={{
                opacity: index < game.lives ? 1 : 0.32,
                filter: index < game.lives ? 'none' : 'grayscale(1)',
                animation: game.status === 'failing' ? 'mdkWobble .5s ease' : 'none',
              }}
            >
              <Fish className="h-[17px] w-[26px]" />
            </span>
          ))}
        </Pill>
      </div>

      {/* A 15x15 board needs every pixel of height it can get, so on large
          boards the rules collapse behind a summary the player can reopen. */}
      {large ? <CollapsedRules /> : <RulesStrip />}

      {/* Keyed by size so a level of a different size gets a fresh transform
          rather than inheriting the last board's pan and zoom. */}
      <ZoomPan key={game.size} enabled={large}>
        <Board
          size={game.size}
          regions={game.regions}
          cells={game.cells}
          lastCat={game.lastCat}
          lastWrong={game.lastWrong}
          hintCell={game.hintCell}
          cursor={cursor}
          colorBlind={colorBlind}
          celebrating={game.status === 'winning' || game.status === 'win'}
          dimmed={failing}
          gridRef={gridRef}
        />
      </ZoomPan>

      <div className="flex justify-center gap-[46px] py-1">
        <PowerButton
          label="Reveal a cat"
          badge={game.revealsLeft}
          enabled={game.revealsLeft > 0 && game.status === 'playing'}
          onClick={requestReveal}
        >
          <CatFace expression="wink" className="h-10 w-10" />
        </PowerButton>
        <PowerButton
          label="Hint"
          badge={game.hintsLeft}
          enabled={game.hintsLeft > 0 && game.status === 'playing'}
          onClick={requestHint}
        >
          <Bulb className="h-[37px] w-[30px]" />
        </PowerButton>
      </div>

      {game.hintMessage ? <HintToast message={game.hintMessage} /> : null}

      {game.status === 'winning' || game.status === 'win' ? (
        <Confetti seed={game.levelNumber} />
      ) : null}

      {game.status === 'win' ? (
        <WinOverlay
          tierName={`${tier.index} · ${tier.name}`}
          levelNumber={game.levelNumber}
          stars={game.stars}
          lines={scoreBreakdown(game.size, game.livesLost, game.powerUsed)}
          onNext={() =>
            navigate({ to: '/play/$levelNumber', params: { levelNumber: game.levelNumber + 1 } })
          }
          onLevels={() => navigate({ to: '/levels' })}
        />
      ) : null}

      {game.status === 'fail' ? (
        <FailOverlay
          onRetry={() => useGameStore.getState().restartLevel()}
          onLevels={() => navigate({ to: '/levels' })}
        />
      ) : null}

      {showSettings ? (
        <SettingsPanel
          onClose={() => setShowSettings(false)}
          danger={{
            label: 'Restart level',
            onClick: () => {
              setShowSettings(false)
              useGameStore.getState().restartLevel()
            },
          }}
        />
      ) : null}
    </section>
  )
}

/** The rules, folded away on boards where vertical space is scarce. */
function CollapsedRules() {
  return (
    <details
      className="rounded-[var(--mdk-radius-panel)] bg-[var(--mdk-card)] px-3 py-2"
      style={{ boxShadow: 'var(--mdk-shadow-card)' }}
    >
      <summary className="cursor-pointer list-none text-[12px] font-extrabold text-[var(--mdk-ink)]">
        One cat per colour, row and column · cats cannot touch
      </summary>
      <div className="pt-2.5">
        <RulesStrip />
      </div>
    </details>
  )
}

function Counter({ label, value }: { label: string; value: number }) {
  return (
    <div className="text-center">
      <div className="text-[15px] font-extrabold text-[var(--mdk-ink-muted)]">{label}</div>
      <div className="text-[30px] font-black leading-[1.05] text-[var(--mdk-ink)]">{value}</div>
    </div>
  )
}

function PowerButton({
  label,
  badge,
  enabled,
  onClick,
  children,
}: {
  label: string
  badge: number
  enabled: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={`${label}, ${badge} left`}
      disabled={!enabled}
      onClick={onClick}
      className="relative flex h-16 w-16 items-center justify-center rounded-full border-none bg-[var(--mdk-card)]"
      style={{
        boxShadow: 'var(--mdk-shadow-button)',
        opacity: enabled ? 1 : 0.45,
        cursor: enabled ? 'pointer' : 'default',
      }}
    >
      {children}
      <span
        aria-hidden="true"
        className="absolute flex items-center justify-center rounded-[11px] bg-[var(--mdk-coral)] px-1 text-[13px] font-black text-white"
        style={{ top: -4, right: -4, minWidth: 22, height: 22 }}
      >
        {badge}
      </span>
    </button>
  )
}

/**
 * The loader the design calls for. It fades in only after a short delay, so a
 * level that comes back from the cache — which is the common case, because the
 * next level is prefetched — never flashes a spinner. The delay is CSS rather
 * than a timer so it costs no render.
 */
function LevelLoader() {
  return (
    <div
      className="flex flex-1 flex-col items-center justify-center gap-3.5"
      role="status"
      style={{ opacity: 0, animation: 'mdkFade .2s ease 150ms forwards' }}
    >
      <CatFace className="h-[72px] w-[72px]" />
      <div className="text-base font-extrabold text-[var(--mdk-ink-muted)]">mew…</div>
    </div>
  )
}
