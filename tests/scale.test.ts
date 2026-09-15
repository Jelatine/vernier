import { describe, expect, it } from 'vitest'
import { Scale, padExtent } from '../src/renderer/src/plot/scale'

const s = new Scale(-10, 30, 5, 105, 800, 400)

describe('Scale', () => {
  it('maps data to px and back', () => {
    expect(s.xToPx(-10)).toBe(0)
    expect(s.xToPx(30)).toBe(800)
    expect(s.yToPx(5)).toBe(400)
    expect(s.yToPx(105)).toBe(0)
    for (const [px, py] of [
      [0, 0],
      [123.4, 321.9],
      [800, 400]
    ] as const) {
      const [x, y] = s.pxToData(px, py)
      const [px2, py2] = s.dataToPx(x, y)
      expect(px2).toBeCloseTo(px, 9)
      expect(py2).toBeCloseTo(py, 9)
    }
  })

  it('wheel zoom keeps the data point under the cursor fixed', () => {
    const px = 613
    const py = 87
    const before = s.pxToData(px, py)
    for (const factor of [0.5, 0.9, 1.25, 3]) {
      const z = s.zoomAt(px, py, factor)
      const after = z.pxToData(px, py)
      expect(after[0]).toBeCloseTo(before[0], 9)
      expect(after[1]).toBeCloseTo(before[1], 9)
      expect(z.xMax - z.xMin).toBeCloseTo((s.xMax - s.xMin) * factor, 9)
    }
  })

  it('stays anchored across many successive zoom steps', () => {
    let z = s
    const px = 200
    const py = 300
    const anchor = s.pxToData(px, py)
    for (let i = 0; i < 200; i++) z = z.zoomAt(px, py, i % 3 === 0 ? 1.1 : 0.9)
    const [x, y] = z.pxToData(px, py)
    expect(x).toBeCloseTo(anchor[0], 6)
    expect(y).toBeCloseTo(anchor[1], 6)
  })

  it('restricts zoom to a single axis', () => {
    const zx = s.zoomAt(100, 100, 0.5, 'x')
    expect([zx.yMin, zx.yMax]).toEqual([s.yMin, s.yMax])
    expect(zx.xMax - zx.xMin).toBeCloseTo(20)
    const zy = s.zoomAt(100, 100, 0.5, 'y')
    expect([zy.xMin, zy.xMax]).toEqual([s.xMin, s.xMax])
    expect(zy.yMax - zy.yMin).toBeCloseTo(50)
  })

  it('refuses to zoom past float precision', () => {
    let z = s
    for (let i = 0; i < 2000; i++) z = z.zoomAt(400, 200, 0.5)
    expect(z.xMax).toBeGreaterThan(z.xMin)
    expect(Number.isFinite(z.kx)).toBe(true)
  })

  it('pans so content follows the pointer', () => {
    const p = s.pan(80, -40)
    // A point that was at (100,100) is now at (180,60).
    const [x, y] = s.pxToData(100, 100)
    const [px, py] = p.dataToPx(x, y)
    expect(px).toBeCloseTo(180)
    expect(py).toBeCloseTo(60)
  })

  it('zooms to a pixel rectangle regardless of drag direction', () => {
    const a = s.zoomToPxRect(200, 300, 400, 100)
    const b = s.zoomToPxRect(400, 100, 200, 300)
    expect(a.bounds).toEqual(b.bounds)
    expect(a.xMin).toBeCloseTo(0)
    expect(a.xMax).toBeCloseTo(10)
    expect(a.yMin).toBeCloseTo(30)
    expect(a.yMax).toBeCloseTo(80)
    const onlyX = s.zoomToPxRect(200, 300, 400, 100, 'x')
    expect([onlyX.yMin, onlyX.yMax]).toEqual([s.yMin, s.yMax])
  })

  it('pads degenerate extents', () => {
    expect(padExtent(3, 3)).toEqual([2.7, 3.3])
    expect(padExtent(0, 0)).toEqual([-1, 1])
    expect(padExtent(NaN, 1)).toEqual([0, 1])
    expect(padExtent(0, 100)).toEqual([-5, 105])
  })
})
