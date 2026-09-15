/**
 * A finished level or a finished match, as a table.
 *
 * Deliberately dumb: the screens work out what a row means, this decides what a
 * row looks like. That split is what lets the interlude ("who won this level")
 * and the podium ("who won the match") share one visual language without either
 * of them having to know about the other's rules.
 */

import type { ReactNode } from 'react'
import { ordinal } from './format'
import { Collar, Crown, OutMark } from './icons'

export type ResultTone = 'normal' | 'winner' | 'out'

export type ResultRow = {
  key: string
  /** 1-based standing, or null for a row that is not ranked. */
  place: number | null
  name: string
  color: string
  /** The right-hand figure: a time, a score, a reason. */
  value: string
  /** A second line under the name, for anything the value cannot carry. */
  note?: string | undefined
  tone?: ResultTone | undefined
  /** Draws the row as belonging to this client. */
  isMe?: boolean | undefined
}

export function ResultTable({
  rows,
  caption,
}: {
  rows: readonly ResultRow[]
  caption?: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {caption === undefined ? null : (
        <div className="text-[12px] font-extrabold uppercase tracking-wide text-[var(--mdk-ink-faint)]">
          {caption}
        </div>
      )}
      <ol className="flex flex-col gap-1">
        {rows.map((row) => (
          <ResultRowView key={row.key} row={row} />
        ))}
      </ol>
    </div>
  )
}

function ResultRowView({ row }: { row: ResultRow }) {
  const tone = row.tone ?? 'normal'
  return (
    <li
      className="flex items-center gap-2 rounded-[14px] px-2.5 py-1.5"
      style={{
        // Your own row is the one a player looks for first, so it is the only
        // one with a surface of its own; the winner is marked by a crown rather
        // than by a second highlight, so the two never compete.
        background: row.isMe === true ? 'var(--mdk-surface-sunken)' : 'transparent',
        opacity: tone === 'out' ? 0.6 : 1,
      }}
    >
      <span className="w-5 flex-none text-right text-[13px] font-black text-[var(--mdk-ink-faint)]">
        {row.place === null ? '·' : row.place}
      </span>
      {tone === 'out' ? (
        <OutMark className="h-4 w-4 flex-none" />
      ) : (
        <Collar className="h-4 w-4 flex-none" color={row.color} />
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[15px] font-extrabold text-[var(--mdk-ink-strong)]">
            {row.name}
          </span>
          {tone === 'winner' ? <Crown className="h-3.5 w-[17px] flex-none" /> : null}
        </span>
        {row.note === undefined ? null : (
          <span className="truncate text-[12px] font-bold text-[var(--mdk-ink-muted)]">
            {row.note}
          </span>
        )}
      </span>
      <span className="flex-none tabular-nums text-[15px] font-black text-[var(--mdk-ink)]">
        {row.value}
      </span>
      <span className="sr-only">{row.place === null ? 'unplaced' : ordinal(row.place)}</span>
    </li>
  )
}
