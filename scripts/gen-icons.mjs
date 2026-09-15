// Renders the Vernier logo into every icon format the app and installers need.
// Usage: node scripts/gen-icons.mjs   (icon.icns is only produced on macOS, via iconutil)
import { Resvg } from '@resvg/resvg-js'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ORANGE = '#eb6834'

/**
 * The mark: a signal trace on a blue plate, a pinned datatip (orange) and its dashed cursor
 * dropping onto a vernier scale. Drawn in an 824-unit inner box so variants only change the
 * outer margin; `detail: false` drops the scale for tiny sizes and thickens strokes.
 */
export function logoSvg({ margin = 100, radius = 185, shadow = false, detail = true } = {}) {
  const inner = 1024 - margin * 2
  const k = inner / 824
  const t = (x, y) => `${(margin + x * k).toFixed(1)} ${(margin + y * k).toFixed(1)}`
  const u = (v) => (v * k).toFixed(1)

  const stroke = detail ? 54 : 82
  // The datatip sits exactly over scale tick 7: the cursor "reads" the vernier.
  const TICK = 58.8
  const READ = 7
  const readX = 118 + READ * TICK
  const pts = detail
    ? [[118, 548], [256, 372], [382, 458], [readX, 236], [706, 352]]
    : [[118, 586], [262, 372], [390, 480], [540, 238], [706, 356]]
  const tip = pts[3]
  const curve = `M ${pts.map(([x, y]) => t(x, y)).join(' L ')}`

  const ticks = []
  let readTick = ''
  if (detail) {
    for (let i = 0; i <= 10; i++) {
      const x = 118 + i * TICK
      const h = i % 5 === 0 ? 70 : 40
      const line = `<line x1="${t(x, 716).split(' ')[0]}" y1="${t(0, 716 - h).split(' ')[1]}" x2="${t(x, 716).split(' ')[0]}" y2="${t(0, 716).split(' ')[1]}"/>`
      if (i === READ) {
        readTick = `<line x1="${t(x, 0).split(' ')[0]}" y1="${t(0, 716 - 82).split(' ')[1]}" x2="${t(x, 0).split(' ')[0]}" y2="${t(0, 716).split(' ')[1]}" stroke="${ORANGE}" stroke-width="${u(16)}" stroke-linecap="round"/>`
      } else {
        ticks.push(line)
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <linearGradient id="plate" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#4196f5"/>
      <stop offset="1" stop-color="#1a4ca8"/>
    </linearGradient>
    <linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.2"/>
      <stop offset="0.55" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>${
      shadow
        ? `
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="125%">
      <feDropShadow dx="0" dy="${u(14)}" stdDeviation="${u(16)}" flood-color="#0b1a3a" flood-opacity="0.32"/>
    </filter>`
        : ''
    }
  </defs>
  <g${shadow ? ' filter="url(#shadow)"' : ''}>
    <rect x="${margin}" y="${margin}" width="${inner}" height="${inner}" rx="${u(radius)}" fill="url(#plate)"/>
  </g>
  <rect x="${margin}" y="${margin}" width="${inner}" height="${inner}" rx="${u(radius)}" fill="url(#gloss)"/>${
    detail
      ? `
  <g stroke="#ffffff" stroke-opacity="0.5" stroke-width="${u(12)}" stroke-linecap="round">
    <line x1="${t(118, 716).split(' ')[0]}" y1="${t(0, 716).split(' ')[1]}" x2="${t(706, 716).split(' ')[0]}" y2="${t(0, 716).split(' ')[1]}"/>
    ${ticks.join('\n    ')}
  </g>
  <line x1="${t(tip[0], 0).split(' ')[0]}" y1="${t(0, tip[1]).split(' ')[1]}" x2="${t(tip[0], 0).split(' ')[0]}" y2="${t(0, 716).split(' ')[1]}" stroke="#ffffff" stroke-opacity="0.75" stroke-width="${u(12)}" stroke-linecap="round" stroke-dasharray="${u(2)} ${u(26)}"/>
  ${readTick}`
      : ''
  }
  <path d="${curve}" fill="none" stroke="#ffffff" stroke-width="${u(stroke)}" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="${t(tip[0], 0).split(' ')[0]}" cy="${t(0, tip[1]).split(' ')[1]}" r="${u(detail ? 60 : 84)}" fill="${ORANGE}" stroke="#ffffff" stroke-width="${u(detail ? 22 : 30)}"/>
</svg>
`
}

function render(svg, size) {
  const img = new Resvg(svg, { fitTo: { mode: 'width', value: size }, background: 'rgba(0,0,0,0)' }).render()
  return { size, png: img.asPng(), rgba: img.pixels }
}

/** 32-bit BMP (DIB) icon entry; uncompressed entries are the most compatible (incl. NSIS). */
function dibEntry(size, rgba) {
  const maskRow = Math.ceil(size / 32) * 4
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8)
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  header.writeUInt32LE(size * size * 4 + maskRow * size, 20)
  const px = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const s = ((size - 1 - y) * size + x) * 4
      const d = (y * size + x) * 4
      px[d] = rgba[s + 2]
      px[d + 1] = rgba[s + 1]
      px[d + 2] = rgba[s]
      px[d + 3] = rgba[s + 3]
    }
  }
  return Buffer.concat([header, px, Buffer.alloc(maskRow * size)])
}

export function buildIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  let offset = 6 + 16 * images.length
  const dir = []
  const blobs = []
  for (const { size, rgba } of images) {
    const blob = dibEntry(size, rgba)
    const e = Buffer.alloc(16)
    e.writeUInt8(size >= 256 ? 0 : size, 0)
    e.writeUInt8(size >= 256 ? 0 : size, 1)
    e.writeUInt16LE(1, 4)
    e.writeUInt16LE(32, 6)
    e.writeUInt32LE(blob.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += blob.length
    dir.push(e)
    blobs.push(blob)
  }
  return Buffer.concat([header, ...dir, ...blobs])
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mac = (size) => logoSvg({ margin: 100, shadow: size >= 128, detail: size > 32 })
  const tight = (size) => logoSvg({ margin: 36, radius: 200, detail: size > 48 })

  mkdirSync('build/icons', { recursive: true })
  mkdirSync('resources', { recursive: true })
  mkdirSync('src/renderer/src/assets', { recursive: true })

  writeFileSync('build/icon.svg', mac(1024))
  writeFileSync('build/icon.png', render(mac(1024), 1024).png)
  writeFileSync('src/renderer/src/assets/logo.svg', logoSvg({ margin: 36, radius: 200, detail: true }))
  writeFileSync('src/renderer/src/assets/logo-mark.svg', logoSvg({ margin: 36, radius: 200, detail: false }))
  writeFileSync('resources/icon.png', render(tight(512), 512).png)

  for (const size of [16, 24, 32, 48, 64, 128, 256, 512]) {
    writeFileSync(`build/icons/${size}x${size}.png`, render(tight(size), size).png)
  }

  const icoSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
  writeFileSync('build/icon.ico', buildIco(icoSizes.map((s) => render(tight(s), s))))

  if (process.platform === 'darwin') {
    const dir = mkdtempSync(join(tmpdir(), 'vernier-icon-'))
    const set = join(dir, 'icon.iconset')
    mkdirSync(set)
    for (const base of [16, 32, 128, 256, 512]) {
      writeFileSync(join(set, `icon_${base}x${base}.png`), render(mac(base), base).png)
      writeFileSync(join(set, `icon_${base}x${base}@2x.png`), render(mac(base * 2), base * 2).png)
    }
    execFileSync('iconutil', ['-c', 'icns', set, '-o', 'build/icon.icns'])
    rmSync(dir, { recursive: true, force: true })
  }
  console.log('icons written: build/icon.{svg,png,ico,icns}, build/icons/*.png, resources/icon.png, renderer assets')
}
