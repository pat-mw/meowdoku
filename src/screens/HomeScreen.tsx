import { useNavigate } from '@tanstack/react-router'
import { useGameStore } from '../store/useGameStore'
import { CatLogo } from '../ui/icons'
import { PrimaryButton } from '../ui/chrome'
import { InstallCard } from '../pwa/InstallCard'
import { isMultiplayerConfigured, useConnectivity } from '../multiplayer/connection'

/**
 * One screen, four buttons, no daily-reward popup. That restraint is the whole
 * point of this clone, so nothing else belongs here.
 */
export function HomeScreen() {
  const navigate = useNavigate()
  const save = useGameStore((state) => state.save)
  const resuming = save.inProgress !== null && save.inProgress.levelNumber === save.currentLevel

  return (
    <section
      className="flex flex-1 flex-col items-center justify-center gap-2.5"
      style={{ animation: 'mdkFade .25s' }}
    >
      <CatLogo className="h-32 w-32" style={{ filter: 'var(--mdk-shadow-logo)' }} />
      <h1 className="mt-1.5 text-[44px] font-black tracking-[-1px] text-[var(--mdk-ink)]">
        Meowdoku
      </h1>
      <div className="mb-2 text-base font-bold text-[var(--mdk-ink-muted)]">
        A cosy logic puzzle
      </div>

      <div
        className="mb-3.5 flex items-center gap-1.5 rounded-full bg-[var(--mdk-card)] px-5 py-2 text-sm font-extrabold"
        style={{ boxShadow: 'var(--mdk-shadow-card)' }}
      >
        <span className="text-[var(--mdk-gold)]">★</span>
        <span>{save.lifetimeScore.toLocaleString('en-US')} points</span>
        <span className="text-[var(--mdk-ink-faint)]">·</span>
        <span>{Object.keys(save.completed).length} solved</span>
      </div>

      <div className="w-[260px]">
        <PrimaryButton
          onClick={() =>
            navigate({ to: '/play/$levelNumber', params: { levelNumber: save.currentLevel } })
          }
        >
          {resuming ? 'Continue' : 'Play'} — Level {save.currentLevel}
        </PrimaryButton>
      </div>
      {/* Rendered at all only in a build that has a party server, so a
          single-player build shows no door that leads nowhere. The condition is
          a build-time constant, which is what makes calling a hook inside the
          child safe. */}
      {isMultiplayerConfigured() ? <MultiplayerButton /> : null}
      <HomeButton onClick={() => navigate({ to: '/levels' })}>Level select</HomeButton>
      <HomeButton onClick={() => navigate({ to: '/settings' })}>Settings</HomeButton>

      <InstallCard />
    </section>
  )
}

/**
 * Multiplayer's door, and the connectivity gate drawn as a button.
 *
 * The probe runs on mount and nothing waits for it: the rest of the menu is
 * already interactive, Play is already the first thing under the thumb, and a
 * device with no network reaches this screen exactly as fast as one on fibre.
 * What the probe changes is only this button, and only after it has an answer.
 *
 * The unavailable states say which thing is wrong, because the two have
 * different answers — a player who is offline can do something about it, and a
 * player whose party server is down cannot. Neither offers a retry: the check
 * re-runs by itself when the network returns or the tab comes back to the
 * foreground, so a button would be asking the player to do what is already
 * happening.
 */
function MultiplayerButton() {
  const navigate = useNavigate()
  const { status } = useConnectivity()

  const reason =
    status === 'checking'
      ? 'Checking the connection…'
      : status === 'unavailable-offline'
        ? 'You are offline — single player still works'
        : status === 'unavailable-server-down'
          ? "Can't reach the party server right now"
          : null

  const available = status === 'available'

  return (
    <button
      type="button"
      onClick={() => navigate({ to: '/multiplayer' })}
      disabled={!available}
      aria-busy={status === 'checking'}
      className="flex w-[260px] flex-col items-center justify-center gap-0.5 rounded-[26px] border-none bg-[var(--mdk-card)] px-4"
      style={{
        minHeight: 52,
        paddingBlock: 8,
        boxShadow: available ? 'var(--mdk-shadow-card)' : 'none',
        cursor: available ? 'pointer' : 'default',
      }}
    >
      <span
        className="text-[17px] font-extrabold"
        style={{ color: available ? 'var(--mdk-ink)' : 'var(--mdk-ink-muted)' }}
      >
        Play with friends
      </span>
      {reason === null ? null : (
        <span className="text-[12px] font-bold text-[var(--mdk-ink-muted)]">{reason}</span>
      )}
    </button>
  )
}

function HomeButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-[260px] rounded-[26px] border-none bg-[var(--mdk-card)] text-[17px] font-extrabold text-[var(--mdk-ink)]"
      style={{ height: 52, boxShadow: 'var(--mdk-shadow-card)' }}
    >
      {children}
    </button>
  )
}
