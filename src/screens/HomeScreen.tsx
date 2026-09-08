import { useNavigate } from '@tanstack/react-router'
import { useGameStore } from '../store/useGameStore'
import { CatLogo } from '../ui/icons'
import { PrimaryButton } from '../ui/chrome'
import { InstallCard } from '../pwa/InstallCard'

/**
 * One screen, three buttons, no daily-reward popup. That restraint is the whole
 * point of this clone, so nothing else belongs here.
 */
export function HomeScreen() {
  const navigate = useNavigate()
  const save = useGameStore((state) => state.save)
  const resuming = save.inProgress !== null && save.inProgress.levelNumber === save.currentLevel

  return (
    <section className="flex flex-1 flex-col items-center justify-center gap-2.5" style={{ animation: 'mdkFade .25s' }}>
      <CatLogo className="h-32 w-32" style={{ filter: 'var(--mdk-shadow-logo)' }} />
      <h1 className="mt-1.5 text-[44px] font-black tracking-[-1px] text-[var(--mdk-ink)]">Meowdoku</h1>
      <div className="mb-2 text-base font-bold text-[var(--mdk-ink-muted)]">A cosy logic puzzle</div>

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
          onClick={() => navigate({ to: '/play/$levelNumber', params: { levelNumber: save.currentLevel } })}
        >
          {resuming ? 'Continue' : 'Play'} — Level {save.currentLevel}
        </PrimaryButton>
      </div>
      <HomeButton onClick={() => navigate({ to: '/levels' })}>Level select</HomeButton>
      <HomeButton onClick={() => navigate({ to: '/settings' })}>Settings</HomeButton>

      <InstallCard />
    </section>
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
