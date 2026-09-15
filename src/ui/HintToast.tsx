/**
 * The explanation a hint leaves behind.
 *
 * It sits above the toolbar rather than over the board, so the gold-outlined
 * cells it is talking about stay visible while the player reads it. The rule's
 * name leads, because that is the part worth learning and carrying to the next
 * puzzle; the reasoning follows underneath.
 */
export function HintToast({
  title,
  message,
  count,
}: {
  title: string
  message: string
  count: number
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed left-1/2 -translate-x-1/2 rounded-2xl bg-[var(--mdk-card)] px-4 py-3 text-left"
      style={{
        bottom: 'calc(112px + env(safe-area-inset-bottom))',
        width: 'min(88vw, 400px)',
        zIndex: 40,
        boxShadow: 'var(--mdk-shadow-toast)',
        animation: 'mdkRise .25s',
      }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[13px] font-black text-[var(--mdk-ink)]">{title}</span>
        <span className="flex-none text-[11px] font-extrabold text-[var(--mdk-ink-faint)]">
          {count === 1 ? '1 cell' : `${count} cells`} marked
        </span>
      </div>
      <p className="mt-1 text-[13px] font-bold leading-snug text-[var(--mdk-ink-strong)]">
        {message}
      </p>
    </div>
  )
}
