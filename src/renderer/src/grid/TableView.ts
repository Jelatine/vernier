import {
  AllCommunityModule,
  ModuleRegistry,
  colorSchemeDark,
  colorSchemeLight,
  createGrid,
  themeQuartz,
  type ColDef,
  type GridApi,
  type IDatasource
} from 'ag-grid-community'
import type { DataCore } from '../core/DataCore'
import type { Cell, ColumnId, TableMeta } from '../core/types'

ModuleRegistry.registerModules([AllCommunityModule])

export interface TableSelection {
  x: ColumnId | null
  ys: ColumnId[]
  colors: Map<ColumnId, string>
}

export interface TableViewHandlers {
  /** Plain click toggles Y; Alt/Option-click sets X. */
  onHeaderClick(columnId: ColumnId, modifiers: { alt: boolean }): void
}

type Row = Record<string, Cell>

/**
 * Read-only virtualized table. It never holds the dataset: AG Grid's infinite row model
 * asks for row index blocks as the user scrolls, and each block is fetched from the data
 * core by range.
 */
export class TableView {
  private api: GridApi<Row> | null = null
  private meta: TableMeta | null = null
  private readonly styleEl = document.createElement('style')
  private selectionCss = ''
  private rowCss = ''
  private lastAlt = false

  constructor(
    private readonly el: HTMLElement,
    private readonly core: DataCore,
    private readonly handlers: TableViewHandlers
  ) {
    document.head.append(this.styleEl)
    // AG Grid's header-click event carries no modifier keys; remember them ourselves.
    el.addEventListener('pointerdown', (e) => (this.lastAlt = e.altKey), true)
  }

  setTable(meta: TableMeta | null): void {
    this.meta = meta
    this.api?.destroy()
    this.api = null
    this.rowCss = ''
    this.applyCss()
    if (!meta) return

    const numberish = new Set(['number', 'bool'])
    const columnDefs: ColDef<Row>[] = [
      {
        colId: '__row',
        headerName: '#',
        valueGetter: (p) => (p.node?.rowIndex != null ? p.node.rowIndex + 1 : ''),
        width: Math.max(56, String(meta.rowCount).length * 8 + 20),
        pinned: 'left',
        resizable: false,
        sortable: false,
        suppressMovable: true,
        cellClass: 'vn-rownum',
        headerClass: 'vn-rownum-h'
      },
      ...meta.columns.map<ColDef<Row>>((c) => ({
        colId: c.id,
        field: c.id,
        headerName: c.name,
        headerTooltip: `${c.name} · ${c.duckType}\n单击：加入/移出 Y　⌥单击：设为 X`,
        sortable: false,
        width: Math.min(260, Math.max(c.kind === 'time' ? 168 : 96, c.name.length * 8 + 44)),
        cellClass: numberish.has(c.kind) ? 'vn-num' : c.kind === 'time' ? 'vn-time' : undefined,
        headerClass: `vn-kind-${c.kind}`
      }))
    ]

    const datasource: IDatasource = {
      rowCount: meta.rowCount,
      getRows: (p) => {
        const current = this.meta
        if (!current) return p.failCallback()
        this.core
          .fetchRows(current.id, { start: p.startRow, end: p.endRow })
          .then((block) => {
            const n = block.range.end - block.range.start
            const ids = Object.keys(block.columns)
            const rows: Row[] = new Array(n)
            for (let i = 0; i < n; i++) {
              const r: Row = {}
              for (const id of ids) r[id] = block.columns[id]![i]!
              rows[i] = r
            }
            p.successCallback(rows, current.rowCount)
          })
          .catch(() => p.failCallback())
      }
    }

    this.api = createGrid<Row>(this.el, {
      theme: this.theme(),
      columnDefs,
      rowModelType: 'infinite',
      datasource,
      cacheBlockSize: 200,
      maxBlocksInCache: 40,
      maxConcurrentDatasourceRequests: 2,
      blockLoadDebounceMillis: 30,
      rowBuffer: 20,
      tooltipShowDelay: 400,
      suppressCellFocus: false,
      enableCellTextSelection: true,
      animateRows: false,
      onColumnHeaderClicked: (e) => {
        const id = 'getColId' in e.column ? e.column.getColId() : null
        if (id && id !== '__row') this.handlers.onHeaderClick(id, { alt: this.lastAlt })
      }
    })
  }

  /** Header underline + faint column wash in each selected column's series color. */
  setSelection(sel: TableSelection): void {
    const rules: string[] = []
    if (sel.x) {
      rules.push(
        `.ag-header-cell[col-id="${sel.x}"]{box-shadow:inset 0 -3px 0 var(--text-primary)}`,
        `.ag-header-cell[col-id="${sel.x}"] .ag-header-cell-text::before{content:"X · ";color:var(--text-secondary);font-weight:600}`,
        `.ag-cell[col-id="${sel.x}"]{background:var(--x-wash)}`
      )
    }
    for (const id of sel.ys) {
      const c = sel.colors.get(id) ?? 'currentColor'
      rules.push(
        `.ag-header-cell[col-id="${id}"]{box-shadow:inset 0 -3px 0 ${c}}`,
        `.ag-cell[col-id="${id}"]{background:color-mix(in srgb, ${c} 7%, transparent)}`
      )
    }
    this.selectionCss = rules.join('\n')
    this.applyCss()
  }

  /**
   * Scroll a row (e.g. the row behind a datatip) into view and mark it. Deliberately does
   * not move keyboard focus into the grid, so plot shortcuts keep working.
   */
  revealRow(row: number, columnId?: ColumnId): void {
    const api = this.api
    if (!api) return
    api.ensureIndexVisible(row, 'middle')
    if (columnId) api.ensureColumnVisible(columnId)
    this.rowCss =
      `.ag-row[row-index="${row}"] .ag-cell{box-shadow:inset 0 1px 0 var(--text-primary), inset 0 -1px 0 var(--text-primary)}` +
      (columnId ? `\n.ag-row[row-index="${row}"] .ag-cell[col-id="${columnId}"]{font-weight:650}` : '')
    this.applyCss()
  }

  private applyCss(): void {
    this.styleEl.textContent = `${this.selectionCss}\n${this.rowCss}`
  }

  setDark(): void {
    this.api?.setGridOption('theme', this.theme())
  }

  private theme() {
    const dark = document.documentElement.dataset['theme'] === 'dark'
    return themeQuartz.withPart(dark ? colorSchemeDark : colorSchemeLight).withParams({
      fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
      fontSize: 12,
      headerFontSize: 12,
      headerFontWeight: 600,
      rowHeight: 26,
      headerHeight: 30,
      spacing: 5,
      wrapperBorderRadius: 0,
      wrapperBorder: false,
      backgroundColor: dark ? '#1a1a19' : '#fcfcfb',
      headerBackgroundColor: dark ? '#222221' : '#f3f3f0',
      foregroundColor: dark ? '#ffffff' : '#0b0b0b',
      borderColor: dark ? '#2c2c2a' : '#e1e0d9',
      accentColor: dark ? '#3987e5' : '#2a78d6',
      oddRowBackgroundColor: dark ? '#1d1d1c' : '#f9f9f7'
    })
  }
}
