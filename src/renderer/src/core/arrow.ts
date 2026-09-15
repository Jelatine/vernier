import type { Data, Vector } from 'apache-arrow'
import type { Cell, ColumnKind } from './types'

function isValid(data: Data, i: number): boolean {
  const bitmap = data.nullBitmap
  if (!bitmap || bitmap.length === 0 || data.nullCount === 0) return true
  const bit = data.offset + i
  return (bitmap[bit >> 3]! & (1 << (bit & 7))) !== 0
}

/**
 * Arrow column -> Float64Array with NaN for nulls. A single null-free Float64 chunk is
 * returned as a view onto the Arrow buffer (no copy).
 */
export function vectorToFloat64(vec: Vector): Float64Array {
  const chunks = vec.data
  if (chunks.length === 1) {
    const d = chunks[0]!
    if (d.values instanceof Float64Array && d.nullCount === 0 && d.values.length === d.length) {
      return d.values
    }
  }
  const out = new Float64Array(vec.length)
  let o = 0
  for (const d of chunks) {
    const values = d.values as ArrayLike<number | bigint>
    const noNulls = d.nullCount === 0
    for (let i = 0; i < d.length; i++, o++) {
      if (!noNulls && !isValid(d, i)) {
        out[o] = NaN
        continue
      }
      const v = values[i]!
      out[o] = typeof v === 'bigint' ? Number(v) : v
    }
  }
  return out
}

/** Arrow column -> display cells for the table view (only ever called on a visible block). */
export function vectorToCells(vec: Vector): Cell[] {
  const out = new Array<Cell>(vec.length)
  for (let i = 0; i < vec.length; i++) {
    const v = vec.get(i) as unknown
    if (v == null) out[i] = null
    else if (typeof v === 'number' || typeof v === 'string') out[i] = v
    else if (typeof v === 'bigint') out[i] = v.toString()
    else out[i] = String(v)
  }
  return out
}

export function kindOfDuckType(t: string): ColumnKind {
  const u = t.toUpperCase()
  if (/^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|DOUBLE|REAL)$/.test(u)) return 'number'
  if (u.startsWith('DECIMAL')) return 'number'
  if (u === 'DATE' || u.startsWith('TIMESTAMP')) return 'time'
  if (u === 'BOOLEAN') return 'bool'
  if (u === 'VARCHAR' || u.startsWith('ENUM')) return 'string'
  return 'other'
}
