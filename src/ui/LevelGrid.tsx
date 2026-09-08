import { useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { TIERS, tierFor } from '../board/generator/tiers'
import type { CompletedLevel } from '../store/save'

/**
 * The level list.
 *
 * Levels are unbounded, so this is a windowed list of rows rather than a fixed
 * grid of tiles: nothing anywhere counts levels, and scrolling far enough
 * simply keeps generating rows. Tier headers are woven in at the boundaries so
 * the difficulty steps are visible while browsing, not only on the win screen.
 */

const COLUMNS = 5
/** How far past the furthest unlocked level the list lets you scroll. */
const LOOKAHEAD_ROWS = 12

type Row =
  | { kind: 'header'; tierIndex: number; title: string; subtitle: string }
  | { kind: 'levels'; from: number }

const buildRows = (currentLevel: number): Row[] => {
  const lastLevel = currentLevel + LOOKAHEAD_ROWS * COLUMNS
  const rows: Row[] = []
  let level = 1
  let emittedTier = 0
  while (level <= lastLevel) {
    const tier = tierFor(level)
    if (tier.index !== emittedTier) {
      emittedTier = tier.index
      const next = TIERS[tier.index]
      rows.push({
        kind: 'header',
        tierIndex: tier.index,
        title: `Tier ${tier.index} · ${tier.name}`,
        subtitle: next
          ? `Levels ${tier.from}–${next.from - 1} · ${sizeLabel(tier.sizes)}`
          : `Level ${tier.from} and beyond · ${sizeLabel(tier.sizes)}`,
      })
    }
    rows.push({ kind: 'levels', from: level })
    // A row never straddles a tier boundary, so a header always sits directly
    // above the first level it describes.
    const next = TIERS[tier.index]
    const rowEnd = level + COLUMNS - 1
    level = next && rowEnd >= next.from ? next.from : level + COLUMNS
  }
  return rows
}

const sizeLabel = (sizes: readonly number[]): string =>
  sizes.length === 1 ? `${sizes[0]}×${sizes[0]}` : sizes.map((s) => `${s}×${s}`).join(' or ')

const HEADER_HEIGHT = 54
const ROW_HEIGHT = 84

export type LevelGridProps = {
  currentLevel: number
  completed: Record<string, CompletedLevel>
  onSelect: (levelNumber: number) => void
}

export function LevelGrid({ currentLevel, completed, onSelect }: LevelGridProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const rows = buildRows(currentLevel)

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (rows[index]?.kind === 'header' ? HEADER_HEIGHT : ROW_HEIGHT),
    overscan: 6,
    // Open on the level the player is actually up to, not at level 1.
    initialOffset: () => {
      const target = rows.findIndex(
        (row) => row.kind === 'levels' && row.from + COLUMNS > currentLevel,
      )
      if (target < 0) return 0
      return rows
        .slice(0, target)
        .reduce((sum, row) => sum + (row.kind === 'header' ? HEADER_HEIGHT : ROW_HEIGHT), 0)
    },
  })

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto" style={{ contain: 'strict' }}>
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index]
          if (!row) return null
          return (
            <div
              key={item.key}
              ref={virtualizer.measureElement}
              data-index={item.index}
              className="absolute left-0 top-0 w-full"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              {row.kind === 'header' ? (
                <div className="px-1 pb-1.5 pt-3">
                  <div className="text-[15px] font-black text-[var(--mdk-ink)]">{row.title}</div>
                  <div className="text-[12px] font-bold text-[var(--mdk-ink-muted)]">
                    {row.subtitle}
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-5 gap-2.5 pb-2.5">
                  {Array.from({ length: COLUMNS }, (_, offset) => {
                    const levelNumber = row.from + offset
                    const nextTier = TIERS[tierFor(row.from).index]
                    // Stop a row short at a tier boundary rather than mixing tiers.
                    if (nextTier && levelNumber >= nextTier.from) return <div key={offset} />
                    return (
                      <LevelTile
                        key={offset}
                        levelNumber={levelNumber}
                        completed={completed[String(levelNumber)]}
                        unlocked={levelNumber <= currentLevel}
                        current={levelNumber === currentLevel}
                        onSelect={onSelect}
                      />
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function LevelTile({
  levelNumber,
  completed,
  unlocked,
  current,
  onSelect,
}: {
  levelNumber: number
  completed: CompletedLevel | undefined
  unlocked: boolean
  current: boolean
  onSelect: (levelNumber: number) => void
}) {
  const stars = completed ? '★'.repeat(completed.stars) : ''
  return (
    <button
      type="button"
      disabled={!unlocked}
      aria-label={
        unlocked
          ? `Level ${levelNumber}${completed ? `, ${completed.stars} of 3 stars` : ''}`
          : `Level ${levelNumber}, locked`
      }
      onClick={() => unlocked && onSelect(levelNumber)}
      className="flex aspect-square flex-col items-center justify-center gap-0.5 rounded-[var(--mdk-radius-tile)] border-none p-0"
      style={{
        background: unlocked ? 'var(--mdk-card)' : 'var(--mdk-card-locked)',
        color: unlocked ? 'var(--mdk-ink)' : 'var(--mdk-ink-locked)',
        boxShadow: unlocked ? 'var(--mdk-shadow-card)' : 'none',
        outline: current ? '3px solid var(--mdk-ink)' : 'none',
        outlineOffset: -3,
        cursor: unlocked ? 'pointer' : 'default',
      }}
    >
      <span className="text-[18px] font-black leading-none">{levelNumber}</span>
      <span
        className="text-[10px] leading-[12px] text-[var(--mdk-gold)]"
        style={{ letterSpacing: 1, height: 12 }}
      >
        {stars}
      </span>
    </button>
  )
}
