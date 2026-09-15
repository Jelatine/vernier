export type XKind = 'number' | 'time' | 'row'

const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

export function formatInt(v: number): string {
  return nf.format(v)
}

/** Datatip precision: up to 7 significant digits, exponent for very large/small magnitudes. */
export function formatNumber(v: number, digits = 7): string {
  if (!Number.isFinite(v)) return String(v)
  if (v === 0) return '0'
  const a = Math.abs(v)
  if (a >= 1e9 || a < 1e-5) return v.toExponential(digits - 1).replace(/\.?0+e/, 'e')
  return String(Number(v.toPrecision(digits)))
}

/** Epoch seconds -> "YYYY-MM-DD HH:MM:SS(.mmm)" in UTC, matching DuckDB's naive timestamp text. */
export function formatTime(sec: number): string {
  const d = new Date(sec * 1000)
  if (Number.isNaN(d.getTime())) return String(sec)
  const iso = d.toISOString().replace('T', ' ').replace('Z', '')
  return iso.endsWith('.000') ? iso.slice(0, -4) : iso
}

export function formatX(v: number, kind: XKind): string {
  if (kind === 'time') return formatTime(v)
  if (kind === 'row') return formatInt(v + 1)
  return formatNumber(v)
}

export function formatCount(n: number): string {
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)} 亿`
  if (n >= 1e4) return `${(n / 1e4).toFixed(n >= 1e6 ? 0 : 1)} 万`
  return formatInt(n)
}
