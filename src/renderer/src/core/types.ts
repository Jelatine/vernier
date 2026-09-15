/**
 * The contract between layers. The table UI and the plot engine never exchange row objects
 * with each other; they only pass these references around and ask the data core to
 * materialize exactly what they need (a block of display cells, or typed columns).
 */
export type TableId = string
export type ColumnId = string

export type ColumnKind = 'number' | 'time' | 'bool' | 'string' | 'other'

export interface ColumnMeta {
  id: ColumnId
  name: string
  duckType: string
  kind: ColumnKind
}

export interface TableMeta {
  id: TableId
  /** Friendly view name usable in SQL (original column names). */
  sqlName: string
  title: string
  source: 'csv' | 'xlsx' | 'parquet' | 'query'
  rowCount: number
  columns: ColumnMeta[]
  importMs: number
  sheets?: string[]
  sheet?: string
}

export interface ColumnRef {
  tableId: TableId
  columnId: ColumnId
}

/** Half-open row index range [start, end) in table order. */
export interface RowRange {
  start: number
  end: number
}

export type Cell = string | number | null

export interface RowBlock {
  range: RowRange
  /** One array per requested column, each `range.end - range.start` long. */
  columns: Record<ColumnId, Cell[]>
}

export interface SeriesRequest {
  tableId: TableId
  /** null = use the row index as X. */
  x: ColumnId | null
  ys: ColumnId[]
}

export interface SeriesColumns {
  x: Float64Array
  ys: Float64Array[]
  /** Original table row index of every sample (rows with an invalid X are dropped). */
  row: Float64Array
  /** X is non-decreasing. */
  sorted: boolean
  fetchMs: number
}

export function isPlottable(kind: ColumnKind): boolean {
  return kind === 'number' || kind === 'time' || kind === 'bool'
}
