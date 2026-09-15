import { PrimaryButton } from '../../ui/chrome'
import { CatFace } from '../../ui/icons'
import { ScreenHeader } from '../../ui/multiplayer/controls'

/**
 * The fork: host a room, or join one.
 *
 * Two choices and nothing else. By the time a player reaches this screen the
 * connectivity gate on the home screen has already said multiplayer is
 * reachable, so there is no status to report and no reason to explain the
 * network. What is worth saying is how a match differs from the level stream —
 * that these are separate puzzles, and that nothing here touches their
 * progress — because a player who is halfway through level 60 will otherwise
 * wonder what a race is going to cost them.
 */
export function LobbyScreen({
  onCreate,
  onJoin,
  onExit,
}: {
  onCreate: () => void
  onJoin: () => void
  /** Back out of multiplayer entirely. */
  onExit: () => void
}) {
  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4" style={{ animation: 'mdkFade .25s' }}>
      <ScreenHeader title="Play together" onBack={onExit} backLabel="Back to the menu" />

      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <CatFace className="h-24 w-24" expression="wink" />
        <h2 className="text-[22px] font-black text-[var(--mdk-ink)]">Race a friend</h2>
        <p className="mb-2 max-w-[300px] text-[15px] font-bold text-[var(--mdk-ink-muted)]">
          Up to eight players, the same puzzles at the same moment. Matches have their own levels —
          your single-player progress is untouched.
        </p>

        <div className="flex w-[260px] flex-col gap-1.5">
          <PrimaryButton onClick={onCreate}>Create a room</PrimaryButton>
          <button
            type="button"
            onClick={onJoin}
            className="w-full rounded-[26px] border-none bg-[var(--mdk-card)] text-[17px] font-extrabold text-[var(--mdk-ink)]"
            style={{ height: 52, boxShadow: 'var(--mdk-shadow-card)' }}
          >
            Join with a code
          </button>
        </div>
      </div>
    </section>
  )
}
