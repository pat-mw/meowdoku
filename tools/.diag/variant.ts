import type { Rng } from '../../src/board/generator/prng'
import type { RegionShape } from '../../src/board/generator/tiers'

export type RegionMap = Int32Array
const UNASSIGNED = -1
const NONE = -1

export type Opts = {
  floor: number
  fillerShare: number
  decay: number
  smallShape: RegionShape | null // override cohesion weights for non-filler regions
  order: 'fraction' | 'smallFirst'
  bandBias: number // extra weight for cells inside the region's current row window
  bandRows: number
}

const COH: Record<RegionShape, readonly number[]> = {
  blocky: [1, 12, 72, 288],
  mixed: [1, 1, 1, 1],
  irregular: [8, 4, 2, 1],
  snaking: [40, 8, 2, 1],
}

const nb = (t: Int32Array, c: number, d: number): number => t[c * 4 + d] ?? NONE
const rAt = (r: RegionMap, c: number): number => r[c] ?? UNASSIGNED

const table = (size: number): Int32Array => {
  const t = new Int32Array(size * size * 4).fill(NONE)
  for (let row = 0; row < size; row++)
    for (let col = 0; col < size; col++) {
      const cell = row * size + col
      const b = cell * 4
      if (row > 0) t[b] = cell - size
      if (col < size - 1) t[b + 1] = cell + 1
      if (row < size - 1) t[b + 2] = cell + size
      if (col > 0) t[b + 3] = cell - 1
    }
  return t
}

type S = {
  frontier: number[]
  queued: Uint8Array
  count: number
  target: number
  tip: number
  tipDir: number
  minRow: number
  maxRow: number
  minCol: number
  maxCol: number
}

export const targetsFor = (rng: Rng, size: number, o: Opts): number[] => {
  const cells = size * size
  const f = Math.max(1, Math.min(o.floor, Math.floor(cells / size)))
  const t = new Array<number>(size).fill(f)
  let surplus = cells - f * size
  if (surplus <= 0 || size < 2) return t
  const filler = Math.floor((surplus * o.fillerShare) / 100)
  t[0] = f + filler
  surplus -= filler
  const others = size - 1
  const w: number[] = []
  let x = 4096
  let tot = 0
  for (let i = 0; i < others; i++) {
    w.push(x)
    tot += x
    x = Math.max(1, Math.floor((x * o.decay) / 8))
  }
  const shares: number[] = []
  const rem: number[] = []
  let handed = 0
  for (let i = 0; i < others; i++) {
    const e = surplus * (w[i] ?? 0)
    const s = Math.floor(e / tot)
    shares.push(s)
    rem.push(e - s * tot)
    handed += s
  }
  for (let left = surplus - handed; left > 0; left--) {
    let best = 0
    let br = -1
    for (let i = 0; i < others; i++) {
      const r = rem[i] ?? -1
      if (r > br) {
        br = r
        best = i
      }
    }
    shares[best] = (shares[best] ?? 0) + 1
    rem[best] = -1
  }
  for (let i = 0; i < others; i++) t[i + 1] = f + (shares[i] ?? 0)
  return rng.shuffle(t)
}

const less = (a: number, b: number, c: number, d: number): boolean => a * d < c * b

export const makeGrow =
  (o: Opts) =>
  (rng: Rng, size: number, placement: readonly number[], shape: RegionShape): RegionMap => {
    const cells = size * size
    const regions: RegionMap = new Int32Array(cells).fill(UNASSIGNED)
    const nt = table(size)
    const targets = targetsFor(rng, size, o)
    const states: S[] = []
    for (let r = 0; r < size; r++) {
      const col = placement[r] ?? 0
      const seed = r * size + col
      regions[seed] = r
      states.push({
        frontier: [],
        queued: new Uint8Array(cells),
        count: 1,
        target: Math.max(1, targets[r] ?? 1),
        tip: seed,
        tipDir: NONE,
        minRow: r,
        maxRow: r,
        minCol: col,
        maxCol: col,
      })
    }
    const enq = (s: S, cell: number): void => {
      for (let d = 0; d < 4; d++) {
        const n = nb(nt, cell, d)
        if (n < 0 || rAt(regions, n) !== UNASSIGNED || s.queued[n] === 1) continue
        s.queued[n] = 1
        s.frontier.push(n)
      }
    }
    for (const s of states) enq(s, s.tip)
    const deq = (s: S, cell: number): void => {
      if (s.queued[cell] !== 1) return
      s.queued[cell] = 0
      for (let i = 0; i < s.frontier.length; i++) {
        if (s.frontier[i] !== cell) continue
        const m = s.frontier.pop()
        if (m !== undefined && i < s.frontier.length) s.frontier[i] = m
        return
      }
    }
    const maxTarget = Math.max(...targets)
    const pickRegion = (): number => {
      const tied: number[] = []
      let bc = 0
      let bt = 0
      for (let r = 0; r < states.length; r++) {
        const s = states[r]
        if (!s || s.frontier.length === 0 || s.count >= s.target) continue
        // smallFirst: regions with target < maxTarget go first, ranked by fraction
        const rank = o.order === 'smallFirst' && s.target === maxTarget ? 1 : 0
        const c = s.count + rank * 1000
        if (tied.length === 0 || less(c, s.target, bc, bt)) {
          bc = c
          bt = s.target
          tied.length = 0
          tied.push(r)
          continue
        }
        if (!less(bc, bt, c, s.target)) tied.push(r)
      }
      if (tied.length === 0) return NONE
      return tied.length === 1 ? (tied[0] ?? NONE) : rng.pick(tied)
    }
    const isFiller = (s: S): boolean => s.target === maxTarget
    const pickCell = (s: S, region: number): number => {
      const fr = s.frontier
      if (fr.length === 0) return NONE
      const useShape = isFiller(s) ? shape : (o.smallShape ?? shape)
      const straight = s.tipDir === NONE ? NONE : nb(nt, s.tip, s.tipDir)
      const w: number[] = []
      let tot = 0
      for (const cell of fr) {
        let coh = 0
        for (let d = 0; d < 4; d++) {
          const n = nb(nt, cell, d)
          if (n >= 0 && rAt(regions, n) === region) coh++
        }
        let weight = COH[useShape][coh - 1] ?? 1
        if (useShape === 'snaking' && cell === straight) weight *= 6
        if (!isFiller(s) && o.bandBias > 1) {
          const row = Math.floor(cell / size)
          const col = cell % size
          const nr = Math.max(s.maxRow, row) - Math.min(s.minRow, row) + 1
          const nc = Math.max(s.maxCol, col) - Math.min(s.minCol, col) + 1
          if (nr <= o.bandRows && nc <= o.bandRows) weight *= o.bandBias
        }
        w.push(weight)
        tot += weight
      }
      let t = rng.nextInt(tot)
      for (let i = 0; i < fr.length; i++) {
        t -= w[i] ?? 0
        if (t < 0) return fr[i] ?? NONE
      }
      return fr[fr.length - 1] ?? NONE
    }
    const claim = (s: S, region: number, cell: number): void => {
      regions[cell] = region
      s.count++
      let dir = NONE
      for (let d = 0; d < 4; d++) if (nb(nt, s.tip, d) === cell) dir = d
      s.tipDir = dir
      s.tip = cell
      const row = Math.floor(cell / size)
      const col = cell % size
      if (row < s.minRow) s.minRow = row
      if (row > s.maxRow) s.maxRow = row
      if (col < s.minCol) s.minCol = col
      if (col > s.maxCol) s.maxCol = col
      for (let d = 0; d < 4; d++) {
        const n = nb(nt, cell, d)
        if (n < 0) continue
        const owner = rAt(regions, n)
        if (owner === UNASSIGNED) continue
        const os = states[owner]
        if (os) deq(os, cell)
      }
      enq(s, cell)
    }
    for (let a = size; a < cells; a++) {
      const r = pickRegion()
      if (r === NONE) break
      const s = states[r]
      if (!s) break
      const c = pickCell(s, r)
      if (c === NONE) break
      claim(s, r, c)
    }
    // stranded
    let remaining = 0
    for (let c = 0; c < cells; c++) if (rAt(regions, c) === UNASSIGNED) remaining++
    while (remaining > 0) {
      let placed = 0
      for (let cell = 0; cell < cells; cell++) {
        if (rAt(regions, cell) !== UNASSIGNED) continue
        const tied: number[] = []
        let bc = 0
        let bt = 0
        for (let d = 0; d < 4; d++) {
          const n = nb(nt, cell, d)
          if (n < 0) continue
          const owner = rAt(regions, n)
          const s = owner === UNASSIGNED ? undefined : states[owner]
          if (!s || tied.includes(owner)) continue
          if (tied.length === 0 || less(s.count, s.target, bc, bt)) {
            bc = s.count
            bt = s.target
            tied.length = 0
            tied.push(owner)
            continue
          }
          if (!less(bc, bt, s.count, s.target)) tied.push(owner)
        }
        if (tied.length === 0) continue
        const owner = tied.length === 1 ? (tied[0] ?? NONE) : rng.pick(tied)
        const s = owner === NONE ? undefined : states[owner]
        if (!s) continue
        regions[cell] = owner
        s.count++
        remaining--
        placed++
      }
      if (placed === 0) break
    }
    return regions
  }
