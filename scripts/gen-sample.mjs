// Generates sample data: samples/signals_1m.csv (1,000,000 rows), samples/small.csv and
// samples/workbook.xlsx. Usage: node scripts/gen-sample.mjs [rows]
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import * as XLSX from 'xlsx'

const rows = Number(process.argv[2] ?? 1_000_000)
mkdirSync('samples', { recursive: true })

let seed = 12345
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand())

function row(i, walk) {
  const t = i * 0.001
  const sine = Math.sin(2 * Math.PI * 0.5 * t)
  const chirp = Math.sin(2 * Math.PI * (0.1 + 0.02 * t) * t) + 0.15 * gauss()
  // occasional single-sample spikes: the classic thing naive decimation hides
  const spiky = 0.2 * gauss() + (i % 99_991 === 5_000 ? 25 : 0)
  const gappy = Math.floor(t / 50) % 7 === 3 ? '' : (Math.floor(t / 25) % 2).toFixed(0)
  const label = ['alpha', 'beta', 'gamma'][i % 3]
  const ts = new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString().replace('T', ' ').replace('Z', '')
  const sx = gauss()
  const sy = 0.6 * sx + 0.8 * gauss()
  return [t.toFixed(3), sine.toFixed(6), chirp.toFixed(6), spiky.toFixed(6), gappy, walk.toFixed(4), label, ts, sx.toFixed(5), sy.toFixed(5)]
}

const header = ['time_s', 'sine', 'chirp', 'spiky', 'square_gaps', 'random_walk', 'label', 'timestamp', 'scatter_x', 'scatter_y']

async function writeCsv(path, n) {
  const out = createWriteStream(path)
  out.write(header.join(',') + '\n')
  let walk = 0
  let buf = []
  for (let i = 0; i < n; i++) {
    walk += gauss() * 0.01
    buf.push(row(i, walk).join(','))
    if (buf.length === 10_000) {
      if (!out.write(buf.join('\n') + '\n')) await once(out, 'drain')
      buf = []
    }
  }
  if (buf.length) out.write(buf.join('\n') + '\n')
  out.end()
  await once(out, 'finish')
  console.log(`wrote ${path} (${n} rows)`)
}

await writeCsv('samples/small.csv', 2_000)
await writeCsv(`samples/signals_${rows >= 1e6 ? rows / 1e6 + 'm' : rows}.csv`, rows)

// XLSX: mixed types, real dates, a second sheet, a lissajous (unsorted X) curve.
const aoa = [['日期', '温度 (°C)', '压力 kPa', '状态', '备注', 'lissajous_x', 'lissajous_y']]
for (let i = 0; i < 20_000; i++) {
  const th = (i / 20_000) * 2 * Math.PI * 3
  aoa.push([
    new Date(Date.UTC(2025, 0, 1, 0, i)),
    20 + 5 * Math.sin(i / 300) + gauss() * 0.3,
    i % 500 === 0 ? null : 101.3 + gauss() * 0.4,
    i % 11 === 0,
    i % 1000 === 0 ? `检查点 ${i / 1000}` : null,
    Math.sin(3 * th),
    Math.sin(2 * th)
  ])
}
const wb = XLSX.utils.book_new()
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa, { cellDates: true, UTC: true }), '传感器')
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['k', 'v'], ['a', 1], ['b', 2]]), 'Sheet2')
writeFileSync('samples/workbook.xlsx', XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))
console.log('wrote samples/workbook.xlsx')
