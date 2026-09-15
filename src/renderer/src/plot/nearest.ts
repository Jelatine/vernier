import { lowerBound } from './decimate'
import type { Scale } from './scale'

export interface Hit {
  index: number
  distPx: number
}

/**
 * Nearest raw sample (in screen pixels) for a series whose X is sorted ascending.
 * Binary-searches the cursor's X, then walks outward in both directions, stopping each
 * side as soon as the horizontal pixel distance alone exceeds the best hit so far.
 */
export function nearestSorted(
  xs: Float64Array,
  ys: Float64Array,
  scale: Scale,
  px: number,
  py: number,
  maxDistPx = Infinity
): Hit | null {
  const n = xs.length
  if (n === 0) return null
  const start = lowerBound(xs, scale.pxToX(px))
  let best = maxDistPx
  let bestIdx = -1
  const kx = scale.kx

  for (let i = start - 1; i >= 0; i--) {
    const dx = (xs[i]! - scale.xMin) * kx - px
    if (-dx >= best) break
    const y = ys[i]!
    if (Number.isNaN(y)) continue
    const d = Math.hypot(dx, scale.yToPx(y) - py)
    if (d < best) {
      best = d
      bestIdx = i
    }
  }
  for (let i = start; i < n; i++) {
    const dx = (xs[i]! - scale.xMin) * kx - px
    if (dx >= best) break
    const y = ys[i]!
    if (Number.isNaN(y)) continue
    const d = Math.hypot(dx, scale.yToPx(y) - py)
    if (d < best) {
      best = d
      bestIdx = i
    }
  }
  return bestIdx < 0 ? null : { index: bestIdx, distPx: best }
}

/**
 * Nearest raw sample by X only (ignoring Y distance) — the fallback used for hover when the
 * pointer is far from every curve, so the readout still tracks the pointer like MATLAB's.
 */
export function nearestByX(xs: Float64Array, ys: Float64Array, x: number): number {
  const n = xs.length
  const i = lowerBound(xs, x)
  let l = i - 1
  let r = i
  while (l >= 0 && Number.isNaN(ys[l]!)) l--
  while (r < n && Number.isNaN(ys[r]!)) r++
  if (l < 0) return r < n ? r : -1
  if (r >= n) return l
  return x - xs[l]! <= xs[r]! - x ? l : r
}

/**
 * Uniform grid over data space for unsorted/scatter data. Built once per series; queries
 * search rings of cells outward from the cursor and stop once a whole ring is farther
 * (in pixels, at the current zoom) than the best hit.
 */
export class GridIndex {
  readonly nx: number
  readonly ny: number
  private readonly x0: number
  private readonly y0: number
  private readonly cw: number
  private readonly ch: number
  private readonly cellStart: Uint32Array
  private readonly items: Uint32Array

  constructor(
    private readonly xs: Float64Array,
    private readonly ys: Float64Array
  ) {
    const n = xs.length
    let xMin = Infinity
    let xMax = -Infinity
    let yMin = Infinity
    let yMax = -Infinity
    let valid = 0
    for (let i = 0; i < n; i++) {
      const x = xs[i]!
      const y = ys[i]!
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      valid++
      if (x < xMin) xMin = x
      if (x > xMax) xMax = x
      if (y < yMin) yMin = y
      if (y > yMax) yMax = y
    }
    const side = Math.max(1, Math.min(2048, Math.ceil(Math.sqrt(valid / 4))))
    this.nx = side
    this.ny = side
    this.x0 = valid ? xMin : 0
    this.y0 = valid ? yMin : 0
    this.cw = valid && xMax > xMin ? (xMax - xMin) / side : 1
    this.ch = valid && yMax > yMin ? (yMax - yMin) / side : 1

    const cells = this.nx * this.ny
    const counts = new Uint32Array(cells + 1)
    const cellOf = new Int32Array(n)
    for (let i = 0; i < n; i++) {
      const c = this.cellFor(xs[i]!, ys[i]!)
      cellOf[i] = c
      if (c >= 0) counts[c + 1]!++
    }
    for (let c = 0; c < cells; c++) counts[c + 1]! += counts[c]!
    this.cellStart = counts
    this.items = new Uint32Array(valid)
    const fill = counts.slice(0, cells)
    for (let i = 0; i < n; i++) {
      const c = cellOf[i]!
      if (c >= 0) this.items[fill[c]!++] = i
    }
  }

  private cellFor(x: number, y: number): number {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return -1
    const cx = Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.x0) / this.cw)))
    const cy = Math.min(this.ny - 1, Math.max(0, Math.floor((y - this.y0) / this.ch)))
    return cy * this.nx + cx
  }

  nearest(scale: Scale, px: number, py: number, maxDistPx = Infinity): Hit | null {
    if (this.items.length === 0) return null
    const [dxv, dyv] = scale.pxToData(px, py)
    const ccx = Math.min(this.nx - 1, Math.max(0, Math.floor((dxv - this.x0) / this.cw)))
    const ccy = Math.min(this.ny - 1, Math.max(0, Math.floor((dyv - this.y0) / this.ch)))
    let best = maxDistPx
    let bestIdx = -1
    const maxR = Math.max(this.nx, this.ny)

    for (let r = 0; r <= maxR; r++) {
      let anyCloser = false
      const yA = ccy - r
      const yB = ccy + r
      for (let cy = Math.max(0, yA); cy <= Math.min(this.ny - 1, yB); cy++) {
        const edgeRow = cy === yA || cy === yB
        const step = edgeRow ? 1 : 2 * r
        for (let cx = ccx - r; cx <= ccx + r; cx += step || 1) {
          if (cx < 0 || cx >= this.nx) continue
          if (this.cellDistPx(scale, cx, cy, px, py) >= best) continue
          anyCloser = true
          const c = cy * this.nx + cx
          for (let k = this.cellStart[c]!; k < this.cellStart[c + 1]!; k++) {
            const i = this.items[k]!
            const d = Math.hypot(scale.xToPx(this.xs[i]!) - px, scale.yToPx(this.ys[i]!) - py)
            if (d < best) {
              best = d
              bestIdx = i
            }
          }
        }
      }
      if (!anyCloser) break
    }
    return bestIdx < 0 ? null : { index: bestIdx, distPx: best }
  }

  /** Pixel distance from the cursor to the closest point of a cell's rectangle. */
  private cellDistPx(scale: Scale, cx: number, cy: number, px: number, py: number): number {
    const l = scale.xToPx(this.x0 + cx * this.cw)
    const r = scale.xToPx(this.x0 + (cx + 1) * this.cw)
    const t = scale.yToPx(this.y0 + (cy + 1) * this.ch)
    const b = scale.yToPx(this.y0 + cy * this.ch)
    // Edge cells are clamped catch-alls for points on the boundary; treat them as unbounded outward.
    const left = cx === 0 ? -Infinity : l
    const right = cx === this.nx - 1 ? Infinity : r
    const top = cy === this.ny - 1 ? -Infinity : t
    const bottom = cy === 0 ? Infinity : b
    const dx = px < left ? left - px : px > right ? px - right : 0
    const dy = py < top ? top - py : py > bottom ? py - bottom : 0
    return Math.hypot(dx, dy)
  }
}
