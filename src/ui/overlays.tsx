import type { ScoreLine, Stars } from '../board/score'
import { CatFace, Fish } from './icons'
import { DangerButton, Overlay, PrimaryButton, QuietButton, Toggle } from './chrome'

/** Filled stars up to the count, hollow for the rest. */
const starRow = (stars: Stars): string => '★'.repeat(stars) + '☆'.repeat(3 - stars)

export function WinOverlay({
  tierName,
  levelNumber,
  stars,
  lines,
  onNext,
  onLevels,
}: {
  tierName: string
  levelNumber: number
  stars: Stars
  lines: readonly ScoreLine[]
  onNext: () => void
  onLevels: () => void
}) {
  return (
    <Overlay label="Level complete">
      <CatFace
        expression="happy"
        className="mx-auto h-[72px] w-[72px]"
        style={{ animation: 'mdkBounce .6s' }}
      />
      <div className="mt-1 text-[32px] font-black text-[var(--mdk-ink)]">Purrfect!</div>
      {/* Naming the tier alongside the level is what makes the difficulty step
          legible: the player sees they have crossed into a harder band. */}
      <div className="text-[13px] font-extrabold text-[var(--mdk-ink-muted)]">
        Tier {tierName} &middot; Level {levelNumber}
      </div>
      <div
        className="my-1 text-[28px] text-[var(--mdk-gold)]"
        style={{ letterSpacing: 5 }}
        aria-label={`${stars} of 3 stars`}
      >
        {starRow(stars)}
      </div>
      <div className="mb-4 flex flex-col gap-[5px]">
        {lines.map((line) => (
          <div
            key={line.label}
            className="flex justify-between text-sm font-extrabold text-[#8A6A5A]"
          >
            <span>{line.label}</span>
            <span>{line.value}</span>
          </div>
        ))}
      </div>
      <PrimaryButton onClick={onNext}>Next level</PrimaryButton>
      <QuietButton onClick={onLevels} className="mt-1">
        Level select
      </QuietButton>
    </Overlay>
  )
}

export function FailOverlay({ onRetry, onLevels }: { onRetry: () => void; onLevels: () => void }) {
  return (
    <Overlay label="Out of fish">
      <span
        className="inline-block"
        style={{ filter: 'grayscale(1)', opacity: 0.5, animation: 'mdkWobble .6s' }}
      >
        <Fish className="h-[42px] w-16" />
      </span>
      <div className="mb-0.5 mt-1.5 text-[28px] font-black text-[var(--mdk-ink)]">Out of fish</div>
      <div className="mb-[18px] text-sm font-bold text-[var(--mdk-ink-muted)]">
        Every cat deserves another try.
      </div>
      <PrimaryButton onClick={onRetry}>Retry</PrimaryButton>
      <QuietButton onClick={onLevels} className="mt-1">
        Level select
      </QuietButton>
    </Overlay>
  )
}

export type SettingsToggle = {
  key: string
  label: string
  checked: boolean
  onChange: () => void
}

export function SettingsOverlay({
  toggles,
  danger,
  storageLabel,
  hapticsLabel,
  version,
  onExport,
  onImport,
  onClose,
}: {
  toggles: readonly SettingsToggle[]
  danger: { label: string; onClick: () => void } | null
  storageLabel: string
  hapticsLabel: string
  version: string
  onExport: () => void
  onImport: () => void
  onClose: () => void
}) {
  return (
    <Overlay label="Settings" onScrimClick={onClose} zIndex={55}>
      <div className="mb-3.5 text-2xl font-black text-[var(--mdk-ink)]">Settings</div>
      <div className="mb-4 flex flex-col gap-3 text-left">
        {toggles.map((toggle) => (
          <Toggle
            key={toggle.key}
            label={toggle.label}
            checked={toggle.checked}
            onChange={toggle.onChange}
          />
        ))}
      </div>
      <div className="mb-3 flex gap-2">
        <button
          type="button"
          onClick={onExport}
          className="flex-1 rounded-[22px] border-none bg-[#F3EBE3] text-sm font-extrabold text-[var(--mdk-ink)]"
          style={{ height: 44 }}
        >
          Export progress
        </button>
        <button
          type="button"
          onClick={onImport}
          className="flex-1 rounded-[22px] border-none bg-[#F3EBE3] text-sm font-extrabold text-[var(--mdk-ink)]"
          style={{ height: 44 }}
        >
          Import
        </button>
      </div>
      {danger ? <DangerButton onClick={danger.onClick}>{danger.label}</DangerButton> : null}
      <PrimaryButton onClick={onClose} className="mt-2">
        Close
      </PrimaryButton>
      <div className="mt-3 text-[11px] font-bold leading-relaxed text-[var(--mdk-ink-faint)]">
        Meowdoku {version} &middot; Storage: {storageLabel}
        <br />
        Haptics: {hapticsLabel}
      </div>
    </Overlay>
  )
}
