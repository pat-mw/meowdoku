import type { ReactNode } from 'react'
import { BackArrow, SettingsGlyph } from './icons'

/**
 * The shared furniture: round icon buttons, white pills, the two button weights
 * and the modal shell. Every screen is built from these, so a spacing or shadow
 * change lands everywhere at once.
 */

export function RoundIconButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="flex h-12 w-12 flex-none items-center justify-center rounded-full border-none bg-[var(--mdk-card)]"
      style={{ boxShadow: 'var(--mdk-shadow-card)' }}
    >
      {children}
    </button>
  )
}

export function BackButton({ label = 'Back', onClick }: { label?: string; onClick: () => void }) {
  return (
    <RoundIconButton label={label} onClick={onClick}>
      <BackArrow className="h-6 w-6" />
    </RoundIconButton>
  )
}

export function SettingsButton({ onClick }: { onClick: () => void }) {
  return (
    <RoundIconButton label="Settings" onClick={onClick}>
      <SettingsGlyph className="h-6 w-6" />
    </RoundIconButton>
  )
}

export function Pill({
  label,
  children,
  className = '',
}: {
  label?: string
  children: ReactNode
  className?: string
}) {
  return (
    <div
      aria-label={label}
      className={`flex items-center rounded-full bg-[var(--mdk-card)] ${className}`}
      style={{ boxShadow: 'var(--mdk-shadow-card)' }}
    >
      {children}
    </div>
  )
}

export function PrimaryButton({
  children,
  onClick,
  className = '',
}: {
  children: ReactNode
  onClick: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-13 w-full rounded-[26px] border-none bg-[var(--mdk-ink)] text-[17px] font-extrabold text-[#FFF7F0] ${className}`}
      style={{ height: 52, boxShadow: 'var(--mdk-shadow-primary)' }}
    >
      {children}
    </button>
  )
}

export function QuietButton({
  children,
  onClick,
  className = '',
}: {
  children: ReactNode
  onClick: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full rounded-[22px] border-none bg-transparent text-[15px] font-extrabold text-[var(--mdk-ink-muted)] ${className}`}
      style={{ height: 44 }}
    >
      {children}
    </button>
  )
}

export function DangerButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-[22px] border-none bg-[var(--mdk-danger-bg)] text-[15px] font-extrabold text-[var(--mdk-danger-ink)]"
      style={{ height: 44 }}
    >
      {children}
    </button>
  )
}

/**
 * The modal shell. `onScrimClick` is omitted for the win and fail overlays,
 * which have no dismiss action — the player must choose what happens next.
 */
export function Overlay({
  label,
  children,
  onScrimClick,
  zIndex = 50,
}: {
  label: string
  children: ReactNode
  onScrimClick?: () => void
  zIndex?: number
}) {
  return (
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{ background: 'var(--mdk-scrim)', zIndex, animation: 'mdkFade .25s' }}
      onClick={onScrimClick}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onClick={(event) => event.stopPropagation()}
        className="rounded-[var(--mdk-radius-overlay)] bg-[var(--mdk-card)] px-[26px] pb-5 pt-[26px] text-center"
        style={{
          width: 'min(84vw, 330px)',
          animation: 'mdkRise .3s',
          boxShadow: 'var(--mdk-shadow-overlay)',
        }}
      >
        {children}
      </div>
    </div>
  )
}

export function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: () => void
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-base font-extrabold">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={onChange}
        className="flex flex-none items-center rounded-full border-none p-[3px] transition-colors duration-200"
        style={{
          width: 52,
          height: 30,
          justifyContent: checked ? 'flex-end' : 'flex-start',
          background: checked ? 'var(--mdk-green)' : 'var(--mdk-toggle-off)',
        }}
      >
        <span
          className="block rounded-full bg-white"
          style={{ width: 24, height: 24, boxShadow: '0 1px 3px rgba(0,0,0,0.25)' }}
        />
      </button>
    </div>
  )
}
