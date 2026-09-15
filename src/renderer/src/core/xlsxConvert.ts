import * as XLSX from 'xlsx'
import { Dictionary, Float64, Int32, Int8, Table, Utf8, makeData, makeVector, tableToIPC, type Vector } from 'apache-arrow'

/**
 * Worksheet -> Arrow columns. Columns are assembled directly from typed buffers with
 * makeData (Arrow's builders compile code with `new Function`, which our CSP forbids):
 * numbers -> Float64, text -> Dictionary<Utf8, Int32>, dates -> Float64 epoch-ms and
 * booleans -> Int8, the last two re-typed inside DuckDB via `casts`.
 */
export type CastKind = 'time' | 'bool'

export interface XlsxConverted {
  ipc: Uint8Array
  names: string[]
  casts: Record<string, CastKind>
  sheets: string[]
  sheet: string
  rows: number
}

type Kind = 'number' | 'time' | 'bool' | 'string'
type Grid = (XLSX.CellObject | undefined)[][]

export function convertWorkbook(bytes: Uint8Array, wanted?: string): XlsxConverted {
  const wb = XLSX.read(bytes, { type: 'array', dense: true, cellDates: true, cellHTML: false, cellFormula: false, cellStyles: false })
  const sheets = wb.SheetNames
  const sheet = wanted && sheets.includes(wanted) ? wanted : sheets[0]
  if (!sheet) throw new Error('工作簿中没有工作表')
  const ws = wb.Sheets[sheet]!
  const grid = (ws['!data'] ?? []) as Grid
  if (!ws['!ref'] || grid.length === 0) {
    return { ipc: tableToIPC(new Table({}), 'stream'), names: [], casts: {}, sheets, sheet, rows: 0 }
  }
  const range = XLSX.utils.decode_range(ws['!ref'])
  const headerRow = range.s.r
  const r0 = headerRow + 1
  const rows = Math.max(0, range.e.r - headerRow)

  const names: string[] = []
  const used = new Map<string, number>()
  const vectors: Record<string, Vector> = {}
  const casts: Record<string, CastKind> = {}

  for (let c = range.s.c, ci = 0; c <= range.e.c; c++, ci++) {
    const head = grid[headerRow]?.[c]
    const text = head && head.v != null ? String(head.w ?? head.v).trim() : ''
    let name = text || `Column${c + 1}`
    const seen = used.get(name) ?? 0
    used.set(name, seen + 1)
    if (seen) name = `${name}_${seen}`
    names.push(name)

    const id = `c${ci}`
    const kind = inferKind(grid, c, r0, range.e.r)
    vectors[id] = buildVector(grid, c, r0, rows, kind)
    if (kind === 'time' || kind === 'bool') casts[id] = kind
  }
  return { ipc: tableToIPC(new Table(vectors), 'stream'), names, casts, sheets, sheet, rows }
}

/**
 * Excel stores datetimes as fractional days; the float round-trip truncates e.g. 00:02:00 to
 * 00:01:59.999. Snap to the whole second when within 1 ms of it.
 */
export function excelDateMs(d: Date): number {
  const t = d.getTime()
  const s = Math.round(t / 1000) * 1000
  return Math.abs(t - s) <= 1 ? s : t
}

function isEmpty(cell: XLSX.CellObject | undefined): boolean {
  return !cell || cell.t === 'z' || cell.v == null || (cell.t === 's' && String(cell.v).trim() === '')
}

function inferKind(grid: Grid, c: number, r0: number, r1: number): Kind {
  let kind: Kind | null = null
  for (let r = r0; r <= r1; r++) {
    const cell = grid[r]?.[c]
    if (isEmpty(cell)) continue
    const k: Kind = cell!.t === 'n' ? 'number' : cell!.t === 'd' ? 'time' : cell!.t === 'b' ? 'bool' : 'string'
    if (kind === null) kind = k
    else if (kind !== k) return 'string'
  }
  return kind ?? 'string'
}

function buildVector(grid: Grid, c: number, r0: number, n: number, kind: Kind): Vector {
  const validity = new Uint8Array((n + 7) >> 3)
  let nullCount = 0
  const cellAt = (i: number): XLSX.CellObject | undefined => {
    const cell = grid[r0 + i]?.[c]
    if (isEmpty(cell)) {
      nullCount++
      return undefined
    }
    validity[i >> 3]! |= 1 << (i & 7)
    return cell
  }

  if (kind === 'number' || kind === 'time') {
    const data = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      const cell = cellAt(i)
      data[i] = cell ? (kind === 'time' ? excelDateMs(cell.v as Date) : (cell.v as number)) : NaN
    }
    return makeVector(makeData({ type: new Float64(), length: n, nullCount, nullBitmap: nullCount ? validity : null, data }))
  }
  if (kind === 'bool') {
    const data = new Int8Array(n)
    for (let i = 0; i < n; i++) {
      const cell = cellAt(i)
      data[i] = cell && cell.v ? 1 : 0
    }
    return makeVector(makeData({ type: new Int8(), length: n, nullCount, nullBitmap: nullCount ? validity : null, data }))
  }

  // Dictionary-encoded text.
  const indices = new Int32Array(n)
  const lookup = new Map<string, number>()
  const dict: string[] = []
  for (let i = 0; i < n; i++) {
    const cell = cellAt(i)
    if (!cell) continue
    const s = String(cell.w ?? cell.v)
    let k = lookup.get(s)
    if (k === undefined) {
      k = dict.length
      lookup.set(s, k)
      dict.push(s)
    }
    indices[i] = k
  }
  const enc = new TextEncoder()
  const encoded = dict.map((s) => enc.encode(s))
  const offsets = new Int32Array(dict.length + 1)
  for (let k = 0; k < encoded.length; k++) offsets[k + 1] = offsets[k]! + encoded[k]!.length
  const bytes = new Uint8Array(offsets[dict.length]!)
  encoded.forEach((b, k) => bytes.set(b, offsets[k]!))
  const dictionary = makeVector(makeData({ type: new Utf8(), length: dict.length, nullCount: 0, valueOffsets: offsets, data: bytes }))
  const type = new Dictionary(new Utf8(), new Int32())
  return makeVector(makeData({ type, length: n, nullCount, nullBitmap: nullCount ? validity : null, data: indices, dictionary }))
}
