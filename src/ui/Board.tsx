import { useEffect, useRef, useState } from 'react'
import { CellState, regionName } from '../board/types'
import { CatFace, CrossMark } from './icons'
import { regionColorVar } from './palette'

/**
 * The puzzle grid.
 *
 * Cells are plain divs on a CSS grid rather than SVG or canvas: they animate
 * with CSS, they carry their own accessible label, and a colour change is a
 * custom-property swap rather than a repaint. Pointer handling lives one layer
 * up and is installed on this container, not on each cell — at 15x15 that is
 * one listener set instead of 225.
 */

export type BoardCursor = { row: number; col: number } | null

export type BoardProps = {
  size: number
  regions: readonly string[]
  cells: readonly CellState[]
  /** Cell to pop, from the most recent correct placement. -1 for none. */
  lastCat: number
  /** Cell to shake, from the most recent wrong guess. -1 for none. */
  lastWrong: number
  /** Cell the last hint outlined in gold. -1 for none. */
  hintCell: number
  /** Keyboard focus cursor, or null when the player is using a pointer. */
  cursor: BoardCursor
  /** Renders the region letter in each cell for players who cannot rely on hue. */
  colorBlind: boolean
  /** Runs the staggered bounce across the placed cats after a win. */
  celebrating: boolean
  /** Dims the board while the fail sequence plays. */
  dimmed: boolean
  /** Receives the grid element so the input layer can attach its listeners. */
  gridRef: (element: HTMLElement | null) => void
}

/** The gap between cells, as a share of cell size, matching the reference art. */
const GAP_RATIO = 0.09
/** The colour-blind letter, as a share of cell size. */
const LETTER_RATIO = 0.26

export function Board({
  size,
  regions,
  cells,
  lastCat,
  lastWrong,
  hintCell,
  cursor,
  colorBlind,
  celebrating,
  dimmed,
  gridRef,
}: BoardProps) {
  const wrapper = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const element = wrapper.current
    if (!element) return
    const observer = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.width ?? 0
      setWidth((current) => (Math.abs(measured - current) > 0.5 ? measured : current))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const gap = Math.max(2, Math.round((width / size) * GAP_RATIO))
  const cellPx = width > 0 ? (width - gap * (size - 1)) / size : 0
  const letterPx = Math.max(8, cellPx * LETTER_RATIO)

  // The win bounce runs across cats in reading order, so the celebration reads
  // as a sweep rather than a simultaneous flash.
  let catSequence = 0

  return (
    <div
      className="rounded-[var(--mdk-radius-card)] bg-[var(--mdk-card)] p-2.5"
      style={{ boxShadow: 'var(--mdk-shadow-card)' }}
    >
      <div ref={wrapper}>
        <div
          ref={gridRef}
          role="grid"
          aria-label={`Puzzle board, ${size} by ${size}`}
          className="grid cursor-pointer touch-none"
          style={{
            gridTemplateColumns: `repeat(${size}, minmax(0, 1fr))`,
            gap: `${gap}px`,
          }}
        >
          {cells.map((state, index) => {
            const row = Math.floor(index / size)
            const col = index % size
            const key = regions[row]?.[col] ?? ''
            const isCat = state === CellState.Cat
            const isMark = state === CellState.X || state === CellState.Wrong
            const focused = cursor !== null && cursor.row === row && cursor.col === col

            let animation = 'none'
            if (state === CellState.Wrong && index === lastWrong) {
              animation = 'mdkShake .28s'
            }
            if (celebrating && isCat) {
              animation = `mdkBounce .5s ease ${(catSequence * 0.07).toFixed(2)}s`
            }
            if (isCat) catSequence++

            return (
              <div
                key={index}
                role="gridcell"
                aria-label={cellLabel(row, col, key, state)}
                className="relative flex aspect-square items-center justify-center transition-opacity duration-[400ms]"
                style={{
                  background: regionColorVar(key),
                  borderRadius: 'var(--mdk-cell-radius)',
                  animation,
                  boxShadow: focused
                    ? 'inset 0 0 0 3px var(--mdk-ink-pictogram)'
                    : index === hintCell
                      ? '0 0 0 3px var(--mdk-gold)'
                      : 'none',
                  opacity: dimmed ? 0.55 : 1,
                }}
              >
                {isMark ? (
                  <CrossMark
                    tone={state === CellState.Wrong ? 'wrong' : 'mark'}
                    style={{
                      width: '55%',
                      height: '55%',
                      display: 'block',
                      animation: state === CellState.X ? 'mdkFade .12s' : 'none',
                    }}
                  />
                ) : null}
                {isCat ? (
                  <span
                    style={{
                      width: '80%',
                      height: '80%',
                      display: 'block',
                      animation: index === lastCat && !celebrating ? 'mdkPop .2s ease-out' : 'none',
                    }}
                  >
                    <CatFace style={{ width: '100%', height: '100%', display: 'block' }} />
                  </span>
                ) : null}
                {colorBlind && !isCat ? (
                  <span
                    aria-hidden="true"
                    className="absolute font-black leading-[1.2]"
                    style={{
                      top: '4%',
                      left: '10%',
                      fontSize: `${letterPx}px`,
                      color: 'rgba(58, 40, 32, 0.4)',
                    }}
                  >
                    {key}
                  </span>
                ) : null}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

const STATE_LABELS: Record<CellState, string> = {
  [CellState.Empty]: 'empty',
  [CellState.X]: 'marked not a cat',
  [CellState.Cat]: 'cat',
  [CellState.Wrong]: 'wrong guess',
}

const cellLabel = (row: number, col: number, key: string, state: CellState): string =>
  `Row ${row + 1}, column ${col + 1}, ${regionName(key)}, ${STATE_LABELS[state]}`
