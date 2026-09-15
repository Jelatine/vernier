import './styles.css'
import { DataCore } from './core/DataCore'
import { isPlottable, type ColumnId, type SeriesColumns, type TableId, type TableMeta } from './core/types'
import { TableView } from './grid/TableView'
import { formatCount, formatInt } from './plot/format'
import { PlotView, type PlotMode, type RenderStats, type Tool } from './plot/PlotView'

// Validated categorical palette (fixed order; a color follows its column, never its rank).
const PALETTE_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948']
const PALETTE_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767']
const MAX_Y = PALETTE_LIGHT.length

type Source = { kind: 'file'; file: File } | { kind: 'bytes'; name: string; bytes: Uint8Array } | { kind: 'query' }

interface Selection {
  x: ColumnId | null
  ys: ColumnId[]
  /** Palette slot per selected Y column. */
  slots: Map<ColumnId, number>
  mode: PlotMode | null
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const els = {
  open: $<HTMLButtonElement>('btn-open'),
  openEmpty: $<HTMLButtonElement>('btn-open-empty'),
  fileInput: $<HTMLInputElement>('file-input'),
  datasetSelect: $<HTMLSelectElement>('dataset-select'),
  sheetSelect: $<HTMLSelectElement>('sheet-select'),
  meta: $('dataset-meta'),
  status: $('status'),
  colFilter: $<HTMLInputElement>('col-filter'),
  colList: $('col-list'),
  sql: $<HTMLTextAreaElement>('sql-input'),
  sqlBtn: $<HTMLButtonElement>('btn-sql'),
  sqlMsg: $('sql-msg'),
  grid: $('grid'),
  gridPanel: $('grid-panel'),
  empty: $('empty'),
  splitter: $('splitter'),
  plots: $('plots'),
  plotEmpty: $('plot-empty'),
  plotStats: $('plot-stats'),
  tipsPanel: $('tips-panel'),
  dropzone: $('dropzone'),
  reset: $<HTMLButtonElement>('btn-reset'),
  fitY: $<HTMLButtonElement>('btn-fity'),
  clearTips: $<HTMLButtonElement>('btn-clear-tips'),
  export: $<HTMLButtonElement>('btn-export')
}

class App {
  private tableId: TableId | null = null
  private readonly sources = new Map<TableId, Source>()
  private readonly selections = new Map<TableId, Selection>()
  private readonly cache = new Map<string, { x: Float64Array; row: Float64Array; sorted: boolean; ys: Map<ColumnId, Float64Array> }>()
  private table: TableView
  private plots: PlotView[] = []
  private activePlot: PlotView | null = null
  private tool: Tool = 'explore'
  private layout: 'overlay' | 'stack' = 'overlay'
  private replotSeq = 0
  private replotTimer = 0
  /** `${tableId}|${xColumn}` of the model currently on screen. */
  private plottedKey: string | null = null
  private statsByView = new Map<PlotView, RenderStats>()

  constructor(private readonly core: DataCore) {
    this.table = new TableView(els.grid, core, {
      onHeaderClick: (id, { alt }) => (alt ? this.setX(id) : this.toggleY(id))
    })
    this.bindUi()
    this.syncToolbar()
  }

  // ---------------------------------------------------------------- datasets

  async openFile(file: File): Promise<void> {
    await this.importWith(file.name, (sheet) => this.core.openFile(file, { sheet }), { kind: 'file', file })
  }

  async openBytes(name: string, bytes: Uint8Array): Promise<void> {
    // Keep a pristine copy for sheet switching; the core takes ownership of what we pass.
    await this.importWith(name, (sheet) => this.core.openBytes(name, bytes.slice(), { sheet }), { kind: 'bytes', name, bytes })
  }

  private async importWith(name: string, load: (sheet?: string) => Promise<TableMeta>, source: Source): Promise<void> {
    this.setStatus(`正在导入 ${name}…`, 'busy')
    try {
      const meta = await load()
      this.sources.set(meta.id, source)
      this.setStatus(`已导入 ${name} · ${formatCount(meta.rowCount)} 行 · ${Math.round(meta.importMs)} ms`)
      this.selections.set(meta.id, defaultSelection(meta))
      this.showTable(meta.id)
    } catch (err) {
      this.setStatus(`导入失败：${errText(err)}`, 'error')
    }
  }

  private async switchSheet(sheet: string): Promise<void> {
    const id = this.tableId
    const source = id ? this.sources.get(id) : null
    if (!id || !source || source.kind === 'query') return
    const old = this.core.meta(id)
    this.setStatus(`正在读取工作表 ${sheet}…`, 'busy')
    try {
      const meta =
        source.kind === 'file'
          ? await this.core.openFile(source.file, { sheet })
          : await this.core.openBytes(source.name, source.bytes.slice(), { sheet })
      this.sources.set(meta.id, source)
      this.selections.set(meta.id, defaultSelection(meta))
      await this.dropTable(old.id)
      this.setStatus(`工作表 ${sheet} · ${formatCount(meta.rowCount)} 行 · ${Math.round(meta.importMs)} ms`)
      this.showTable(meta.id)
    } catch (err) {
      this.setStatus(`读取失败：${errText(err)}`, 'error')
    }
  }

  private async dropTable(id: TableId): Promise<void> {
    this.sources.delete(id)
    this.selections.delete(id)
    for (const key of this.cache.keys()) if (key.startsWith(`${id}|`)) this.cache.delete(key)
    await this.core.dropTable(id)
  }

  private showTable(id: TableId): void {
    this.tableId = id
    const meta = this.core.meta(id)
    els.empty.hidden = true
    this.table.setTable(meta)
    this.renderDatasetBar()
    this.renderColumns()
    this.updateSqlPlaceholder()
    this.replot('table')
  }

  private renderDatasetBar(): void {
    const list = this.core.list
    els.datasetSelect.hidden = list.length === 0
    els.datasetSelect.replaceChildren(
      ...list.map((t) => {
        const o = document.createElement('option')
        o.value = t.id
        o.textContent = `${t.title}`
        o.selected = t.id === this.tableId
        return o
      })
    )
    const meta = this.tableId ? this.core.meta(this.tableId) : null
    const sheets = meta?.sheets ?? []
    els.sheetSelect.hidden = sheets.length < 2
    els.sheetSelect.replaceChildren(
      ...sheets.map((s) => {
        const o = document.createElement('option')
        o.value = s
        o.textContent = s
        o.selected = s === meta?.sheet
        return o
      })
    )
    els.meta.textContent = meta ? `${formatInt(meta.rowCount)} 行 · ${meta.columns.length} 列 · SQL 表名 ${meta.sqlName}` : ''
  }

  // ---------------------------------------------------------------- selection

  private get sel(): Selection | null {
    return this.tableId ? (this.selections.get(this.tableId) ?? null) : null
  }

  private setX(id: ColumnId | null): void {
    const sel = this.sel
    if (!sel || !this.tableId) return
    if (id && !isPlottable(this.core.meta(this.tableId).columns.find((c) => c.id === id)!.kind)) {
      this.setStatus('该列不是数值/时间类型，不能作为 X', 'error')
      return
    }
    sel.x = sel.x === id ? null : id
    sel.mode = null
    this.removeY(sel, id)
    this.afterSelection('x')
  }

  private toggleY(id: ColumnId): void {
    const sel = this.sel
    if (!sel || !this.tableId) return
    const col = this.core.meta(this.tableId).columns.find((c) => c.id === id)!
    if (sel.ys.includes(id)) {
      this.removeY(sel, id)
    } else {
      if (!isPlottable(col.kind)) {
        this.setStatus(`「${col.name}」不是数值/时间类型，不能作为 Y`, 'error')
        return
      }
      if (sel.ys.length >= MAX_Y) {
        this.setStatus(`最多同时绘制 ${MAX_Y} 条曲线`, 'error')
        return
      }
      if (sel.x === id) sel.x = null
      const used = new Set(sel.slots.values())
      let slot = 0
      while (used.has(slot)) slot++
      sel.slots.set(id, slot)
      sel.ys.push(id)
    }
    this.afterSelection('y')
  }

  private removeY(sel: Selection, id: ColumnId | null): void {
    if (!id) return
    sel.ys = sel.ys.filter((y) => y !== id)
    sel.slots.delete(id)
  }

  private afterSelection(kind: 'x' | 'y'): void {
    this.renderColumns()
    this.replot(kind)
  }

  private colors(sel: Selection): Map<ColumnId, string> {
    const palette = document.documentElement.dataset['theme'] === 'dark' ? PALETTE_DARK : PALETTE_LIGHT
    return new Map([...sel.slots].map(([id, slot]) => [id, palette[slot]!]))
  }

  private renderColumns(): void {
    const meta = this.tableId ? this.core.meta(this.tableId) : null
    const sel = this.sel
    els.colList.replaceChildren()
    if (!meta || !sel) return
    const colors = this.colors(sel)
    const filter = els.colFilter.value.trim().toLowerCase()
    const rowItem = this.columnItem({ id: '', name: '行号', duckType: 'ROW', kind: 'number' }, sel.x === null, false, undefined, true)
    els.colList.append(rowItem)
    for (const c of meta.columns) {
      if (filter && !c.name.toLowerCase().includes(filter)) continue
      els.colList.append(this.columnItem(c, sel.x === c.id, sel.ys.includes(c.id), colors.get(c.id)))
    }
    this.table.setSelection({ x: sel.x, ys: sel.ys, colors })
  }

  private columnItem(
    c: { id: string; name: string; duckType: string; kind: string },
    isX: boolean,
    isY: boolean,
    color: string | undefined,
    rowIndex = false
  ): HTMLElement {
    const item = document.createElement('div')
    item.className = 'col-item'
    item.setAttribute('role', 'listitem')
    item.dataset['id'] = c.id
    item.classList.toggle('is-x', isX)
    item.classList.toggle('is-y', isY)
    const plottable = isPlottable(c.kind as never)
    const xBtn = document.createElement('button')
    xBtn.className = 'pick pick-x'
    xBtn.textContent = 'X'
    xBtn.title = rowIndex ? '以行号作为 X' : '设为 X 轴'
    xBtn.disabled = !plottable
    xBtn.setAttribute('aria-pressed', String(isX))
    xBtn.addEventListener('click', () => this.setX(rowIndex ? null : c.id))
    const yBtn = document.createElement('button')
    yBtn.className = 'pick pick-y'
    yBtn.textContent = 'Y'
    yBtn.title = '加入 / 移出 Y'
    yBtn.disabled = !plottable || rowIndex
    yBtn.style.visibility = rowIndex ? 'hidden' : ''
    yBtn.setAttribute('aria-pressed', String(isY))
    if (color) yBtn.style.setProperty('--c', color)
    yBtn.addEventListener('click', () => this.toggleY(c.id))
    const name = document.createElement('span')
    name.className = 'col-name'
    name.textContent = c.name
    name.title = c.name
    const type = document.createElement('span')
    type.className = `col-type kind-${c.kind}`
    type.textContent = rowIndex ? '' : shortType(c.duckType)
    item.append(xBtn, yBtn, name, type)
    return item
  }

  // ---------------------------------------------------------------- plotting

  private replot(reason: 'table' | 'x' | 'y' | 'layout'): void {
    clearTimeout(this.replotTimer)
    this.replotTimer = window.setTimeout(() => void this.doReplot(reason), 16)
  }

  private async doReplot(reason: 'table' | 'x' | 'y' | 'layout'): Promise<void> {
    const token = ++this.replotSeq
    const sel = this.sel
    const tableId = this.tableId
    if (!sel || !tableId || sel.ys.length === 0) {
      this.plottedKey = null
      this.setPlots(0)
      els.plotEmpty.hidden = false
      this.renderTips()
      return
    }
    const t0 = performance.now()
    let cols: SeriesColumns & { ysById: Map<ColumnId, Float64Array> }
    try {
      cols = await this.seriesFor(tableId, sel)
    } catch (err) {
      this.setStatus(`取数失败：${errText(err)}`, 'error')
      return
    }
    if (token !== this.replotSeq) return
    const meta = this.core.meta(tableId)
    const colors = this.colors(sel)
    const xCol = sel.x ? meta.columns.find((c) => c.id === sel.x)! : null
    const series = sel.ys.map((id) => ({
      id,
      label: meta.columns.find((c) => c.id === id)!.name,
      ys: cols.ysById.get(id)!,
      color: colors.get(id)!
    }))
    const mode: PlotMode = sel.mode ?? (cols.sorted ? 'line' : 'scatter')
    const base = {
      x: cols.x,
      row: cols.row,
      sorted: cols.sorted,
      xLabel: xCol ? xCol.name : '行号',
      xKind: (xCol ? (xCol.kind === 'time' ? 'time' : 'number') : 'row') as 'time' | 'number' | 'row'
    }
    // Keep the current X view (and tips, which index samples) only if what's on screen already
    // uses this exact X column. Several selection changes can collapse into one debounced
    // replot, so the triggering reason alone can't tell us that.
    const key = `${tableId}|${sel.x ?? '#row'}`
    const sameX = reason !== 'table' && this.plottedKey === key
    const keep = sameX
    this.plottedKey = key
    els.plotEmpty.hidden = true

    if (this.layout === 'overlay') {
      const hadOverlay = this.plots.length === 1
      this.setPlots(1)
      this.plots[0]!.setModel({ ...base, series }, mode, { keepX: keep, keepTips: sameX && hadOverlay })
    } else {
      const prevX = this.plots[0]?.getScale()
      this.setPlots(series.length)
      series.forEach((s, i) => this.plots[i]!.setModel({ ...base, series: [s] }, mode, { keepTips: false }))
      if (keep && prevX) for (const p of this.plots) p.setXBounds(prevX.xMin, prevX.xMax, false)
    }
    this.syncToolbar()
    this.renderTips()
    const n = formatCount(cols.x.length)
    this.setStatus(`绘图 ${n} 点 × ${series.length} 列 · 取数 ${Math.round(cols.fetchMs)} ms · 总计 ${Math.round(performance.now() - t0)} ms`)
  }

  /** Fetch only the columns not already cached for this (table, X) pair. */
  private async seriesFor(tableId: TableId, sel: Selection) {
    const key = `${tableId}|${sel.x ?? '#row'}`
    let entry = this.cache.get(key)
    const missing = entry ? sel.ys.filter((y) => !entry!.ys.has(y)) : sel.ys
    let fetchMs = 0
    if (!entry || missing.length) {
      const res = await this.core.fetchSeries({ tableId, x: sel.x, ys: missing })
      fetchMs = res.fetchMs
      if (!entry) {
        entry = { x: res.x, row: res.row, sorted: res.sorted, ys: new Map() }
        this.cache.set(key, entry)
      }
      missing.forEach((id, i) => entry!.ys.set(id, res.ys[i]!))
    }
    return { x: entry.x, row: entry.row, sorted: entry.sorted, ys: [], ysById: entry.ys, fetchMs }
  }

  private setPlots(n: number): void {
    while (this.plots.length > n) {
      const p = this.plots.pop()!
      this.statsByView.delete(p)
      p.destroy()
    }
    while (this.plots.length < n) {
      const view = new PlotView(els.plots, {
        onViewChange: (v, scale, interactive) => {
          if (this.layout !== 'stack') return
          for (const other of this.plots) if (other !== v) other.setXBounds(scale.xMin, scale.xMax, interactive)
        },
        onTipsChange: () => this.renderTips(),
        onTipSelect: (_v, tip) => {
          const meta = this.tableId ? this.core.meta(this.tableId) : null
          this.table.revealRow(tip.row, meta ? tip.seriesId : undefined)
        },
        onStats: (v, stats) => {
          this.statsByView.set(v, stats)
          this.renderStats()
        },
        onActivate: (v) => (this.activePlot = v)
      })
      view.setTool(this.tool)
      this.plots.push(view)
    }
    els.plots.classList.toggle('stacked', n > 1)
    if (!this.activePlot || !this.plots.includes(this.activePlot)) this.activePlot = this.plots[0] ?? null
  }

  private renderStats(): void {
    const all = [...this.statsByView.values()]
    if (!all.length) {
      els.plotStats.textContent = ''
      return
    }
    const s = all[0]!
    const ms = all.reduce((a, b) => a + b.ms, 0)
    const how = s.mode === 'm4' ? 'M4 降采样' : s.mode === 'raw' ? '原始点' : s.mode === 'raster' ? '散点栅格' : '折线'
    const phase = all.some((x) => x.phase === 'coarse') ? '快速' : '全精度'
    els.plotStats.textContent = `${how} · 可见 ${formatInt(s.visible)} → 绘制 ${formatInt(s.drawn)} · ${ms.toFixed(1)} ms · ${phase}`
    els.plotStats.dataset['phase'] = phase === '快速' ? 'coarse' : 'full'
  }

  private renderTips(): void {
    const tips = this.plots.flatMap((p) => p.tipInfos().map((t) => ({ view: p, t })))
    // The strip is always laid out, so pinning a tip never resizes the axes under the pointer.
    els.tipsPanel.hidden = this.plots.length === 0
    els.tipsPanel.replaceChildren()
    if (!tips.length) {
      const hint = document.createElement('div')
      hint.className = 'tips-hint'
      hint.textContent = '浏览模式单击曲线放置数据游标 · 拖动游标圆点沿曲线移动 · 右键游标删除 · 滚轮缩放（Ctrl 仅 X，Shift 仅 Y）· 双击复位'
      els.tipsPanel.append(hint)
      return
    }
    const head = document.createElement('div')
    head.className = 'tips-head'
    head.textContent = `数据游标 ${tips.length}`
    els.tipsPanel.append(head)
    for (const { view, t } of tips) {
      const row = document.createElement('div')
      row.className = 'tip-chip'
      row.classList.toggle('selected', t.selected)
      row.title = '单击定位到表格行'
      row.innerHTML = '<i></i><span class="l"></span><span class="v"></span><button class="x" title="删除">×</button>'
      ;(row.firstElementChild as HTMLElement).style.background = t.color
      row.querySelector('.l')!.textContent = t.label
      row.querySelector('.v')!.textContent = `X ${t.xText} · Y ${t.yText} · 行 ${formatInt(t.row + 1)}`
      row.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.x')) {
          view.removeTip(t.id)
          return
        }
        view.selectTip(t.id)
        this.table.revealRow(t.row, t.seriesId)
      })
      els.tipsPanel.append(row)
    }
  }

  // ---------------------------------------------------------------- UI wiring

  private syncToolbar(): void {
    document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset['tool'] === this.tool)))
    document.querySelectorAll<HTMLButtonElement>('[data-layout]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset['layout'] === this.layout)))
    const mode = this.plots[0]?.getMode() ?? this.sel?.mode ?? 'line'
    document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset['mode'] === mode)))
  }

  private setStatus(text: string, kind: 'ok' | 'busy' | 'error' = 'ok'): void {
    els.status.textContent = text
    els.status.dataset['kind'] = kind
  }

  private updateSqlPlaceholder(): void {
    const meta = this.tableId ? this.core.meta(this.tableId) : null
    if (!meta) return
    const num = meta.columns.find((c) => c.kind === 'number')
    const str = meta.columns.find((c) => c.kind === 'string')
    const q = (n: string) => (/^[a-z_][a-z0-9_]*$/.test(n) ? n : `"${n}"`)
    els.sql.placeholder =
      str && num
        ? `SELECT ${q(str.name)}, count(*) AS n, avg(${q(num.name)}) AS mean\nFROM ${meta.sqlName}\nGROUP BY 1 ORDER BY 1`
        : num
          ? `SELECT *, avg(${q(num.name)}) OVER (ORDER BY rowid ROWS 50 PRECEDING) AS smooth\nFROM ${meta.sqlName}`
          : `SELECT * FROM ${meta.sqlName} LIMIT 100`
  }

  private async runSql(): Promise<void> {
    const sql = els.sql.value.trim() || els.sql.placeholder
    if (!sql) return
    els.sqlMsg.textContent = '运行中…'
    els.sqlMsg.dataset['kind'] = 'busy'
    try {
      const meta = await this.core.runQuery(sql.replace(/;\s*$/, ''))
      this.sources.set(meta.id, { kind: 'query' })
      this.selections.set(meta.id, defaultSelection(meta))
      els.sqlMsg.textContent = `${formatInt(meta.rowCount)} 行 · ${Math.round(meta.importMs)} ms`
      els.sqlMsg.dataset['kind'] = 'ok'
      this.showTable(meta.id)
    } catch (err) {
      els.sqlMsg.textContent = errText(err)
      els.sqlMsg.dataset['kind'] = 'error'
    }
  }

  private async exportPng(): Promise<void> {
    const view = this.activePlot ?? this.plots[0]
    const blob = await view?.exportPng()
    if (!blob) return
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${this.tableId ? this.core.meta(this.tableId).sqlName : 'plot'}.png`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 5000)
  }

  private bindUi(): void {
    const pick = () => els.fileInput.click()
    els.open.addEventListener('click', pick)
    els.openEmpty.addEventListener('click', pick)
    els.fileInput.addEventListener('change', () => {
      const f = els.fileInput.files?.[0]
      els.fileInput.value = ''
      if (f) void this.openFile(f)
    })
    els.datasetSelect.addEventListener('change', () => this.showTable(els.datasetSelect.value))
    els.sheetSelect.addEventListener('change', () => void this.switchSheet(els.sheetSelect.value))
    els.colFilter.addEventListener('input', () => this.renderColumns())
    els.sqlBtn.addEventListener('click', () => void this.runSql())
    els.sql.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        void this.runSql()
      }
    })

    document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) =>
      b.addEventListener('click', () => this.setTool(b.dataset['tool'] as Tool))
    )
    document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) =>
      b.addEventListener('click', () => {
        const mode = b.dataset['mode'] as PlotMode
        if (this.sel) this.sel.mode = mode
        this.plots.forEach((p) => p.setMode(mode))
        this.syncToolbar()
      })
    )
    document.querySelectorAll<HTMLButtonElement>('[data-layout]').forEach((b) =>
      b.addEventListener('click', () => {
        this.layout = b.dataset['layout'] as 'overlay' | 'stack'
        this.syncToolbar()
        this.replot('layout')
      })
    )
    els.reset.addEventListener('click', () => this.plots.forEach((p) => p.reset()))
    els.fitY.addEventListener('click', () => this.plots.forEach((p) => p.fitY()))
    els.clearTips.addEventListener('click', () => this.plots.forEach((p) => p.clearTips()))
    els.export.addEventListener('click', () => void this.exportPng())

    window.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement
      if (t.closest('input, textarea, select, .ag-root-wrapper')) return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'o' && !window.vernier) {
        e.preventDefault()
        pick()
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'z' || e.key === 'Z') return this.setTool('zoom')
      if (e.key === 'e' || e.key === 'E') return this.setTool('explore')
      const view = this.activePlot
      if (view && view.handleKey(e)) e.preventDefault()
    })

    // Drag & drop: the File handle goes straight to the data core, no IPC involved.
    let depth = 0
    window.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return
      depth++
      els.dropzone.hidden = false
    })
    window.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1)
      if (!depth) els.dropzone.hidden = true
    })
    window.addEventListener('dragover', (e) => e.preventDefault())
    window.addEventListener('drop', (e) => {
      e.preventDefault()
      depth = 0
      els.dropzone.hidden = true
      const f = e.dataTransfer?.files[0]
      if (f) void this.openFile(f)
    })

    this.bindSplitter()

    window.vernier?.onMenu((cmd) => {
      if (cmd === 'open') pick()
      else if (cmd === 'reset-view') this.plots.forEach((p) => p.reset())
      else if (cmd === 'export-png') void this.exportPng()
    })
    window.vernier?.onOpenBytes((p) => void this.openBytes(p.name, p.bytes))
  }

  private setTool(tool: Tool): void {
    this.tool = tool
    this.plots.forEach((p) => p.setTool(tool))
    this.syncToolbar()
  }

  private bindSplitter(): void {
    els.splitter.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      els.splitter.setPointerCapture(e.pointerId)
      const startY = e.clientY
      const startH = els.gridPanel.getBoundingClientRect().height
      const total = els.gridPanel.parentElement!.getBoundingClientRect().height
      const move = (ev: PointerEvent) => {
        const h = Math.max(80, Math.min(total - 200, startH + ev.clientY - startY))
        els.gridPanel.style.flexBasis = `${h}px`
      }
      const up = () => {
        els.splitter.removeEventListener('pointermove', move)
        els.splitter.removeEventListener('pointerup', up)
      }
      els.splitter.addEventListener('pointermove', move)
      els.splitter.addEventListener('pointerup', up)
    })
  }

  onThemeChange(): void {
    const sel = this.sel
    this.table.setDark()
    if (sel) this.renderColumns()
    this.replot('layout')
  }

  debug() {
    return {
      tableId: this.tableId,
      meta: this.tableId ? this.core.meta(this.tableId) : null,
      selection: this.sel ? { x: this.sel.x, ys: [...this.sel.ys], mode: this.sel.mode } : null,
      layout: this.layout,
      tool: this.tool,
      plots: this.plots.map((p) => p.debugState())
    }
  }
}

function defaultSelection(meta: TableMeta): Selection {
  const first = meta.columns[0]
  const looksLikeX = (c: TableMeta['columns'][number]) =>
    c.kind === 'time' || (c.kind === 'number' && /(^|_|\b)(t|x|time|timestamp|date|index|idx|时间|日期|时刻)(_|\b|$)/i.test(c.name))
  const x = first && looksLikeX(first) ? first.id : null
  const y = meta.columns.find((c) => c.id !== x && isPlottable(c.kind) && c.kind !== 'time')
  return { x, ys: y ? [y.id] : [], slots: new Map(y ? [[y.id, 0]] : []), mode: null }
}

function shortType(t: string): string {
  return t.replace('TIMESTAMP WITH TIME ZONE', 'TIMESTAMPTZ').replace(/^DECIMAL.*/, 'DECIMAL')
}

function errText(err: unknown): string {
  const s = err instanceof Error ? err.message : String(err)
  return s.length > 300 ? `${s.slice(0, 300)}…` : s
}

function applyTheme(): void {
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
  document.documentElement.dataset['theme'] = dark ? 'dark' : 'light'
}

async function boot(): Promise<void> {
  applyTheme()
  els.status.textContent = '正在启动数据引擎…'
  const t0 = performance.now()
  const core = await DataCore.create()
  const app = new App(core)
  els.status.textContent = `数据引擎就绪 · ${Math.round(performance.now() - t0)} ms`
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    applyTheme()
    app.onThemeChange()
  })
  Object.assign(window, { __vernier: { ready: true, app, core } })
  window.vernier?.ready()
}

boot().catch((err) => {
  els.status.textContent = `启动失败：${errText(err)}`
  els.status.dataset['kind'] = 'error'
  console.error(err)
})
