import { useMemo } from 'react'
import { Rng } from '../board/generator/prng'
import { ALL_REGION_COLORS } from './palette'

/**
 * The win celebration.
 *
 * Twenty-six paper scraps fall once and stop; there is no loop and no canvas.
 * Their positions come from the seeded PRNG rather than Math.random so a
 * screenshot test of the win overlay is reproducible, and so the burst looks
 * the same each time a given level is won.
 */

const PIECE_COUNT = 26

export function Confetti({ seed }: { seed: number }) {
  const pieces = useMemo(() => {
    const rng = new Rng(seed)
    return Array.from({ length: PIECE_COUNT }, (_, index) => ({
      left: rng.nextInt(101),
      // 1.4s to 2.3s fall, staggered over the first 0.4s.
      duration: (1.4 + rng.nextInt(90) / 100).toFixed(2),
      delay: (rng.nextInt(40) / 100).toFixed(2),
      color: ALL_REGION_COLORS[index % ALL_REGION_COLORS.length],
    }))
  }, [seed])

  return (
    <div
      className="pointer-events-none fixed inset-0 overflow-hidden"
      style={{ zIndex: 60 }}
      aria-hidden="true"
    >
      {pieces.map((piece, index) => (
        <div
          key={index}
          className="absolute rounded-[3px]"
          style={{
            left: `${piece.left}%`,
            top: '-5vh',
            width: 10,
            height: 14,
            background: piece.color,
            opacity: 0,
            animation: `mdkConfetti ${piece.duration}s linear ${piece.delay}s forwards`,
          }}
        />
      ))}
    </div>
  )
}
