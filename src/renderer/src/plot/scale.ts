/**
 * The single source of truth for data <-> pixel mapping. Every interaction (wheel zoom,
 * box zoom, pan, nearest-point lookup, datatip placement) goes through this class;
 * nothing else in the plot engine does its own coordinate math.
 *
 * Pixel space is CSS px relative to the top-left of the plotting area, y pointing down.
 */
export type Axes = 'xy' | 'x' | 'y'

export interface Bounds {
  xMin: number
  xMax: number
  yMin: number
  yMax: number
}

// Below this relative span, float64 can no longer resolve distinct pixels.
const MIN_REL_SPAN = 1e-12

export class Scale implements Bounds {
  constructor(
    readonly xMin: number,
    readonly xMax: number,
    readonly yMin: number,
    readonly yMax: number,
    readonly width: number,
    readonly height: number
  ) {}

  static fromBounds(b: Bounds, width: number, height: number): Scale {
    return new Scale(b.xMin, b.xMax, b.yMin, b.yMax, width, height)
  }

  get bounds(): Bounds {
    return { xMin: this.xMin, xMax: this.xMax, yMin: this.yMin, yMax: this.yMax }
  }

  /** Pixels per data unit on each axis. */
  get kx(): number {
    return this.width / (this.xMax - this.xMin)
  }
  get ky(): number {
    return this.height / (this.yMax - this.yMin)
  }

  xToPx(x: number): number {
    return (x - this.xMin) * this.kx
  }
  yToPx(y: number): number {
    return this.height - (y - this.yMin) * this.ky
  }
  pxToX(px: number): number {
    return this.xMin + px / this.kx
  }
  pxToY(py: number): number {
    return this.yMin + (this.height - py) / this.ky
  }

  dataToPx(x: number, y: number): [number, number] {
    return [this.xToPx(x), this.yToPx(y)]
  }
  pxToData(px: number, py: number): [number, number] {
    return [this.pxToX(px), this.pxToY(py)]
  }

  withSize(width: number, height: number): Scale {
    return new Scale(this.xMin, this.xMax, this.yMin, this.yMax, width, height)
  }

  withBounds(b: Partial<Bounds>): Scale {
    return new Scale(b.xMin ?? this.xMin, b.xMax ?? this.xMax, b.yMin ?? this.yMin, b.yMax ?? this.yMax, this.width, this.height)
  }

  /**
   * Zoom around a pixel anchor: the data coordinate under (px, py) is identical before
   * and after. factor < 1 zooms in, > 1 zooms out.
   */
  zoomAt(px: number, py: number, factor: number, axes: Axes = 'xy'): Scale {
    let { xMin, xMax, yMin, yMax } = this
    if (axes !== 'y') {
      const ax = this.pxToX(px)
      ;[xMin, xMax] = zoomSpan(xMin, xMax, ax, factor)
    }
    if (axes !== 'x') {
      const ay = this.pxToY(py)
      ;[yMin, yMax] = zoomSpan(yMin, yMax, ay, factor)
    }
    return new Scale(xMin, xMax, yMin, yMax, this.width, this.height)
  }

  /** Move the view so content follows the pointer by (dxPx, dyPx). */
  pan(dxPx: number, dyPx: number, axes: Axes = 'xy'): Scale {
    const dx = axes === 'y' ? 0 : dxPx / this.kx
    const dy = axes === 'x' ? 0 : dyPx / this.ky
    return new Scale(this.xMin - dx, this.xMax - dx, this.yMin + dy, this.yMax + dy, this.width, this.height)
  }

  /** Zoom to a pixel rectangle; the axes argument keeps the other axis untouched. */
  zoomToPxRect(x0: number, y0: number, x1: number, y1: number, axes: Axes = 'xy'): Scale {
    const b = this.bounds
    if (axes !== 'y') {
      const a = this.pxToX(Math.min(x0, x1))
      const c = this.pxToX(Math.max(x0, x1))
      if (validSpan(a, c)) Object.assign(b, { xMin: a, xMax: c })
    }
    if (axes !== 'x') {
      const a = this.pxToY(Math.max(y0, y1))
      const c = this.pxToY(Math.min(y0, y1))
      if (validSpan(a, c)) Object.assign(b, { yMin: a, yMax: c })
    }
    return this.withBounds(b)
  }

  equals(o: Scale | null | undefined): boolean {
    return (
      !!o &&
      o.xMin === this.xMin &&
      o.xMax === this.xMax &&
      o.yMin === this.yMin &&
      o.yMax === this.yMax &&
      o.width === this.width &&
      o.height === this.height
    )
  }
}

function validSpan(a: number, b: number): boolean {
  return Number.isFinite(a) && Number.isFinite(b) && b - a > MIN_REL_SPAN * Math.max(1, Math.abs(a), Math.abs(b))
}

function zoomSpan(min: number, max: number, anchor: number, factor: number): [number, number] {
  const nMin = anchor - (anchor - min) * factor
  const nMax = anchor + (max - anchor) * factor
  if (!validSpan(nMin, nMax) || !Number.isFinite(nMax - nMin)) return [min, max]
  return [nMin, nMax]
}

/** Nice padded bounds from raw extents; handles empty and degenerate ranges. */
export function padExtent(min: number, max: number, padFrac = 0.05): [number, number] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1]
  if (min === max) {
    const d = min === 0 ? 1 : Math.abs(min) * 0.1
    return [min - d, max + d]
  }
  const pad = (max - min) * padFrac
  return [min - pad, max + pad]
}
