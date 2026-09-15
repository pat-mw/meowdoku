import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type { ReactNode } from 'react'

/**
 * Pinch-to-zoom and two-finger pan for large boards.
 *
 * At 15x15 on a 360px phone a cell is about 22px — below a comfortable touch
 * target — so boards from 13x13 up get their own zoom layer. It is implemented
 * with a CSS transform rather than native page zoom, because page zoom would
 * also scale the header and fight the `user-scalable=no` viewport that stops
 * double-tap zoom firing on cat placement.
 *
 * One finger is left entirely alone: it still paints marks on the board
 * underneath. Only a second finger engages this layer.
 */

const MIN_SCALE = 1
const MAX_SCALE = 3

type Point = { x: number; y: number }

const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y)
const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value

export function ZoomPan({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const frame = useRef<HTMLDivElement | null>(null)
  const [transform, setTransform] = useState({ scale: 1, x: 0, y: 0 })
  const pointers = useRef(new Map<number, Point>())
  const gesture = useRef<{
    distance: number
    centre: Point
    scale: number
    x: number
    y: number
  } | null>(null)

  /** Keeps the board from being dragged off its own card. */
  const constrain = (next: { scale: number; x: number; y: number }) => {
    const box = frame.current?.getBoundingClientRect()
    if (!box) return next
    const slackX = (box.width * (next.scale - 1)) / 2
    const slackY = (box.height * (next.scale - 1)) / 2
    return {
      scale: next.scale,
      x: clamp(next.x, -slackX, slackX),
      y: clamp(next.y, -slackY, slackY),
    }
  }

  // The gesture reads the transform it started from, so the listeners are
  // installed once instead of being torn down on every frame of a pinch.
  const beginGesture = useEffectEvent((spread: number, centre: Point) => {
    gesture.current = {
      distance: spread,
      centre,
      scale: transform.scale,
      x: transform.x,
      y: transform.y,
    }
  })
  const applyGesture = useEffectEvent((next: { scale: number; x: number; y: number }) => {
    setTransform(constrain(next))
  })

  useEffect(() => {
    const element = frame.current
    if (!element || !enabled) return

    const onDown = (event: PointerEvent) => {
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (pointers.current.size !== 2) return
      const [a, b] = [...pointers.current.values()] as [Point, Point]
      beginGesture(distance(a, b), midpoint(a, b))
    }

    const onMove = (event: PointerEvent) => {
      if (!pointers.current.has(event.pointerId)) return
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
      const active = gesture.current
      if (!active || pointers.current.size < 2) return
      event.preventDefault()
      const [a, b] = [...pointers.current.values()] as [Point, Point]
      const spread = distance(a, b)
      const centre = midpoint(a, b)
      const scale = clamp((spread / active.distance) * active.scale, MIN_SCALE, MAX_SCALE)
      applyGesture({
        scale,
        x: active.x + (centre.x - active.centre.x),
        y: active.y + (centre.y - active.centre.y),
      })
    }

    const onUp = (event: PointerEvent) => {
      pointers.current.delete(event.pointerId)
      if (pointers.current.size < 2) gesture.current = null
    }

    const tracked = pointers.current
    element.addEventListener('pointerdown', onDown)
    element.addEventListener('pointermove', onMove, { passive: false })
    element.addEventListener('pointerup', onUp)
    element.addEventListener('pointercancel', onUp)
    element.addEventListener('pointerleave', onUp)
    return () => {
      element.removeEventListener('pointerdown', onDown)
      element.removeEventListener('pointermove', onMove)
      element.removeEventListener('pointerup', onUp)
      element.removeEventListener('pointercancel', onUp)
      element.removeEventListener('pointerleave', onUp)
      tracked.clear()
      gesture.current = null
    }
  }, [enabled])

  if (!enabled) return <>{children}</>

  const zoomed = transform.scale > 1.001

  return (
    <div className="relative">
      <div ref={frame} className="overflow-hidden rounded-[var(--mdk-radius-card)]">
        <div
          style={{
            transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
            transformOrigin: 'center center',
            willChange: zoomed ? 'transform' : 'auto',
          }}
        >
          {children}
        </div>
      </div>
      {zoomed ? (
        <button
          type="button"
          onClick={() => setTransform({ scale: 1, x: 0, y: 0 })}
          className="absolute right-2 top-2 rounded-full border-none bg-[var(--mdk-card)] px-3 py-1.5 text-[12px] font-extrabold text-[var(--mdk-ink)]"
          style={{ boxShadow: 'var(--mdk-shadow-card)' }}
        >
          Fit
        </button>
      ) : null}
    </div>
  )
}

/** Boards this size or larger get the zoom layer, and move the rules strip
    below the toolbar so the grid keeps the height above it. */
export const LARGE_BOARD_SIZE = 13
