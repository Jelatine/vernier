import { describe, expect, it } from 'vitest'
import { lowerBound, m4, prepareLine, rawSlice, upperBound, visibleRange } from '../src/renderer/src/plot/decimate'

function rng(seed: number): () => number {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 2 ** 32
  }
}

describe('binary search', () => {
  const xs = new Float64Array([0, 1, 1, 1, 2, 5, 9])
  it('finds bounds', () => {
    expect(lowerBound(xs, 1)).toBe(1)
    expect(upperBound(xs, 1)).toBe(4)
    expect(lowerBound(xs, -1)).toBe(0)
    expect(lowerBound(xs, 10)).toBe(7)
    expect(lowerBound(xs, 3)).toBe(5)
  })
  it('widens the visible range by one sample each side', () => {
    expect(visibleRange(xs, 1.5, 6)).toEqual([3, 7])
    expect(visibleRange(xs, -5, 100)).toEqual([0, 7])
    expect(visibleRange(xs, 20, 30)).toEqual([6, 7])
  })
})

describe('m4', () => {
  const n = 100_000
  const r = rng(7)
  const xs = new Float64Array(n)
  const y1 = new Float64Array(n)
  const y2 = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    xs[i] = i * 0.01
    y1[i] = Math.sin(i / 500) + (r() - 0.5) * 0.3
    y2[i] = r() < 0.001 ? 50 : r()
  }

  it('preserves the exact min and max of every pixel column for every series', () => {
    const xMin = 100
    const xMax = 700
    const buckets = 300
    const out = m4(xs, [y1, y2], ...visibleRange(xs, xMin, xMax), xMin, xMax, buckets)
    expect(out.ys[0]!.length).toBe(out.x.length)
    expect(out.ys[1]!.length).toBe(out.x.length)
    // shared X is non-decreasing
    for (let i = 1; i < out.x.length; i++) expect(out.x[i]).toBeGreaterThanOrEqual(out.x[i - 1]!)
    expect(out.x.length).toBeLessThanOrEqual(buckets * 4 + 2)

    for (const [s, y] of [y1, y2].entries()) {
      const k = buckets / (xMax - xMin)
      const trueMin = new Array(buckets).fill(Infinity)
      const trueMax = new Array(buckets).fill(-Infinity)
      for (let i = 0; i < n; i++) {
        if (xs[i]! < xMin || xs[i]! > xMax) continue
        const b = Math.min(buckets - 1, Math.floor((xs[i]! - xMin) * k))
        trueMin[b] = Math.min(trueMin[b], y[i]!)
        trueMax[b] = Math.max(trueMax[b], y[i]!)
      }
      const gotMin = new Array(buckets).fill(Infinity)
      const gotMax = new Array(buckets).fill(-Infinity)
      out.x.forEach((x, i) => {
        if (x < xMin || x > xMax) return
        const b = Math.min(buckets - 1, Math.floor((x - xMin) * k))
        const v = out.ys[s]![i]
        if (v == null) return
        gotMin[b] = Math.min(gotMin[b], v)
        gotMax[b] = Math.max(gotMax[b], v)
      })
      expect(gotMin).toEqual(trueMin)
      expect(gotMax).toEqual(trueMax)
    }
  })

  it('turns NaN into gaps and all-NaN columns into nulls', () => {
    const x = new Float64Array(40).map((_, i) => i)
    const y = new Float64Array(40).map((_, i) => (i >= 10 && i < 30 ? NaN : i))
    const out = m4(x, [y], 0, 40, 0, 40, 4)
    const nullAt = out.x.map((xx, i) => [xx, out.ys[0]![i]]).filter(([, v]) => v == null)
    expect(nullAt.length).toBeGreaterThan(0)
    for (const [xx] of nullAt) expect(xx! >= 10 && xx! < 30).toBe(true)
    expect(rawSlice(x, [y], 9, 11).ys[0]).toEqual([9, null])
  })

  it('draws raw samples when zoomed in and M4 when zoomed out', () => {
    const zoomedIn = prepareLine(xs, [y1], 10, 12, 1000, 'full')
    expect(zoomedIn.mode).toBe('raw')
    expect(zoomedIn.x.length).toBe(zoomedIn.visible)
    const zoomedOut = prepareLine(xs, [y1], 0, 1000, 1000, 'full')
    expect(zoomedOut.mode).toBe('m4')
    const coarse = prepareLine(xs, [y1], 0, 1000, 1000, 'coarse')
    expect(coarse.x.length).toBeLessThan(zoomedOut.x.length)
  })
})
