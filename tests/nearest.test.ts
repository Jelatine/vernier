import { describe, expect, it } from 'vitest'
import { GridIndex, nearestByX, nearestSorted } from '../src/renderer/src/plot/nearest'
import { Scale } from '../src/renderer/src/plot/scale'

function rng(seed: number): () => number {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 2 ** 32
  }
}

function brute(xs: Float64Array, ys: Float64Array, s: Scale, px: number, py: number): number {
  let best = Infinity
  let idx = -1
  for (let i = 0; i < xs.length; i++) {
    if (!Number.isFinite(xs[i]!) || !Number.isFinite(ys[i]!)) continue
    const d = Math.hypot(s.xToPx(xs[i]!) - px, s.yToPx(ys[i]!) - py)
    if (d < best) {
      best = d
      idx = i
    }
  }
  return best === Infinity ? -1 : idx
}

function distOf(xs: Float64Array, ys: Float64Array, s: Scale, i: number, px: number, py: number): number {
  return Math.hypot(s.xToPx(xs[i]!) - px, s.yToPx(ys[i]!) - py)
}

describe('nearestSorted', () => {
  const r = rng(42)
  const n = 20_000
  const xs = new Float64Array(n)
  const ys = new Float64Array(n)
  let x = 0
  for (let i = 0; i < n; i++) {
    x += r() * 0.2
    xs[i] = x
    ys[i] = r() < 0.02 ? NaN : Math.sin(x) * 10 + r()
  }

  it('matches brute force at many zoom levels and cursor positions', () => {
    for (let trial = 0; trial < 300; trial++) {
      const c = r() * x
      const span = 10 ** (r() * 4 - 1)
      const s = new Scale(c - span, c + span, -12, 12, 900, 500)
      const px = r() * 900
      const py = r() * 500
      const hit = nearestSorted(xs, ys, s, px, py)!
      const b = brute(xs, ys, s, px, py)
      expect(distOf(xs, ys, s, hit.index, px, py)).toBeCloseTo(distOf(xs, ys, s, b, px, py), 9)
    }
  })

  it('respects the max pixel radius', () => {
    const s = new Scale(0, 10, -12, 12, 900, 500)
    expect(nearestSorted(xs, ys, s, 450, -10_000, 30)).toBeNull()
  })

  it('never returns a NaN sample', () => {
    const y = new Float64Array([1, NaN, NaN, 4])
    const xx = new Float64Array([0, 1, 2, 3])
    const s = new Scale(0, 3, 0, 5, 300, 100)
    const hit = nearestSorted(xx, y, s, s.xToPx(1.4), s.yToPx(2))!
    expect([0, 3]).toContain(hit.index)
    expect(nearestByX(xx, y, 1.4)).toBe(0)
    expect(nearestByX(xx, y, 1.6)).toBe(3)
  })
})

describe('GridIndex', () => {
  const r = rng(3)
  const n = 30_000
  const xs = new Float64Array(n)
  const ys = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    // clustered, anisotropic data with some invalid entries
    const cluster = Math.floor(r() * 4)
    xs[i] = cluster * 1000 + r() * r() * 300
    ys[i] = r() < 0.01 ? NaN : cluster * 0.01 + (r() - 0.5) * 0.004
  }
  const grid = new GridIndex(xs, ys)

  it('matches brute force across zoom levels, including cursors outside the data', () => {
    for (let trial = 0; trial < 400; trial++) {
      const cx = r() * 4500 - 250
      const cy = r() * 0.05 - 0.01
      const sx = 10 ** (r() * 4)
      const sy = 10 ** (r() * 3 - 4)
      const s = new Scale(cx - sx, cx + sx, cy - sy, cy + sy, 800, 600)
      const px = r() * 1200 - 200
      const py = r() * 900 - 150
      const hit = grid.nearest(s, px, py)!
      const b = brute(xs, ys, s, px, py)
      expect(distOf(xs, ys, s, hit.index, px, py)).toBeCloseTo(distOf(xs, ys, s, b, px, py), 6)
    }
  })

  it('handles degenerate inputs', () => {
    const s = new Scale(0, 1, 0, 1, 100, 100)
    expect(new GridIndex(new Float64Array(0), new Float64Array(0)).nearest(s, 1, 1)).toBeNull()
    const one = new GridIndex(new Float64Array([0.5]), new Float64Array([0.5]))
    expect(one.nearest(s, 0, 0)!.index).toBe(0)
    const same = new GridIndex(new Float64Array([2, 2, 2]), new Float64Array([1, 1, 1]))
    expect(same.nearest(s, 0, 0)).not.toBeNull()
  })
})
