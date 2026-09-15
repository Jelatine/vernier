/**
 * Rendering-only downsampling. Output of this module is only ever handed to the renderer;
 * nearest-point lookup and datatips always go back to the raw arrays (see nearest.ts).
 */

/** First index with xs[i] >= v. xs must be sorted ascending (finite values only). */
export function lowerBound(xs: ArrayLike<number>, v: number, lo = 0, hi = xs.length): number {
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (xs[mid]! < v) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** First index with xs[i] > v. */
export function upperBound(xs: ArrayLike<number>, v: number, lo = 0, hi = xs.length): number {
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (xs[mid]! <= v) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Index range [i0, i1) covering [xMin, xMax], widened by one sample on each side so line
 * segments crossing the plot edges are still drawn.
 */
export function visibleRange(xs: ArrayLike<number>, xMin: number, xMax: number): [number, number] {
  const i0 = Math.max(0, lowerBound(xs, xMin) - 1)
  const i1 = Math.min(xs.length, upperBound(xs, xMax) + 1)
  return [i0, Math.max(i0, i1)]
}

export interface RenderData {
  x: number[]
  ys: (number | null)[][]
}

function slot(v: number): number | null {
  return Number.isNaN(v) ? null : v
}

/** Copy [i0, i1) as-is (used when the visible slice is small enough to draw verbatim). */
export function rawSlice(xs: Float64Array, ys: Float64Array[], i0: number, i1: number): RenderData {
  const n = i1 - i0
  const x = new Array<number>(n)
  for (let i = 0; i < n; i++) x[i] = xs[i0 + i]!
  const outYs = ys.map((y) => {
    const o = new Array<number | null>(n)
    for (let i = 0; i < n; i++) o[i] = slot(y[i0 + i]!)
    return o
  })
  return { x, ys: outYs }
}

/**
 * M4 decimation (first / min / max / last per pixel column) over [i0, i1) with a shared
 * X output across all series, which uPlot requires. Because the bucket boundaries come from
 * the shared, sorted X array, every series has the same number of samples in each bucket,
 * so each bucket emits the same number of slots for every series.
 *
 * At one bucket per device pixel the result is visually identical to drawing every point.
 */
export function m4(
  xs: Float64Array,
  ys: Float64Array[],
  i0: number,
  i1: number,
  xMin: number,
  xMax: number,
  buckets: number
): RenderData {
  const x: number[] = []
  const outYs: (number | null)[][] = ys.map(() => [])
  const nb = Math.max(1, Math.floor(buckets))
  const k = nb / (xMax - xMin)

  let i = i0
  while (i < i1) {
    const xi = xs[i]!
    // Samples outside the visible window (the one-sample margin) pass through individually.
    if (xi < xMin || xi > xMax) {
      x.push(xi)
      for (let s = 0; s < ys.length; s++) outYs[s]!.push(slot(ys[s]![i]!))
      i++
      continue
    }
    const b = Math.min(nb - 1, Math.floor((xi - xMin) * k))
    let j = i + 1
    while (j < i1) {
      const xj = xs[j]!
      if (xj > xMax || Math.min(nb - 1, Math.floor((xj - xMin) * k)) !== b) break
      j++
    }
    const count = j - i
    if (count <= 4) {
      for (let t = i; t < j; t++) {
        x.push(xs[t]!)
        for (let s = 0; s < ys.length; s++) outYs[s]!.push(slot(ys[s]![t]!))
      }
    } else {
      // Four shared X slots: first, first, last, last. The two middle slots carry the
      // extremes in the order they occur, so the stroke covers the full min..max column.
      const xa = xs[i]!
      const xb = xs[j - 1]!
      x.push(xa, xa, xb, xb)
      for (let s = 0; s < ys.length; s++) {
        const y = ys[s]!
        let mn = Infinity
        let mx = -Infinity
        let iMn = -1
        let iMx = -1
        for (let t = i; t < j; t++) {
          const v = y[t]!
          if (v < mn) {
            mn = v
            iMn = t
          }
          if (v > mx) {
            mx = v
            iMx = t
          }
        }
        const o = outYs[s]!
        if (iMn < 0) {
          o.push(null, null, null, null)
          continue
        }
        const first = firstFinite(y, i, j)
        const last = lastFinite(y, i, j)
        const [e1, e2] = iMn <= iMx ? [mn, mx] : [mx, mn]
        o.push(first, e1, e2, last)
      }
    }
    i = j
  }
  return { x, ys: outYs }
}

function firstFinite(y: Float64Array, i: number, j: number): number {
  for (let t = i; t < j; t++) if (!Number.isNaN(y[t]!)) return y[t]!
  return NaN
}

function lastFinite(y: Float64Array, i: number, j: number): number {
  for (let t = j - 1; t >= i; t--) if (!Number.isNaN(y[t]!)) return y[t]!
  return NaN
}

export type RenderPhase = 'coarse' | 'full'

/**
 * Pick the representation for one frame. "full" is pixel-exact: raw samples when there are
 * few enough, otherwise M4 at one bucket per device pixel. "coarse" is used while the user
 * is still dragging/zooming: M4 at a quarter of that resolution.
 */
export function prepareLine(
  xs: Float64Array,
  ys: Float64Array[],
  xMin: number,
  xMax: number,
  devicePxWidth: number,
  phase: RenderPhase
): RenderData & { visible: number; mode: 'raw' | 'm4' } {
  const [i0, i1] = visibleRange(xs, xMin, xMax)
  const visible = i1 - i0
  const buckets = phase === 'full' ? devicePxWidth : Math.max(64, devicePxWidth / 4)
  if (visible <= buckets * (phase === 'full' ? 4 : 2)) {
    return { ...rawSlice(xs, ys, i0, i1), visible, mode: 'raw' }
  }
  return { ...m4(xs, ys, i0, i1, xMin, xMax, buckets), visible, mode: 'm4' }
}
