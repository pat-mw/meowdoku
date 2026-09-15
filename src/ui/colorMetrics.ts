/**
 * Perceptual colour measurement for the region palette.
 *
 * The region colours have to be told apart at a glance in flat 22px blocks that
 * touch each other, so "are these two different?" has to be answered in a space
 * where equal numeric steps look like equal visual steps. Everything here works
 * in CIELAB with the CIEDE2000 difference formula for that reason: distance in
 * raw sRGB (or in hue degrees) badly under-reports differences in the yellows
 * and over-reports them in the blues, which is exactly the region of the
 * palette where the colours crowd together.
 *
 * The dichromat simulations follow Vienot, Brettel & Mollon (1999): project
 * linear-light RGB into LMS cone space, collapse the missing cone's response
 * onto the plane spanned by the two that remain, and project back. It models
 * full dichromacy (protanopia and deuteranopia) rather than the milder
 * anomalous trichromacy, so it is the pessimistic case, which is what a
 * legibility floor should be measured against.
 *
 * No runtime code paints from this module; it exists so the palette's
 * separation guarantees can be asserted rather than assumed.
 */

export type Rgb = [number, number, number]
export type Lab = [number, number, number]
type Matrix = [Rgb, Rgb, Rgb]

/** Parses `#rrggbb` into channel values in 0..1. Throws on anything else. */
export const hexToRgb = (hex: string): Rgb => {
  const match = /^#([0-9a-fA-F]{6})$/.exec(hex.trim())
  if (!match?.[1]) throw new Error(`not a six-digit hex colour: ${hex}`)
  const value = Number.parseInt(match[1], 16)
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255]
}

const channelToLinear = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)

const channelToSrgb = (c: number): number =>
  c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055

const toLinear = (rgb: Rgb): Rgb => [
  channelToLinear(rgb[0]),
  channelToLinear(rgb[1]),
  channelToLinear(rgb[2]),
]

const clamp01 = (c: number): number => Math.min(1, Math.max(0, c))

const toSrgb = (linear: Rgb): Rgb => [
  clamp01(channelToSrgb(clamp01(linear[0]))),
  clamp01(channelToSrgb(clamp01(linear[1]))),
  clamp01(channelToSrgb(clamp01(linear[2]))),
]

const apply = (m: Matrix, v: Rgb): Rgb => [
  m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
  m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
  m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
]

/** D65 white point, the reference sRGB is defined against. */
const WHITE_POINT: Rgb = [0.95047, 1.0, 1.08883]

const LINEAR_RGB_TO_XYZ: Matrix = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.072175],
  [0.0193339, 0.119192, 0.9503041],
]

/** CIELAB, D65. */
export const hexToLab = (hex: string): Lab => {
  const xyz = apply(LINEAR_RGB_TO_XYZ, toLinear(hexToRgb(hex)))
  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29)
  const fx = f(xyz[0] / WHITE_POINT[0])
  const fy = f(xyz[1] / WHITE_POINT[1])
  const fz = f(xyz[2] / WHITE_POINT[2])
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

const RAD = Math.PI / 180
const DEG = 180 / Math.PI

/**
 * CIEDE2000 colour difference, with all three weighting factors at 1. Roughly:
 * 1 is the just-noticeable difference between two large patches under ideal
 * viewing, and the number grows about linearly with how obviously different a
 * pair looks.
 */
export const ciede2000 = (a: Lab, b: Lab): number => {
  const [l1, a1, b1] = a
  const [l2, a2, b2] = b
  const c1 = Math.hypot(a1, b1)
  const c2 = Math.hypot(a2, b2)
  const cBar = (c1 + c2) / 2
  const g = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)))
  const a1p = (1 + g) * a1
  const a2p = (1 + g) * a2
  const c1p = Math.hypot(a1p, b1)
  const c2p = Math.hypot(a2p, b2)
  const hue = (bComponent: number, aComponent: number): number => {
    if (bComponent === 0 && aComponent === 0) return 0
    const h = Math.atan2(bComponent, aComponent) * DEG
    return h < 0 ? h + 360 : h
  }
  const h1p = hue(b1, a1p)
  const h2p = hue(b2, a2p)
  const dLp = l2 - l1
  const dCp = c2p - c1p
  let dhp = 0
  if (c1p * c2p !== 0) {
    dhp = h2p - h1p
    if (dhp > 180) dhp -= 360
    else if (dhp < -180) dhp += 360
  }
  const dHp = 2 * Math.sqrt(c1p * c2p) * Math.sin((dhp * RAD) / 2)
  const lBar = (l1 + l2) / 2
  const cBarP = (c1p + c2p) / 2
  let hBarP: number
  if (c1p * c2p === 0) hBarP = h1p + h2p
  else if (Math.abs(h1p - h2p) <= 180) hBarP = (h1p + h2p) / 2
  else if (h1p + h2p < 360) hBarP = (h1p + h2p + 360) / 2
  else hBarP = (h1p + h2p - 360) / 2
  const t =
    1 -
    0.17 * Math.cos((hBarP - 30) * RAD) +
    0.24 * Math.cos(2 * hBarP * RAD) +
    0.32 * Math.cos((3 * hBarP + 6) * RAD) -
    0.2 * Math.cos((4 * hBarP - 63) * RAD)
  const dTheta = 30 * Math.exp(-(((hBarP - 275) / 25) ** 2))
  const rc = 2 * Math.sqrt(cBarP ** 7 / (cBarP ** 7 + 25 ** 7))
  const sl = 1 + (0.015 * (lBar - 50) ** 2) / Math.sqrt(20 + (lBar - 50) ** 2)
  const sc = 1 + 0.045 * cBarP
  const sh = 1 + 0.015 * cBarP * t
  const rt = -Math.sin(2 * dTheta * RAD) * rc
  return Math.sqrt(
    (dLp / sl) ** 2 + (dCp / sc) ** 2 + (dHp / sh) ** 2 + rt * (dCp / sc) * (dHp / sh),
  )
}

/** CIEDE2000 between two `#rrggbb` colours. */
export const deltaE = (a: string, b: string): number => ciede2000(hexToLab(a), hexToLab(b))

const rgbToHex = (rgb: Rgb): string =>
  '#' +
  rgb
    .map((c) =>
      Math.round(clamp01(c) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')

/** Hunt-Pointer-Estevez style cone fundamentals, applied to linear-light RGB. */
const LINEAR_RGB_TO_LMS: Matrix = [
  [17.8824, 43.5161, 4.11935],
  [3.45565, 27.1554, 3.86714],
  [0.0299566, 0.184309, 1.46709],
]

const invert = (m: Matrix): Matrix => {
  const [[a, b, c], [d, e, f], [g, h, i]] = m
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
  return [
    [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ]
}

const LMS_TO_LINEAR_RGB = invert(LINEAR_RGB_TO_LMS)

/** Rebuilds the missing long-wave cone response from the medium and short ones. */
const PROTANOPIA: Matrix = [
  [0, 2.02344, -2.52581],
  [0, 1, 0],
  [0, 0, 1],
]

/** Rebuilds the missing medium-wave cone response from the long and short ones. */
const DEUTERANOPIA: Matrix = [
  [1, 0, 0],
  [0.494207, 0, 1.24827],
  [0, 0, 1],
]

const simulate = (collapse: Matrix, hex: string): string => {
  const lms = apply(LINEAR_RGB_TO_LMS, toLinear(hexToRgb(hex)))
  return rgbToHex(toSrgb(apply(LMS_TO_LINEAR_RGB, apply(collapse, lms))))
}

/** How a colour reads with no functioning medium-wave cone. The commonest form. */
export const deuteranope = (hex: string): string => simulate(DEUTERANOPIA, hex)

/** How a colour reads with no functioning long-wave cone. */
export const protanope = (hex: string): string => simulate(PROTANOPIA, hex)

/** WCAG relative luminance. */
export const luminance = (hex: string): number => {
  const [r, g, b] = toLinear(hexToRgb(hex))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio, 1 (identical) to 21 (black on white). */
export const contrastRatio = (a: string, b: string): number => {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** The opaque colour that results from painting `fg` at `alpha` over `bg`. */
export const compositeOver = (fg: string, bg: string, alpha: number): string => {
  const f = hexToRgb(fg)
  const b = hexToRgb(bg)
  return rgbToHex([
    f[0] * alpha + b[0] * (1 - alpha),
    f[1] * alpha + b[1] * (1 - alpha),
    f[2] * alpha + b[2] * (1 - alpha),
  ])
}
