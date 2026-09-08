import { useEffect, useEffectEvent, useRef, useState } from 'react'
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
 *
 * The listeners are installed once per element and read the current board
 * through effect events, so a re-render never has to tear them down and rebuild
 * them mid-stroke.
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
  cells: readonly CellState[]
  onGesture: (gesture: BoardGesture) => void
}

export const useBoardPointer = ({ size, enabled, cells, onGesture }: BoardPointerOptions) => {
  const readSize = useEffectEvent(() => size)
  const isEnabled = useEffectEvent(() => enabled)
  const stateAt = useEffectEvent((index: number) => cells[index] ?? CellState.Empty)
  const emit = useEffectEvent((gesture: BoardGesture) => onGesture(gesture))

  const stroke = useRef<Stroke | null>(null)
  const lastTap = useRef<{ index: number; at: number } | null>(null)
  const pending = useRef<number[]>([])
  const frame = useRef<number | null>(null)

  // The board element is held in state rather than a ref so the listeners can be
  // installed from an effect, which is the only place an effect event may be
  // called from. The ref callback is just the setter.
  const [element, setElement] = useState<HTMLElement | null>(null)

  useEffect(() => {
    if (!element) return

    const flush = () => {
      frame.current = null
      const indices = pending.current
      if (indices.length === 0) return
      pending.current = []
      emit({ type: 'paint', indices })
    }

    const queuePaint = (index: number) => {
      if (pending.current.includes(index)) return
      pending.current.push(index)
      frame.current ??= requestAnimationFrame(flush)
    }

    /** The cell under a pointer, or -1 when it is outside the board. */
    const indexAt = (clientX: number, clientY: number, rect: DOMRect): number => {
      const n = readSize()
      const x = clientX - rect.left
      const y = clientY - rect.top
      if (x < 0 || y < 0 || x >= rect.width || y >= rect.height) return -1
      const row = Math.min(n - 1, Math.floor((y / rect.height) * n))
      const col = Math.min(n - 1, Math.floor((x / rect.width) * n))
      return row * n + col
    }

    const clearStroke = () => {
      const active = stroke.current
      if (active && active.longPressTimer !== null) clearTimeout(active.longPressTimer)
      stroke.current = null
    }

    const onPointerDown = (event: PointerEvent) => {
      if (!isEnabled()) return
      // A second finger means the player is pinching or panning a large board,
      // not painting. Abandon the stroke in flight so the zoom layer owns the
      // gesture and the release does not also register as a tap.
      if (stroke.current) {
        clearStroke()
        return
      }
      // Kills the iOS double-tap-to-zoom that would otherwise fire on a cat
      // placement, and stops the browser starting a text selection.
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
      const startState = stateAt(index)
      const active: Stroke = {
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
      // A held press is a long press whatever it started on. Only a marked cell
      // does anything with it — clearing the mark — but the press is consumed
      // either way, so resting a finger on an empty cell never marks it.
      active.longPressTimer = window.setTimeout(() => {
        const current = stroke.current
        if (!current || current.moved) return
        current.consumed = true
        current.longPressTimer = null
        emit({ type: 'longPress', index })
      }, LONG_PRESS_MS)
      stroke.current = active
    }

    const onPointerMove = (event: PointerEvent) => {
      const active = stroke.current
      if (!active || event.pointerId !== active.pointerId) return
      if (!active.moved) {
        const dx = event.clientX - active.startX
        const dy = event.clientY - active.startY
        if (Math.hypot(dx, dy) <= DRAG_THRESHOLD_PX) return
        active.moved = true
        if (active.longPressTimer !== null) {
          clearTimeout(active.longPressTimer)
          active.longPressTimer = null
        }
        // A drag only paints when it began on an empty cell; starting on an X, a
        // cat or a wrong guess drags nothing.
        if (active.startState === CellState.Empty) {
          active.painting = true
          queuePaint(active.startIndex)
        }
      }
      if (!active.painting) return
      const index = indexAt(event.clientX, event.clientY, active.rect)
      if (index >= 0) queuePaint(index)
    }

    const onPointerUp = (event: PointerEvent) => {
      const active = stroke.current
      if (!active || event.pointerId !== active.pointerId) return
      clearStroke()
      if (active.consumed || active.moved) return
      const now = event.timeStamp
      const previous = lastTap.current
      // Double-tap detection is per cell: two taps on different cells are two taps.
      if (previous && previous.index === active.startIndex && now - previous.at < DOUBLE_TAP_MS) {
        lastTap.current = null
        emit({ type: 'doubleTap', index: active.startIndex })
        return
      }
      lastTap.current = { index: active.startIndex, at: now }
      emit({ type: 'tap', index: active.startIndex })
    }

    const onPointerCancel = (event: PointerEvent) => {
      const active = stroke.current
      if (!active || event.pointerId !== active.pointerId) return
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
      if (frame.current !== null) {
        cancelAnimationFrame(frame.current)
        frame.current = null
      }
      pending.current = []
    }
  }, [element])

  return setElement
}
