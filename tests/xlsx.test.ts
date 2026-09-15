import { tableFromIPC } from 'apache-arrow'
import { existsSync, readFileSync } from 'node:fs'
import * as XLSX from 'xlsx'
import { describe, expect, it } from 'vitest'
import { vectorToCells, vectorToFloat64 } from '../src/renderer/src/core/arrow'
import { convertWorkbook, excelDateMs } from '../src/renderer/src/core/xlsxConvert'

function workbook(): Uint8Array {
  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.aoa_to_sheet(
    [
      ['t', 'value', 'flag', 'note', 'value', null],
      [new Date(Date.UTC(2025, 0, 1)), 1.5, true, '甲', 10, 'x'],
      [new Date(Date.UTC(2025, 0, 2)), null, false, null, 11, 3],
      [new Date(Date.UTC(2025, 0, 3)), -2, null, '甲', 12, 'y']
    ],
    { cellDates: true, UTC: true }
  )
  XLSX.utils.book_append_sheet(wb, ws, 'data')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['a'], [1]]), 'other')
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as Uint8Array
}

describe('convertWorkbook', () => {
  it('builds typed, nullable, dictionary-encoded Arrow columns', () => {
    const res = convertWorkbook(new Uint8Array(workbook()))
    expect(res.sheets).toEqual(['data', 'other'])
    expect(res.rows).toBe(3)
    expect(res.names).toEqual(['t', 'value', 'flag', 'note', 'value_1', 'Column6'])
    expect(res.casts).toEqual({ c0: 'time', c2: 'bool' })

    const t = tableFromIPC(res.ipc)
    expect(t.numRows).toBe(3)
    expect(Array.from(vectorToFloat64(t.getChild('c0')!))).toEqual([Date.UTC(2025, 0, 1), Date.UTC(2025, 0, 2), Date.UTC(2025, 0, 3)])
    expect(Array.from(vectorToFloat64(t.getChild('c1')!))).toEqual([1.5, NaN, -2])
    expect(t.getChild('c2')!.nullCount).toBe(1)
    expect(Array.from(vectorToFloat64(t.getChild('c2')!))).toEqual([1, 0, NaN])
    const note = t.getChild('c3')!
    expect(String(note.type)).toContain('Dictionary')
    expect(vectorToCells(note)).toEqual(['甲', null, '甲'])
    // mixed number/text column falls back to text
    expect(vectorToCells(t.getChild('c5')!)).toEqual(['x', '3', 'y'])
  })

  it('snaps float-serial datetimes back to whole seconds', () => {
    const aoa: unknown[][] = [['t']]
    for (let i = 0; i < 2_000; i++) aoa.push([new Date(Date.UTC(2025, 0, 1, 0, i, i % 60))])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa, { cellDates: true, UTC: true }), 's')
    const res = convertWorkbook(new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as Uint8Array))
    const got = vectorToFloat64(tableFromIPC(res.ipc).getChild('c0')!)
    for (let i = 0; i < 2_000; i++) expect(got[i]).toBe(Date.UTC(2025, 0, 1, 0, i, i % 60))
    // genuine sub-second values are left alone
    expect(excelDateMs(new Date(1_000_250))).toBe(1_000_250)
  })

  it('selects a named sheet', () => {
    const res = convertWorkbook(new Uint8Array(workbook()), 'other')
    expect(res.sheet).toBe('other')
    expect(res.names).toEqual(['a'])
    expect(res.rows).toBe(1)
  })

  it.skipIf(!existsSync('samples/workbook.xlsx'))('converts the generated sample workbook', () => {
    const res = convertWorkbook(new Uint8Array(readFileSync('samples/workbook.xlsx')))
    expect(res.rows).toBe(20_000)
    expect(res.names[1]).toBe('温度 (°C)')
    const p = tableFromIPC(res.ipc).getChild('c2')!
    expect(p.nullCount).toBe(40)
  })
})
