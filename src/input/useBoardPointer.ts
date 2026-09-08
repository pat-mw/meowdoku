import { useCallback, useEffect, useRef } from 'react'
import { CellState } from '../board/types'

/**
 * Pointer handling for the board.
 *
 * One listener set lives on the board container rather than on 225 cells, the
 * cell under the pointer is derived from coordinates against the board rect
 * (never `elementFromPoint`, which is a hit test per move), and the pointer is
 * captured so a stroke that wanders off the board keeps painting. Painted cells
 * are batched and flushed once per animation frame, so a fast drag across a
 * 15x15 board produces at most one state update per frame.
 */

export type BoardGesture =
  | { type: 'tap'; index: number }
  | { type: 'doubleTap'; index: number }
  | { type: 'longPress'; index: number }
  | { type: 'paint'; indices: number[] }

/** Movement past this many pixels turns a press into a drag. */
const DRAG_THRESHOLD_PX = 6
/** A press held this long without moving is a long press. */
const LONG_PRESS_MS = 350
/** Two taps on the same cell within this window are a double tap. */
const DOUBLE_TAP_MS = 300

type Stroke = {
  pointerId: number
  startX: number
  startY: number
  startIndex: number
  startState: CellState
  moved: boolean
  painting: boolean
  /** Set once a long press has already acted, so the release is not also a tap. */
  consumed: boolean
  longPressTimer: number | null
  rect: DOMRect
}

export type BoardPointerOptions = {
  size: number
  /** Gestures are ignored while an overlay is up or the level is over. */
  enabled: boolean
  cellStateAt: (index: number) => CellState
  onGesture: (gesture: BoardGesture) => void
}

export const useBoardPointer = ({ size, enabled, cellStateAt, onGesture }: BoardPointerOptions) => {
  // The handlers are installed once per element, so they read the current props
  // through refs rather than closing over a stale render.
  const latest = useRef({ size, enabled, cellStateAt, onGesture })
  latest.current = { size, enabled, cellStateAt, onGesture }

  const stroke = useRef<Stroke | null>(null)
  const lastTap = useRef<{ index: number; at: number } | null>(null)
  const pending = useRef<number[]>([])
  const frame = useRef<number | null>(null)

  const flush = useCallback(() => {
    frame.current = null
    const indices = pending.current
    if (indices.length === 0) return
    pending.current = []
    latest.current.onGesture({ type: 'paint', indices })
  }, [])

  const queuePaint = useCallback(
    (index: number) => {
      if (pending.current.includes(index)) return
      pending.current.push(index)
      frame.current ??= requestAnimationFrame(flush)
    },
    [flush],
  )

  useEffect(() => {
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current)
    }
  }, [])

  const attach = useCallback(
    (element: HTMLElement | null) => {
      if (!element) return undefined

      /** The cell under a pointer, or -1 when it is outside the board. */
      const indexAt = (clientX: number, clientY: number, rect: DOMRect): number => {
        const n = latest.current.size
        const x = clientX - rect.left
        const y = clientY - rect.top
        if (x < 0 || y < 0 || x >= rect.width || y >= rect.height) return -1
        const row = Math.min(n - 1, Math.floor((y / rect.height) * n))
        const col = Math.min(n - 1, Math.floor((x / rect.width) * n))
        return row * n + col
      }

      const clearStroke = () => {
        const s = stroke.current
        if (s?.longPressTimer !== null && s?.longPressTimer !== undefined) {
          clearTimeout(s.longPressTimer)
        }
        stroke.current = null
      }

      const onPointerDown = (event: PointerEvent) => {
        if (!latest.current.enabled) return
        // A second finger means the player is pinching or panning a large board,
        // not painting. Abandon the stroke in flight so the zoom layer owns the
        // gesture and the release does not also register as a tap.
        if (stroke.current) {
          clearStroke()
          return
        }
        // Kills the iOS double-tap-to-zoom that would otherwise fire on a cat
        // placement, and stops the browser from starting a text selection.
        event.preventDefault()
        // The board cannot move during a stroke because `touch-action: none`
        // suppresses scrolling, so the rect is read once instead of per move.
        const rect = element.getBoundingClientRect()
        const index = indexAt(event.clientX, event.clientY, rect)
        if (index < 0) return
        try {
          element.setPointerCapture(event.pointerId)
        } catch {
          // Capture is a nicety; a stroke without it still works inside the board.
        }
        const startState = latest.current.cellStateAt(index)
        const s: Stroke = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          startIndex: index,
          startState,
          moved: false,
          painting: false,
          consumed: false,
          longPressTimer: null,
          rect,
        }
        // Only a marked cell can be long-pressed, and only to clear the mark.
        if (startState === CellState.X) {
          s.longPressTimer = window.setTimeout(() => {
            const current = stroke.current
            if (!current || current.moved) return
            current.consumed = true
            current.longPressTimer = null
            latest.current.onGesture({ type: 'longPress', index })
          }, LONG_PRESS_MS)
        }
        stroke.current = s
      }

      const onPointerMove = (event: PointerEvent) => {
        const s = stroke.current
        if (!s || event.pointerId !== s.pointerId) return
        if (!s.moved) {
          const dx = event.clientX - s.startX
          const dy = event.clientY - s.startY
          if (Math.hypot(dx, dy) <= DRAG_THRESHOLD_PX) return
          s.moved = true
          if (s.longPressTimer !== null) {
            clearTimeout(s.longPressTimer)
            s.longPressTimer = null
          }
          // A drag only paints when it began on an empty cell; starting on an
          // X, a cat or a wrong guess drags nothing.
          if (s.startState === CellState.Empty) {
            s.painting = true
            queuePaint(s.startIndex)
          }
        }
        if (!s.painting) return
        const index = indexAt(event.clientX, event.clientY, s.rect)
        if (index >= 0) queuePaint(index)
      }

      const onPointerUp = (event: PointerEvent) => {
        const s = stroke.current
        if (!s || event.pointerId !== s.pointerId) return
        clearStroke()
        if (s.consumed || s.moved) return
        const now = event.timeStamp
        const previous = lastTap.current
        // Double-tap detection is per cell: two taps on different cells are two taps.
        if (previous && previous.index === s.startIndex && now - previous.at < DOUBLE_TAP_MS) {
          lastTap.current = null
          latest.current.onGesture({ type: 'doubleTap', index: s.startIndex })
          return
        }
        lastTap.current = { index: s.startIndex, at: now }
        latest.current.onGesture({ type: 'tap', index: s.startIndex })
      }

      const onPointerCancel = (event: PointerEvent) => {
        const s = stroke.current
        if (!s || event.pointerId !== s.pointerId) return
        clearStroke()
      }

      element.addEventListener('pointerdown', onPointerDown)
      element.addEventListener('pointermove', onPointerMove)
      element.addEventListener('pointerup', onPointerUp)
      element.addEventListener('pointercancel', onPointerCancel)

      return () => {
        element.removeEventListener('pointerdown', onPointerDown)
        element.removeEventListener('pointermove', onPointerMove)
        element.removeEventListener('pointerup', onPointerUp)
        element.removeEventListener('pointercancel', onPointerCancel)
        clearStroke()
      }
    },
    [queuePaint],
  )

  return attach
}
