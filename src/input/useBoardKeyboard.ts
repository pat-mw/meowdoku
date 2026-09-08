import { useEffect, useEffectEvent, useState } from 'react'
import { CellState } from '../board/types'
import type { BoardGesture } from './useBoardPointer'

/**
 * Desktop keyboard play.
 *
 * Arrow keys move a focus cursor over the board, X marks and unmarks, Enter or
 * Space attempts a cat, and Backspace or Delete clears a mark. The cursor only
 * appears once an arrow key is pressed, so a player who never touches the
 * keyboard never sees a focus ring they did not ask for.
 */

export type BoardCursor = { row: number; col: number } | null

export type BoardKeyboardOptions = {
  size: number
  enabled: boolean
  cells: readonly CellState[]
  onGesture: (gesture: BoardGesture) => void
}

const ARROWS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])

export const useBoardKeyboard = ({ size, enabled, cells, onGesture }: BoardKeyboardOptions) => {
  const [cursor, setCursor] = useState<BoardCursor>(null)

  const handleKey = useEffectEvent((event: KeyboardEvent) => {
    if (!enabled) return
    if (event.metaKey || event.ctrlKey || event.altKey) return

    if (ARROWS.has(event.key)) {
      event.preventDefault()
      // The first arrow press only summons the cursor; it does not move it, so
      // the player can see where they are before travelling.
      if (!cursor) {
        setCursor({ row: 0, col: 0 })
        return
      }
      setCursor({
        row:
          event.key === 'ArrowUp'
            ? Math.max(0, cursor.row - 1)
            : event.key === 'ArrowDown'
              ? Math.min(size - 1, cursor.row + 1)
              : cursor.row,
        col:
          event.key === 'ArrowLeft'
            ? Math.max(0, cursor.col - 1)
            : event.key === 'ArrowRight'
              ? Math.min(size - 1, cursor.col + 1)
              : cursor.col,
      })
      return
    }

    if (!cursor) return
    const index = cursor.row * size + cursor.col
    const state = cells[index] ?? CellState.Empty

    if (event.key === 'x' || event.key === 'X') {
      // One key toggles both ways, matching what a tap does with a pointer.
      if (state === CellState.Empty || state === CellState.X) onGesture({ type: 'tap', index })
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (state === CellState.Empty || state === CellState.X)
        onGesture({ type: 'doubleTap', index })
      return
    }
    if (event.key === 'Backspace' || event.key === 'Delete') {
      event.preventDefault()
      if (state === CellState.X) onGesture({ type: 'longPress', index })
    }
  })

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => handleKey(event)
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return { cursor, setCursor }
}
