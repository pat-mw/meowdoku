import { useEffect, useRef, useState } from 'react'
import { CellState } from '../board/types'
import type { BoardGesture } from './useBoardPointer'

/**
 * Desktop keyboard play.
 *
 * Arrow keys move a focus cursor over the board, X marks and unmarks, Enter or
 * Space attempts a cat, and Backspace or Delete clears a mark. The cursor only
 * appears once an arrow key is pressed, so a player who never touches the
 * keyboard never sees it.
 */

export type BoardCursor = { row: number; col: number } | null

export type BoardKeyboardOptions = {
  size: number
  enabled: boolean
  cellStateAt: (index: number) => CellState
  onGesture: (gesture: BoardGesture) => void
}

const ARROWS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])

export const useBoardKeyboard = ({ size, enabled, cellStateAt, onGesture }: BoardKeyboardOptions) => {
  const [cursor, setCursor] = useState<BoardCursor>(null)
  const latest = useRef({ size, enabled, cellStateAt, onGesture, cursor })
  latest.current = { size, enabled, cellStateAt, onGesture, cursor }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const { size: n, enabled: on, cellStateAt: stateAt, onGesture: emit, cursor: at } = latest.current
      if (!on) return
      if (event.metaKey || event.ctrlKey || event.altKey) return

      if (ARROWS.has(event.key)) {
        event.preventDefault()
        // The first arrow press only summons the cursor; it does not move it,
        // so the player can see where they are before travelling.
        if (!at) {
          setCursor({ row: 0, col: 0 })
          return
        }
        setCursor({
          row:
            event.key === 'ArrowUp'
              ? Math.max(0, at.row - 1)
              : event.key === 'ArrowDown'
                ? Math.min(n - 1, at.row + 1)
                : at.row,
          col:
            event.key === 'ArrowLeft'
              ? Math.max(0, at.col - 1)
              : event.key === 'ArrowRight'
                ? Math.min(n - 1, at.col + 1)
                : at.col,
        })
        return
      }

      if (!at) return
      const index = at.row * n + at.col
      const state = stateAt(index)

      if (event.key === 'x' || event.key === 'X') {
        // One key toggles both ways, matching what a tap does with a pointer.
        if (state === CellState.Empty || state === CellState.X) emit({ type: 'tap', index })
        return
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        if (state === CellState.Empty || state === CellState.X) emit({ type: 'doubleTap', index })
        return
      }
      if (event.key === 'Backspace' || event.key === 'Delete') {
        event.preventDefault()
        if (state === CellState.X) emit({ type: 'longPress', index })
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return { cursor, setCursor }
}
