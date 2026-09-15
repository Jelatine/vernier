import * as duckdb from '@duckdb/duckdb-wasm'
import ehWasmUrl from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url'
import ehWorkerUrl from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url'
import type { Table as ArrowTable } from 'apache-arrow'
import { kindOfDuckType, vectorToCells, vectorToFloat64 } from './arrow'
import type { ColumnId, ColumnMeta, RowBlock, RowRange, SeriesColumns, SeriesRequest, TableId, TableMeta } from './types'
import type { XlsxRequest, XlsxResponse } from './xlsx.worker'

/**
 * Columnar data core. All data lives in DuckDB-WASM (its own worker + WASM heap, not the V8
 * heap); callers only ever receive a block of display cells for a visible row range, or
 * typed Float64Array columns for plotting.
 *
 * Every imported table is stored with physical column names c0..cN (so no identifier ever
 * needs escaping) in insertion order, plus a view with the original names for SQL.
 */
export class DataCore {
  private tables = new Map<TableId, TableMeta>()
  private seq = 0
  private xlsxWorker: Worker | null = null
  private xlsxSeq = 0
  private xlsxPending = new Map<number, (r: XlsxResponse) => void>()

  private constructor(
    private readonly db: duckdb.AsyncDuckDB,
    private readonly conn: duckdb.AsyncDuckDBConnection
  ) {}

  static async create(): Promise<DataCore> {
    // Electron's Chromium always supports wasm exceptions, so ship only the EH build.
    const worker = new Worker(ehWorkerUrl)
    const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker)
    await db.instantiate(ehWasmUrl)
    await db.open({ query: { castBigIntToDouble: false } })
    const conn = await db.connect()
    return new DataCore(db, conn)
  }

  get list(): TableMeta[] {
    return [...this.tables.values()]
  }

  meta(id: TableId): TableMeta {
    const m = this.tables.get(id)
    if (!m) throw new Error(`unknown table ${id}`)
    return m
  }

  async openFile(file: File, opts: { sheet?: string } = {}): Promise<TableMeta> {
    const ext = extOf(file.name)
    if (ext === 'xlsx' || ext === 'xls' || ext === 'xlsm') {
      return this.importXlsx(file.name, await file.arrayBuffer(), opts.sheet)
    }
    const id = this.nextId()
    const vfile = `${id}.${ext || 'csv'}`
    // Lazy: DuckDB reads the File through FileReaderSync in its worker, chunk by chunk.
    await this.db.registerFileHandle(vfile, file, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true)
    return this.importScan(id, file.name, vfile, ext)
  }

  /** Takes ownership of `bytes` (they are transferred to a worker). */
  async openBytes(name: string, bytes: Uint8Array, opts: { sheet?: string } = {}): Promise<TableMeta> {
    const ext = extOf(name)
    if (ext === 'xlsx' || ext === 'xls' || ext === 'xlsm') {
      const buf = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer
      return this.importXlsx(name, buf as ArrayBuffer, opts.sheet)
    }
    const id = this.nextId()
    const vfile = `${id}.${ext || 'csv'}`
    await this.db.registerFileBuffer(vfile, bytes)
    return this.importScan(id, name, vfile, ext)
  }

  /** Materialize a SQL query (over the friendly views) as a new table. */
  async runQuery(sql: string, title?: string): Promise<TableMeta> {
    const id = this.nextId()
    const t0 = performance.now()
    const describe = await this.conn.query(`DESCRIBE ${sql}`)
    const cols = describeToColumns(describe)
    const select = cols.map((c, i) => `${quoteIdent(c.name)} AS c${i}`).join(', ')
    await this.conn.query(`CREATE TABLE ${id} AS SELECT ${select || '*'} FROM (${sql})`)
    return this.finishImport(id, title ?? `查询 ${id}`, 'query', cols, t0)
  }

  async dropTable(id: TableId): Promise<void> {
    const m = this.tables.get(id)
    if (!m) return
    this.tables.delete(id)
    await this.conn.query(`DROP VIEW IF EXISTS ${quoteIdent(m.sqlName)}`)
    await this.conn.query(`DROP TABLE IF EXISTS ${id}`)
  }

  /** Display cells for a row range — what the table view asks for as it scrolls. */
  async fetchRows(id: TableId, range: RowRange, columnIds?: ColumnId[]): Promise<RowBlock> {
    const meta = this.meta(id)
    const cols = columnIds ? meta.columns.filter((c) => columnIds.includes(c.id)) : meta.columns
    const start = Math.max(0, Math.floor(range.start))
    const end = Math.min(meta.rowCount, Math.floor(range.end))
    if (end <= start || cols.length === 0) return { range: { start, end: Math.max(start, end) }, columns: {} }

    const exprs = cols.map((c) => `${displayExpr(c)} AS ${c.id}`).join(', ')
    const res = await this.conn.query(
      `SELECT ${exprs} FROM ${id} WHERE rowid >= ${start} AND rowid < ${end} ORDER BY rowid`
    )
    const columns: RowBlock['columns'] = {}
    for (const c of cols) columns[c.id] = vectorToCells(res.getChild(c.id)!)
    return { range: { start, end }, columns }
  }

  /** Typed columns for plotting. Rows whose X is null / non-finite are dropped. */
  async fetchSeries(req: SeriesRequest): Promise<SeriesColumns> {
    const t0 = performance.now()
    const meta = this.meta(req.tableId)
    const byId = new Map(meta.columns.map((c) => [c.id, c]))
    const xExpr = req.x ? numericExpr(byId.get(req.x)!) : 'CAST(rowid AS DOUBLE)'
    const yExprs = req.ys.map((y, i) => `${numericExpr(byId.get(y)!)} AS y${i}`)
    const sql = `SELECT CAST(rowid AS DOUBLE) AS r, x${yExprs.length ? ', ' + yExprs.join(', ') : ''}
      FROM (SELECT rowid, * , ${xExpr} AS x FROM ${req.tableId})
      WHERE x IS NOT NULL AND isfinite(x) ORDER BY rowid`
    const res = await this.conn.query(sql)
    const x = vectorToFloat64(res.getChild('x')!)
    const ys = req.ys.map((_, i) => vectorToFloat64(res.getChild(`y${i}`)!))
    const row = vectorToFloat64(res.getChild('r')!)
    return { x, ys, row, sorted: isSorted(x), fetchMs: performance.now() - t0 }
  }

  // ---------------------------------------------------------------- import internals

  private nextId(): TableId {
    return `t${++this.seq}`
  }

  private async importScan(id: TableId, title: string, vfile: string, ext: string): Promise<TableMeta> {
    const t0 = performance.now()
    const reader =
      ext === 'parquet'
        ? `read_parquet('${vfile}')`
        : `read_csv('${vfile}', header = true, sample_size = 50000${ext === 'tsv' ? ", delim = '\\t'" : ''})`
    try {
      const cols = describeToColumns(await this.conn.query(`DESCRIBE SELECT * FROM ${reader}`))
      const select = cols.map((c, i) => `${quoteIdent(c.name)} AS c${i}`).join(', ')
      await this.conn.query(`CREATE TABLE ${id} AS SELECT ${select} FROM ${reader}`)
      return await this.finishImport(id, title, ext === 'parquet' ? 'parquet' : 'csv', cols, t0)
    } finally {
      await this.db.dropFile(vfile).catch(() => undefined)
    }
  }

  private async importXlsx(title: string, bytes: ArrayBuffer, sheet?: string): Promise<TableMeta> {
    const t0 = performance.now()
    const res = await this.parseXlsx(bytes, sheet)
    if (!res.ok) throw new Error(res.error)
    const id = this.nextId()
    if (res.names.length === 0) {
      await this.conn.query(`CREATE TABLE ${id} (c0 VARCHAR)`)
      return this.finishImport(id, title, 'xlsx', [{ name: 'Column1', type: 'VARCHAR' }], t0, res.sheets, res.sheet)
    }
    await this.conn.insertArrowFromIPCStream(res.ipc, { name: id, create: true })
    for (const [col, cast] of Object.entries(res.casts)) {
      const using = cast === 'time' ? `epoch_ms(CAST(${col} AS BIGINT))` : `${col} <> 0`
      await this.conn.query(`ALTER TABLE ${id} ALTER ${col} TYPE ${cast === 'time' ? 'TIMESTAMP' : 'BOOLEAN'} USING ${using}`)
    }
    const types = describeToColumns(await this.conn.query(`DESCRIBE ${id}`))
    const cols = res.names.map((name, i) => ({ name, type: types[i]!.type }))
    return this.finishImport(id, title, 'xlsx', cols, t0, res.sheets, res.sheet)
  }

  private parseXlsx(bytes: ArrayBuffer, sheet?: string): Promise<XlsxResponse> {
    if (!this.xlsxWorker) {
      this.xlsxWorker = new Worker(new URL('./xlsx.worker.ts', import.meta.url), { type: 'module' })
      this.xlsxWorker.onmessage = (e: MessageEvent<XlsxResponse>) => {
        this.xlsxPending.get(e.data.id)?.(e.data)
        this.xlsxPending.delete(e.data.id)
      }
    }
    const id = ++this.xlsxSeq
    return new Promise((resolve) => {
      this.xlsxPending.set(id, resolve)
      // Transfer, don't copy: the main thread gives up the file bytes.
      this.xlsxWorker!.postMessage({ id, bytes, sheet } satisfies XlsxRequest, [bytes])
    })
  }

  private async finishImport(
    id: TableId,
    title: string,
    source: TableMeta['source'],
    cols: { name: string; type: string }[],
    t0: number,
    sheets?: string[],
    sheet?: string
  ): Promise<TableMeta> {
    const count = await this.conn.query(`SELECT count(*)::DOUBLE AS n FROM ${id}`)
    const rowCount = Number(count.getChild('n')!.get(0))
    const columns: ColumnMeta[] = cols.map((c, i) => ({ id: `c${i}`, name: c.name, duckType: c.type, kind: kindOfDuckType(c.type) }))
    const sqlName = this.uniqueViewName(title)
    const viewSelect = columns.map((c) => `${c.id} AS ${quoteIdent(c.name)}`).join(', ')
    await this.conn.query(`CREATE VIEW ${quoteIdent(sqlName)} AS SELECT ${viewSelect} FROM ${id}`)
    const meta: TableMeta = { id, sqlName, title, source, rowCount, columns, importMs: performance.now() - t0, sheets, sheet }
    this.tables.set(id, meta)
    return meta
  }

  private uniqueViewName(title: string): string {
    const base =
      title
        .replace(/\.[^.]+$/, '')
        .replace(/[^\p{L}\p{N}_]+/gu, '_')
        .replace(/^_+|_+$/g, '')
        .toLowerCase() || 'data'
    const taken = new Set([...this.tables.values()].map((t) => t.sqlName))
    let name = /^\p{N}/u.test(base) ? `t_${base}` : base
    for (let i = 2; taken.has(name); i++) name = `${base}_${i}`
    return name
  }
}

function extOf(name: string): string {
  const m = /\.([^.]+)$/.exec(name)
  return m ? m[1]!.toLowerCase() : ''
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

function describeToColumns(t: ArrowTable): { name: string; type: string }[] {
  const names = t.getChild('column_name')!
  const types = t.getChild('column_type')!
  const out: { name: string; type: string }[] = []
  for (let i = 0; i < t.numRows; i++) out.push({ name: String(names.get(i)), type: String(types.get(i)) })
  return out
}

/** Grid cells: keep DOUBLE native, render everything else as DuckDB's exact text form. */
function displayExpr(c: ColumnMeta): string {
  if (c.duckType === 'DOUBLE' || c.kind === 'string') return c.id
  return `CAST(${c.id} AS VARCHAR)`
}

/** Plot values: numbers as DOUBLE, times as epoch seconds, booleans as 0/1. */
function numericExpr(c: ColumnMeta): string {
  switch (c.kind) {
    case 'time':
      return `(epoch_ms(CAST(${c.id} AS TIMESTAMP)) / 1000.0)`
    case 'bool':
      return `CAST(CAST(${c.id} AS INTEGER) AS DOUBLE)`
    case 'number':
      return `CAST(${c.id} AS DOUBLE)`
    default:
      return `TRY_CAST(${c.id} AS DOUBLE)`
  }
}

function isSorted(x: Float64Array): boolean {
  for (let i = 1; i < x.length; i++) if (x[i]! < x[i - 1]!) return false
  return true
}
