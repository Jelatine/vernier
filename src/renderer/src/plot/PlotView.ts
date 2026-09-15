import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { prepareLine, visibleRange, type RenderPhase } from './decimate'
import { formatInt, formatNumber, formatX, type XKind } from './format'
import { GridIndex, nearestByX, nearestSorted } from './nearest'
import { Scale, padExtent, type Axes, type Bounds } from './scale'

export type PlotMode = 'line' | 'scatter'
export type Tool = 'explore' | 'zoom'

export interface PlotSeries {
  id: string
  label: string
  ys: Float64Array
  color: string
}

/** Everything the plot needs, as typed columns sharing one sample index. */
export interface PlotModel {
  x: Float64Array
  /** Original table row of each sample. */
  row: Float64Array
  sorted: boolean
  xLabel: string
  xKind: XKind
  series: PlotSeries[]
}

/**
 * A pinned datatip is a reference into the raw data, never a screen or data coordinate —
 * so it stays glued to its sample through any zoom/pan and can be re-read exactly.
 */
export interface DataTip {
  id: number
  seriesId: string
  index: number
  createdAt: number
}

export interface TipInfo {
  id: number
  seriesId: string
  label: string
  color: string
  index: number
  row: number
  x: number
  y: number
  xText: string
  yText: string
  selected: boolean
}

export interface RenderStats {
  phase: RenderPhase
  mode: 'raw' | 'm4' | 'raster' | 'polyline'
  total: number
  visible: number
  drawn: number
  ms: number
}

export interface PlotViewHandlers {
  onViewChange?: (view: PlotView, scale: Scale, interactive: boolean) => void
  onTipsChange?: (view: PlotView) => void
  onTipSelect?: (view: PlotView, tip: TipInfo) => void
  onStats?: (view: PlotView, stats: RenderStats) => void
  onActivate?: (view: PlotView) => void
}

interface Hit {
  s: number
  index: number
  distPx: number
}

type Gesture =
  | { kind: 'pan'; pointerId: number; x0: number; y0: number; start: Scale; moved: boolean; button: number }
  | { kind: 'box'; pointerId: number; x0: number; y0: number; x1: number; y1: number; moved: boolean; alt: boolean }
  | { kind: 'tip'; pointerId: number; tipId: number }

const HOVER_RADIUS = 24
const CLICK_RADIUS = 40
const DRAG_THRESHOLD = 4
const IDLE_MS = 100
const AXIS_ONLY_PX = 12

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

export class PlotView {
  readonly el: HTMLDivElement
  private readonly legendEl: HTMLDivElement
  private readonly plotEl: HTMLDivElement
  private u: uPlot | null = null
  private model: PlotModel | null = null
  private mode: PlotMode = 'line'
  private tool: Tool = 'explore'
  private scale = new Scale(0, 1, 0, 1, 1, 1)
  private home: Bounds = { xMin: 0, xMax: 1, yMin: 0, yMax: 1 }
  private hidden = new Set<string>()
  private tips: DataTip[] = []
  private tipSeq = 0
  private selectedTip: number | null = null
  private hover: Hit | null = null
  private pointer: { px: number; py: number } | null = null
  private grids = new Map<string, GridIndex>()
  private phase: RenderPhase = 'full'
  private frame = 0
  private idle = 0
  private renderT0 = 0
  private pendingStats: Omit<RenderStats, 'ms'> | null = null
  private gesture: Gesture | null = null
  private occ = new Uint8Array(0)
  private readonly tipEls = new Map<number, HTMLDivElement>()
  private hoverEl!: HTMLDivElement
  private boxEl!: HTMLDivElement
  private tipLayer!: HTMLDivElement
  private readonly ro: ResizeObserver
  lastStats: RenderStats | null = null

  constructor(
    parent: HTMLElement,
    private readonly handlers: PlotViewHandlers = {}
  ) {
    this.el = document.createElement('div')
    this.el.className = 'vn-plot'
    this.legendEl = document.createElement('div')
    this.legendEl.className = 'vn-legend'
    this.plotEl = document.createElement('div')
    this.plotEl.className = 'vn-plot-area'
    this.el.append(this.legendEl, this.plotEl)
    parent.append(this.el)
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(this.plotEl)
  }

  // ------------------------------------------------------------------ public API

  setModel(model: PlotModel, mode: PlotMode, opts: { keepX?: boolean; keepTips?: boolean } = {}): void {
    const prevScale = this.u ? this.scale : null
    this.model = model
    this.mode = mode
    this.grids.clear()
    const ids = new Set(model.series.map((s) => s.id))
    this.hidden = new Set([...this.hidden].filter((id) => ids.has(id)))
    this.tips = opts.keepTips ? this.tips.filter((t) => ids.has(t.seriesId) && t.index < model.x.length) : []
    this.hover = null
    this.home = this.computeHome()
    let bounds = this.home
    if (opts.keepX && prevScale) bounds = { ...this.home, xMin: prevScale.xMin, xMax: prevScale.xMax }
    this.scale = Scale.fromBounds(bounds, this.scale.width, this.scale.height)
    this.build()
    this.renderLegend()
    this.handlers.onTipsChange?.(this)
  }

  setMode(mode: PlotMode): void {
    if (mode === this.mode || !this.model) return
    this.mode = mode
    this.home = this.computeHome()
    this.build()
  }

  getMode(): PlotMode {
    return this.mode
  }

  setTool(tool: Tool): void {
    this.tool = tool
    this.el.dataset['tool'] = tool
  }

  getScale(): Scale {
    return this.scale
  }

  reset(): void {
    this.setScale(Scale.fromBounds(this.home, this.scale.width, this.scale.height), false)
  }

  /** Fit Y to the samples inside the current X range (MATLAB "axis tight" on Y). */
  fitY(): void {
    const m = this.model
    if (!m) return
    const s = this.scale
    let mn = Infinity
    let mx = -Infinity
    const [i0, i1] = m.sorted ? visibleRange(m.x, s.xMin, s.xMax) : [0, m.x.length]
    for (const ser of this.visibleSeries()) {
      const ys = ser.ys
      for (let i = i0; i < i1; i++) {
        const x = m.x[i]!
        if (x < s.xMin || x > s.xMax) continue
        const y = ys[i]!
        if (y < mn) mn = y
        if (y > mx) mx = y
      }
    }
    if (mn > mx) return
    const [yMin, yMax] = padExtent(mn, mx)
    this.setScale(s.withBounds({ yMin, yMax }), false)
  }

  setXBounds(xMin: number, xMax: number, interactive: boolean): void {
    this.setScale(this.scale.withBounds({ xMin, xMax }), interactive, false)
  }

  clearTips(): void {
    this.tips = []
    this.selectedTip = null
    this.positionOverlay()
    this.handlers.onTipsChange?.(this)
  }

  removeTip(id: number): void {
    this.tips = this.tips.filter((t) => t.id !== id)
    if (this.selectedTip === id) this.selectedTip = null
    this.positionOverlay()
    this.handlers.onTipsChange?.(this)
  }

  selectTip(id: number | null): void {
    this.selectedTip = id
    this.positionOverlay()
    this.handlers.onTipsChange?.(this)
  }

  tipInfos(): TipInfo[] {
    return this.tips.map((t) => this.tipInfo(t)).filter((t): t is TipInfo => t !== null)
  }

  /** Keyboard shortcuts; returns true when handled. */
  handleKey(e: KeyboardEvent): boolean {
    if (e.metaKey || e.ctrlKey) return false
    const s = this.scale
    switch (e.key) {
      case 'Delete':
      case 'Backspace':
        if (this.selectedTip != null) {
          this.removeTip(this.selectedTip)
          return true
        }
        return false
      case 'Escape':
        if (this.gesture?.kind === 'box') {
          this.gesture = null
          this.boxEl.hidden = true
          return true
        }
        if (this.selectedTip != null) {
          this.selectTip(null)
          return true
        }
        return false
      case 'r':
      case 'R':
      case 'Home':
        this.reset()
        return true
      case 'f':
      case 'F':
        this.fitY()
        return true
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown': {
        const d = e.shiftKey ? 0.5 : 0.1
        const dx = e.key === 'ArrowLeft' ? s.width * d : e.key === 'ArrowRight' ? -s.width * d : 0
        const dy = e.key === 'ArrowUp' ? s.height * d : e.key === 'ArrowDown' ? -s.height * d : 0
        this.setScale(s.pan(dx, dy), true)
        return true
      }
      case '+':
      case '=':
        this.setScale(s.zoomAt(s.width / 2, s.height / 2, 0.8), true)
        return true
      case '-':
        this.setScale(s.zoomAt(s.width / 2, s.height / 2, 1.25), true)
        return true
    }
    return false
  }

  /** PNG of axes, series, legend and pinned datatips. */
  async exportPng(): Promise<Blob | null> {
    const u = this.u
    const m = this.model
    if (!u || !m) return null
    const dpr = u.bbox.width / this.scale.width || window.devicePixelRatio
    const src = u.ctx.canvas
    const legendH = Math.round(28 * dpr)
    const out = document.createElement('canvas')
    out.width = src.width
    out.height = src.height + legendH
    const ctx = out.getContext('2d')!
    ctx.fillStyle = cssVar('--surface-1') || '#fcfcfb'
    ctx.fillRect(0, 0, out.width, out.height)
    ctx.font = `${12 * dpr}px system-ui, -apple-system, "Segoe UI", sans-serif`
    ctx.textBaseline = 'middle'
    let lx = u.bbox.left
    for (const ser of this.visibleSeries()) {
      ctx.fillStyle = ser.color
      ctx.fillRect(lx, legendH / 2 - 1.5 * dpr, 14 * dpr, 3 * dpr)
      ctx.fillStyle = cssVar('--text-secondary') || '#52514e'
      ctx.fillText(ser.label, lx + 20 * dpr, legendH / 2)
      lx += ctx.measureText(ser.label).width + 40 * dpr
    }
    ctx.drawImage(src, 0, legendH)
    for (const info of this.tipInfos()) {
      const [px, py] = this.scale.dataToPx(info.x, info.y)
      if (px < 0 || py < 0 || px > this.scale.width || py > this.scale.height) continue
      const cx = u.bbox.left + px * dpr
      const cy = legendH + u.bbox.top + py * dpr
      const lines = [info.label, `X ${info.xText}`, `Y ${info.yText}`]
      const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 16 * dpr
      const h = (lines.length * 16 + 10) * dpr
      const bx = cx + w + 12 * dpr > out.width ? cx - w - 10 * dpr : cx + 10 * dpr
      const by = cy - h - 10 * dpr < legendH ? cy + 10 * dpr : cy - h - 10 * dpr
      ctx.fillStyle = cssVar('--surface-1') || '#fff'
      ctx.strokeStyle = cssVar('--border-strong') || '#c3c2b7'
      ctx.lineWidth = dpr
      ctx.beginPath()
      ctx.roundRect(bx, by, w, h, 4 * dpr)
      ctx.fill()
      ctx.stroke()
      ctx.fillStyle = cssVar('--text-primary') || '#0b0b0b'
      lines.forEach((l, i) => ctx.fillText(l, bx + 8 * dpr, by + (13 + i * 16) * dpr))
      ctx.beginPath()
      ctx.arc(cx, cy, 4 * dpr, 0, Math.PI * 2)
      ctx.fillStyle = info.color
      ctx.fill()
      ctx.strokeStyle = cssVar('--surface-1') || '#fff'
      ctx.lineWidth = 2 * dpr
      ctx.stroke()
    }
    return new Promise((resolve) => out.toBlob(resolve, 'image/png'))
  }

  refreshTheme(): void {
    if (this.model) this.build()
  }

  destroy(): void {
    this.ro.disconnect()
    cancelAnimationFrame(this.frame)
    clearTimeout(this.idle)
    this.u?.destroy()
    this.u = null
    this.el.remove()
  }

  /** Introspection for tests and the status bar. */
  debugState() {
    const over = this.u?.over.getBoundingClientRect()
    return {
      mode: this.mode,
      tool: this.tool,
      sorted: this.model?.sorted ?? null,
      bounds: this.scale.bounds,
      width: this.scale.width,
      height: this.scale.height,
      over: over ? { left: over.left, top: over.top, width: over.width, height: over.height } : null,
      tips: this.tipInfos().map((t) => ({ ...t, px: this.scale.xToPx(t.x), py: this.scale.yToPx(t.y) })),
      hover: this.hover ? { seriesId: this.model!.series[this.hover.s]!.id, index: this.hover.index } : null,
      stats: this.lastStats,
      series: this.model?.series.map((s) => ({ id: s.id, label: s.label, n: s.ys.length })) ?? []
    }
  }

  // ------------------------------------------------------------------ building

  private build(): void {
    const m = this.model
    if (!m) return
    this.u?.destroy()
    this.tipEls.clear()
    const width = Math.max(50, this.plotEl.clientWidth)
    const height = Math.max(50, this.plotEl.clientHeight)
    const axisStroke = cssVar('--text-muted')
    const grid = cssVar('--grid')
    const baseline = cssVar('--axis')
    const font = '11px system-ui, -apple-system, "Segoe UI", sans-serif'

    const axis = (): uPlot.Axis => ({
      stroke: axisStroke,
      font,
      labelFont: '12px system-ui, -apple-system, "Segoe UI", sans-serif',
      grid: { stroke: grid, width: 1 },
      ticks: { stroke: baseline, width: 1, size: 4 },
      border: { show: true, stroke: baseline, width: 1 }
    })
    const custom = this.usesCustomRenderer()

    const opts: uPlot.Options = {
      width,
      height,
      pxAlign: 0,
      scales: {
        x: { time: m.xKind === 'time', auto: false },
        y: { auto: false }
      },
      series: [
        { label: m.xLabel },
        ...m.series.map((s) => ({
          label: s.label,
          stroke: custom ? 'transparent' : s.color,
          width: 1.5,
          show: !this.hidden.has(s.id),
          points: { show: false },
          spanGaps: false
        }))
      ],
      cursor: { show: false },
      select: { show: false, left: 0, top: 0, width: 0, height: 0 },
      legend: { show: false },
      tzDate: (ts) => uPlot.tzDate(new Date(ts * 1e3), 'Etc/UTC'),
      axes: [
        { ...axis(), label: m.xLabel, labelSize: 22, labelGap: 2, size: 36 },
        {
          ...axis(),
          size: (_self, values) => {
            if (!values || values.length === 0) return 48
            const len = Math.max(...values.map((v) => String(v).length))
            // Integer gutter keeps the plotting area on whole CSS pixels.
            return Math.max(44, Math.ceil(len * 6.6 + 18))
          }
        }
      ],
      hooks: {
        draw: [(u) => this.afterDraw(u)]
      }
    }

    const u = new uPlot(opts, [[], ...m.series.map(() => [])], this.plotEl)
    this.u = u
    this.scale = this.scale.withSize(...plotCssSize(u))
    this.installOverlay(u)
    this.render('full')
  }

  private usesCustomRenderer(): boolean {
    return this.mode === 'scatter' || !this.model!.sorted
  }

  private resize(): void {
    const u = this.u
    if (!u) return
    const width = Math.max(50, this.plotEl.clientWidth)
    const height = Math.max(50, this.plotEl.clientHeight)
    if (width === u.width && height === u.height) return
    u.setSize({ width, height })
    this.scale = this.scale.withSize(...plotCssSize(u))
    this.render('full')
  }

  private computeHome(): Bounds {
    const m = this.model!
    let xMin = Infinity
    let xMax = -Infinity
    if (m.sorted && m.x.length) {
      xMin = m.x[0]!
      xMax = m.x[m.x.length - 1]!
    } else {
      for (const v of m.x) {
        if (v < xMin) xMin = v
        if (v > xMax) xMax = v
      }
    }
    let yMin = Infinity
    let yMax = -Infinity
    for (const s of this.visibleSeries()) {
      for (const v of s.ys) {
        if (v < yMin) yMin = v
        if (v > yMax) yMax = v
      }
    }
    const tightX = this.mode === 'line' && m.sorted
    const [x0, x1] = tightX && xMax > xMin ? [xMin, xMax] : padExtent(xMin, xMax, 0.03)
    const [y0, y1] = padExtent(yMin, yMax)
    return { xMin: x0, xMax: x1, yMin: y0, yMax: y1 }
  }

  private visibleSeries(): PlotSeries[] {
    return this.model ? this.model.series.filter((s) => !this.hidden.has(s.id)) : []
  }

  // ------------------------------------------------------------------ rendering

  private setScale(next: Scale, interactive: boolean, notify = true): void {
    if (next.equals(this.scale)) return
    this.scale = next
    this.requestRender(interactive)
    if (notify) this.handlers.onViewChange?.(this, next, interactive)
  }

  /**
   * Two-phase redraw: while the user is still interacting, draw a coarse decimation on the
   * next animation frame; once input has been quiet for IDLE_MS, draw at full precision.
   */
  private requestRender(interactive: boolean): void {
    clearTimeout(this.idle)
    if (!interactive) {
      cancelAnimationFrame(this.frame)
      this.frame = 0
      this.render('full')
      return
    }
    if (!this.frame) {
      this.frame = requestAnimationFrame(() => {
        this.frame = 0
        this.render('coarse')
      })
    }
    this.idle = window.setTimeout(() => {
      this.idle = 0
      cancelAnimationFrame(this.frame)
      this.frame = 0
      this.render('full')
    }, IDLE_MS)
  }

  private render(phase: RenderPhase): void {
    const u = this.u
    const m = this.model
    if (!u || !m) return
    this.phase = phase
    this.renderT0 = performance.now()
    const s = this.scale
    let data: uPlot.AlignedData
    if (!this.usesCustomRenderer()) {
      const r = prepareLine(m.x, m.series.map((ser) => ser.ys), s.xMin, s.xMax, u.bbox.width, phase)
      data = [r.x, ...r.ys]
      this.pendingStats = { phase, mode: r.mode, total: m.x.length, visible: r.visible, drawn: r.x.length }
    } else {
      data = [[s.xMin, s.xMax], ...m.series.map(() => [null, null])]
      this.pendingStats = { phase, mode: this.mode === 'scatter' ? 'raster' : 'polyline', total: m.x.length, visible: m.x.length, drawn: 0 }
    }
    // batch() commits synchronously; the draw hook below runs before this returns.
    u.batch(() => {
      u.setData(data, false)
      u.setScale('x', { min: s.xMin, max: s.xMax })
      u.setScale('y', { min: s.yMin, max: s.yMax })
    })
    if (this.pointer && !this.gesture) this.updateHover(this.pointer.px, this.pointer.py)
  }

  private afterDraw(u: uPlot): void {
    if (this.usesCustomRenderer() && this.pendingStats) this.pendingStats.drawn = this.drawCustom(u)
    this.positionOverlay()
    if (this.pendingStats) {
      this.lastStats = { ...this.pendingStats, ms: performance.now() - this.renderT0 }
      this.handlers.onStats?.(this, this.lastStats)
    }
  }

  /** Scatter raster and unsorted-X polylines, drawn straight onto uPlot's canvas. */
  private drawCustom(u: uPlot): number {
    const m = this.model!
    const s = this.scale
    const ctx = u.ctx
    const { left, top, width, height } = u.bbox
    const dpr = width / s.width
    const kx = width / (s.xMax - s.xMin)
    const ky = height / (s.yMax - s.yMin)
    const xs = m.x
    const n = xs.length
    let drawn = 0
    ctx.save()
    ctx.beginPath()
    ctx.rect(left, top, width, height)
    ctx.clip()

    for (const ser of this.visibleSeries()) {
      const ys = ser.ys
      if (this.mode === 'scatter') {
        const size = Math.max(2, Math.round(3 * dpr))
        const half = size / 2
        // Occupancy grid at marker resolution: a second marker in the same cell is invisible.
        const cell = this.phase === 'full' ? Math.max(1, Math.round(dpr)) : Math.max(2, Math.round(3 * dpr))
        const cw = Math.ceil(width / cell) + 1
        const cells = cw * (Math.ceil(height / cell) + 1)
        if (this.occ.length < cells) this.occ = new Uint8Array(cells)
        else this.occ.fill(0, 0, cells)
        const occ = this.occ
        ctx.fillStyle = ser.color
        ctx.beginPath()
        for (let i = 0; i < n; i++) {
          const y = ys[i]!
          if (y !== y) continue
          const px = (xs[i]! - s.xMin) * kx
          const py = height - (y - s.yMin) * ky
          if (px < 0 || py < 0 || px >= width || py >= height) continue
          const c = ((py / cell) | 0) * cw + ((px / cell) | 0)
          if (occ[c]) continue
          occ[c] = 1
          ctx.rect(left + px - half, top + py - half, size, size)
          drawn++
        }
        ctx.fill()
      } else {
        // Row-order polyline (MATLAB plot(x, y) semantics for non-monotonic X).
        const q = this.phase === 'full' ? 0.75 : 3
        ctx.strokeStyle = ser.color
        ctx.lineWidth = 1.5 * dpr
        ctx.lineJoin = 'round'
        ctx.beginPath()
        let pen = false
        let lx = 0
        let ly = 0
        for (let i = 0; i < n; i++) {
          const y = ys[i]!
          if (y !== y) {
            pen = false
            continue
          }
          const px = Math.max(-1e6, Math.min(1e6, left + (xs[i]! - s.xMin) * kx))
          const py = Math.max(-1e6, Math.min(1e6, top + height - (y - s.yMin) * ky))
          if (!pen) {
            ctx.moveTo(px, py)
            pen = true
          } else if (Math.abs(px - lx) < q && Math.abs(py - ly) < q) {
            continue
          } else {
            ctx.lineTo(px, py)
          }
          lx = px
          ly = py
          drawn++
        }
        ctx.stroke()
      }
    }
    ctx.restore()
    return drawn
  }

  // ------------------------------------------------------------------ hit testing

  private gridFor(sIdx: number): GridIndex {
    const ser = this.model!.series[sIdx]!
    let g = this.grids.get(ser.id)
    if (!g) {
      g = new GridIndex(this.model!.x, ser.ys)
      this.grids.set(ser.id, g)
    }
    return g
  }

  /** Nearest raw sample across visible series — always against the original arrays. */
  private pick(px: number, py: number, radius: number): Hit | null {
    const m = this.model
    if (!m) return null
    let best: Hit | null = null
    m.series.forEach((ser, sIdx) => {
      if (this.hidden.has(ser.id)) return
      const limit = best ? best.distPx : radius
      const hit = m.sorted ? nearestSorted(m.x, ser.ys, this.scale, px, py, limit) : this.gridFor(sIdx).nearest(this.scale, px, py, limit)
      if (hit && (!best || hit.distPx < best.distPx)) best = { s: sIdx, index: hit.index, distPx: hit.distPx }
    })
    return best
  }

  private tipInfo(t: DataTip): TipInfo | null {
    const m = this.model
    const ser = m?.series.find((s) => s.id === t.seriesId)
    if (!m || !ser) return null
    const x = m.x[t.index]!
    const y = ser.ys[t.index]!
    return {
      id: t.id,
      seriesId: ser.id,
      label: ser.label,
      color: ser.color,
      index: t.index,
      row: m.row[t.index]!,
      x,
      y,
      xText: formatX(x, m.xKind),
      yText: formatNumber(y),
      selected: t.id === this.selectedTip
    }
  }

  // ------------------------------------------------------------------ overlay & interaction

  private installOverlay(u: uPlot): void {
    const over = u.over
    over.classList.add('vn-over')
    this.tipLayer = document.createElement('div')
    this.tipLayer.className = 'vn-tip-layer'
    this.hoverEl = document.createElement('div')
    this.hoverEl.className = 'vn-hover'
    this.hoverEl.hidden = true
    this.hoverEl.innerHTML = '<div class="vn-dot"></div><div class="vn-hover-label"></div>'
    this.boxEl = document.createElement('div')
    this.boxEl.className = 'vn-box'
    this.boxEl.hidden = true
    over.append(this.boxEl, this.hoverEl, this.tipLayer)

    over.addEventListener('pointerdown', (e) => this.onPointerDown(e))
    over.addEventListener('pointermove', (e) => this.onPointerMove(e))
    over.addEventListener('pointerup', (e) => this.onPointerUp(e))
    over.addEventListener('pointercancel', () => this.cancelGesture())
    over.addEventListener('pointerleave', () => {
      if (this.gesture) return
      this.pointer = null
      this.hover = null
      this.hoverEl.hidden = true
      this.updateLegendValues(null)
    })
    over.addEventListener('dblclick', (e) => this.onDblClick(e))
    over.addEventListener('contextmenu', (e) => {
      const tipEl = (e.target as HTMLElement).closest<HTMLElement>('.vn-tip')
      if (tipEl) {
        e.preventDefault()
        this.removeTip(Number(tipEl.dataset['tip']))
      }
    })
    // Wheel on the whole root so the axis gutters work too.
    u.root.addEventListener('wheel', (e) => this.onWheel(e), { passive: false })
  }

  private local(e: MouseEvent): [number, number] {
    const r = this.u!.over.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top]
  }

  private onPointerDown(e: PointerEvent): void {
    this.handlers.onActivate?.(this)
    const target = e.target as HTMLElement
    const over = this.u!.over
    const tipEl = target.closest<HTMLElement>('.vn-tip')
    if (tipEl && e.button === 0) {
      const id = Number(tipEl.dataset['tip'])
      this.selectTip(id)
      const info = this.tipInfos().find((t) => t.id === id)
      if (info) this.handlers.onTipSelect?.(this, info)
      if (target.closest('.vn-dot')) {
        this.gesture = { kind: 'tip', pointerId: e.pointerId, tipId: id }
        over.setPointerCapture(e.pointerId)
      }
      e.preventDefault()
      return
    }
    const [px, py] = this.local(e)
    if (e.button === 1 || (e.button === 0 && this.tool === 'explore' && !e.shiftKey)) {
      this.gesture = { kind: 'pan', pointerId: e.pointerId, x0: px, y0: py, start: this.scale, moved: false, button: e.button }
    } else if (e.button === 0) {
      this.gesture = { kind: 'box', pointerId: e.pointerId, x0: px, y0: py, x1: px, y1: py, moved: false, alt: e.altKey }
    } else {
      return
    }
    over.setPointerCapture(e.pointerId)
    e.preventDefault()
  }

  private onPointerMove(e: PointerEvent): void {
    const [px, py] = this.local(e)
    this.pointer = { px, py }
    const g = this.gesture
    if (!g) {
      this.updateHover(px, py)
      return
    }
    if (g.pointerId !== e.pointerId) return
    if (g.kind === 'pan') {
      const dx = px - g.x0
      const dy = py - g.y0
      if (!g.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
      g.moved = true
      this.el.classList.add('is-panning')
      this.hoverEl.hidden = true
      // Always relative to the scale at drag start, so there's no accumulated drift.
      this.setScale(g.start.pan(dx, dy), true)
    } else if (g.kind === 'box') {
      g.x1 = px
      g.y1 = py
      if (!g.moved && Math.hypot(px - g.x0, py - g.y0) < DRAG_THRESHOLD) return
      g.moved = true
      this.hoverEl.hidden = true
      this.drawBox(g)
    } else if (g.kind === 'tip') {
      this.dragTip(g.tipId, px, py)
    }
  }

  private onPointerUp(e: PointerEvent): void {
    const g = this.gesture
    if (!g || g.pointerId !== e.pointerId) return
    this.gesture = null
    this.el.classList.remove('is-panning')
    const [px, py] = this.local(e)
    if (g.kind === 'pan') {
      if (!g.moved && g.button === 0) this.pinAt(px, py)
    } else if (g.kind === 'box') {
      this.boxEl.hidden = true
      if (g.moved) {
        const axes = boxAxes(g)
        this.setScale(this.scale.zoomToPxRect(g.x0, g.y0, g.x1, g.y1, axes), false)
      } else if (this.tool === 'zoom') {
        this.setScale(this.scale.zoomAt(px, py, e.altKey || g.alt ? 2 : 0.5), false)
      } else {
        this.pinAt(px, py)
      }
    } else if (g.kind === 'tip') {
      this.handlers.onTipsChange?.(this)
      const info = this.tipInfos().find((t) => t.id === g.tipId)
      if (info) this.handlers.onTipSelect?.(this, info)
    }
    this.updateHover(px, py)
  }

  private cancelGesture(): void {
    this.gesture = null
    this.boxEl.hidden = true
    this.el.classList.remove('is-panning')
  }

  private onDblClick(e: MouseEvent): void {
    if ((e.target as HTMLElement).closest('.vn-tip')) return
    // The two clicks of a double-click may have pinned a tip; a double-click only resets.
    const now = performance.now()
    const before = this.tips.length
    this.tips = this.tips.filter((t) => now - t.createdAt > 600)
    if (this.tips.length !== before) {
      this.selectedTip = null
      this.handlers.onTipsChange?.(this)
    }
    this.reset()
  }

  private onWheel(e: WheelEvent): void {
    if (!this.u || !this.model) return
    const r = this.u.over.getBoundingClientRect()
    const px = e.clientX - r.left
    const py = e.clientY - r.top
    const inX = px >= 0 && px <= r.width
    const inY = py >= 0 && py <= r.height
    if (!inX && !inY) return
    e.preventDefault()
    let axes: Axes = inX && inY ? 'xy' : inX ? 'x' : 'y'
    if (e.ctrlKey || e.metaKey) axes = 'x'
    if (e.shiftKey) axes = 'y'
    let d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX
    if (e.deltaMode === 1) d *= 16
    else if (e.deltaMode === 2) d *= r.height
    d = Math.max(-300, Math.min(300, d))
    const factor = Math.exp(d * 0.002)
    // Anchor: the data point under the cursor stays under the cursor.
    const ax = Math.max(0, Math.min(r.width, px))
    const ay = Math.max(0, Math.min(r.height, py))
    this.setScale(this.scale.zoomAt(ax, ay, factor, axes), true)
    this.handlers.onActivate?.(this)
  }

  private drawBox(g: Extract<Gesture, { kind: 'box' }>): void {
    const axes = boxAxes(g)
    const s = this.scale
    const l = axes === 'y' ? 0 : Math.min(g.x0, g.x1)
    const w = axes === 'y' ? s.width : Math.abs(g.x1 - g.x0)
    const t = axes === 'x' ? 0 : Math.min(g.y0, g.y1)
    const h = axes === 'x' ? s.height : Math.abs(g.y1 - g.y0)
    Object.assign(this.boxEl.style, { left: `${l}px`, top: `${t}px`, width: `${w}px`, height: `${h}px` })
    this.boxEl.dataset['axes'] = axes
    this.boxEl.hidden = false
  }

  private updateHover(px: number, py: number): void {
    const m = this.model
    if (!m || !this.u) return
    const hit = this.pick(px, py, HOVER_RADIUS)
    this.hover = hit
    if (hit) {
      const ser = m.series[hit.s]!
      const x = m.x[hit.index]!
      const y = ser.ys[hit.index]!
      const [hx, hy] = this.scale.dataToPx(x, y)
      this.hoverEl.hidden = false
      this.hoverEl.style.transform = `translate(${hx}px, ${hy}px)`
      this.hoverEl.style.setProperty('--c', ser.color)
      const label = this.hoverEl.lastElementChild as HTMLElement
      label.textContent = `${formatX(x, m.xKind)}, ${formatNumber(y)}`
      label.classList.toggle('flip-x', hx > this.scale.width - 160)
      label.classList.toggle('flip-y', hy < 30)
    } else {
      this.hoverEl.hidden = true
    }
    this.updateLegendValues(px)
  }

  private pinAt(px: number, py: number): void {
    const m = this.model
    if (!m) return
    const hit = this.pick(px, py, CLICK_RADIUS)
    if (!hit) {
      this.selectTip(null)
      return
    }
    const seriesId = m.series[hit.s]!.id
    const existing = this.tips.find((t) => t.seriesId === seriesId && t.index === hit.index)
    const tip = existing ?? { id: ++this.tipSeq, seriesId, index: hit.index, createdAt: performance.now() }
    if (!existing) this.tips.push(tip)
    this.selectedTip = tip.id
    this.positionOverlay()
    this.handlers.onTipsChange?.(this)
    const info = this.tipInfo(tip)
    if (info) this.handlers.onTipSelect?.(this, info)
  }

  /** Dragging a pinned tip slides it along its own series, snapping to raw samples. */
  private dragTip(tipId: number, px: number, py: number): void {
    const m = this.model
    const tip = this.tips.find((t) => t.id === tipId)
    if (!m || !tip) return
    const sIdx = m.series.findIndex((s) => s.id === tip.seriesId)
    if (sIdx < 0) return
    const ser = m.series[sIdx]!
    let index = -1
    if (m.sorted && this.mode === 'line') index = nearestByX(m.x, ser.ys, this.scale.pxToX(px))
    else index = (m.sorted ? nearestSorted(m.x, ser.ys, this.scale, px, py) : this.gridFor(sIdx).nearest(this.scale, px, py))?.index ?? -1
    if (index >= 0 && index !== tip.index) {
      tip.index = index
      this.positionOverlay()
      this.handlers.onTipsChange?.(this)
    }
  }

  /** Re-place DOM overlays from sample references through the one Scale. */
  private positionOverlay(): void {
    if (!this.u || !this.tipLayer) return
    const s = this.scale
    const alive = new Set<number>()
    // Selected tip last so it paints on top.
    const ordered = [...this.tips].sort((a, b) => Number(a.id === this.selectedTip) - Number(b.id === this.selectedTip))
    for (const tip of ordered) {
      const info = this.tipInfo(tip)
      if (!info) continue
      alive.add(tip.id)
      let el = this.tipEls.get(tip.id)
      if (!el) {
        el = document.createElement('div')
        el.className = 'vn-tip'
        el.dataset['tip'] = String(tip.id)
        el.innerHTML = '<div class="vn-dot"></div><div class="vn-tip-box"><div class="vn-tip-title"><i></i><span></span></div><div class="vn-tip-row"><span>X</span><b data-k="x"></b></div><div class="vn-tip-row"><span>Y</span><b data-k="y"></b></div><div class="vn-tip-row muted"><span>行</span><b data-k="r"></b></div></div>'
        this.tipEls.set(tip.id, el)
      }
      this.tipLayer.append(el)
      const [px, py] = s.dataToPx(info.x, info.y)
      const inside = px >= -1 && py >= -1 && px <= s.width + 1 && py <= s.height + 1 && !this.hidden.has(info.seriesId)
      el.hidden = !inside
      if (!inside) continue
      el.style.transform = `translate(${px}px, ${py}px)`
      el.style.setProperty('--c', info.color)
      el.classList.toggle('selected', info.selected)
      el.querySelector('.vn-tip-title span')!.textContent = info.label
      el.querySelector('[data-k="x"]')!.textContent = info.xText
      el.querySelector('[data-k="y"]')!.textContent = info.yText
      el.querySelector('[data-k="r"]')!.textContent = formatInt(info.row + 1)
      el.classList.toggle('flip-x', px > s.width - 170)
      el.classList.toggle('flip-y', py < 90)
    }
    for (const [id, el] of this.tipEls) {
      if (!alive.has(id)) {
        el.remove()
        this.tipEls.delete(id)
      }
    }
  }

  // ------------------------------------------------------------------ legend

  private renderLegend(): void {
    const m = this.model
    this.legendEl.replaceChildren()
    if (!m) return
    for (const ser of m.series) {
      const item = document.createElement('button')
      item.className = 'vn-legend-item'
      item.dataset['series'] = ser.id
      item.title = '单击显示/隐藏'
      item.classList.toggle('off', this.hidden.has(ser.id))
      item.innerHTML = '<i></i><span class="name"></span><span class="val"></span>'
      ;(item.firstElementChild as HTMLElement).style.background = ser.color
      item.querySelector('.name')!.textContent = ser.label
      item.addEventListener('click', () => {
        if (this.hidden.has(ser.id)) this.hidden.delete(ser.id)
        else this.hidden.add(ser.id)
        item.classList.toggle('off', this.hidden.has(ser.id))
        const custom = this.usesCustomRenderer()
        this.u?.setSeries(m.series.indexOf(ser) + 1, { show: !this.hidden.has(ser.id) })
        if (custom) this.render('full')
        this.positionOverlay()
      })
      this.legendEl.append(item)
    }
    const xInfo = document.createElement('span')
    xInfo.className = 'vn-legend-x'
    this.legendEl.append(xInfo)
  }

  /** Live readout at the cursor's X for every series (sorted X only), from raw samples. */
  private updateLegendValues(px: number | null): void {
    const m = this.model
    if (!m) return
    const xInfo = this.legendEl.querySelector<HTMLElement>('.vn-legend-x')
    const vals = this.legendEl.querySelectorAll<HTMLElement>('.vn-legend-item .val')
    if (px == null || !m.sorted) {
      vals.forEach((v) => (v.textContent = ''))
      if (xInfo) xInfo.textContent = ''
      return
    }
    const x = this.scale.pxToX(px)
    if (xInfo) xInfo.textContent = `${m.xLabel} = ${formatX(x, m.xKind)}`
    m.series.forEach((ser, i) => {
      const idx = nearestByX(m.x, ser.ys, x)
      vals[i]!.textContent = idx >= 0 ? formatNumber(ser.ys[idx]!, 5) : '—'
    })
  }
}

/**
 * The plotting area in CSS px exactly as uPlot maps data when drawing (its device-pixel
 * bbox over its pixel ratio) — not the DOM's integer-rounded clientWidth.
 */
function plotCssSize(u: uPlot): [number, number] {
  const ratio = uPlot.pxRatio || window.devicePixelRatio || 1
  return [u.bbox.width / ratio, u.bbox.height / ratio]
}

function boxAxes(g: { x0: number; y0: number; x1: number; y1: number }): Axes {
  const w = Math.abs(g.x1 - g.x0)
  const h = Math.abs(g.y1 - g.y0)
  if (h < AXIS_ONLY_PX && w >= AXIS_ONLY_PX) return 'x'
  if (w < AXIS_ONLY_PX && h >= AXIS_ONLY_PX) return 'y'
  return 'xy'
}
