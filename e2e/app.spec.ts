import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveVersion } from '../scripts/version.mjs'

const SHOTS = process.env['SHOT_DIR'] ?? 'test-results/shots'
mkdirSync(SHOTS, { recursive: true })

// One app instance walks through the whole flow; later steps depend on earlier ones.
test.describe.configure({ mode: 'serial' })

let app: ElectronApplication
let page: Page
const logs: string[] = []

type DebugPlot = {
  mode: string
  sorted: boolean | null
  bounds: { xMin: number; xMax: number; yMin: number; yMax: number }
  width: number
  height: number
  over: { left: number; top: number; width: number; height: number }
  tips: { id: number; seriesId: string; index: number; row: number; x: number; y: number; px: number; py: number }[]
  stats: { phase: string; mode: string; total: number; visible: number; drawn: number; ms: number } | null
  series: { id: string; label: string; n: number }[]
}
type Debug = {
  tableId: string | null
  meta: { rowCount: number; sqlName: string; sheets?: string[]; sheet?: string; columns: { id: string; name: string; kind: string }[] } | null
  selection: { x: string | null; ys: string[]; mode: string | null } | null
  plots: DebugPlot[]
}

const debug = (): Promise<Debug> => page.evaluate(() => (window as any).__vernier.app.debug())

async function waitPlot(pred: (d: Debug) => boolean, timeout = 60_000): Promise<Debug> {
  await expect.poll(async () => pred(await debug()), { timeout, intervals: [50, 100, 250] }).toBe(true)
  // let the full-precision phase land
  await page.waitForTimeout(150)
  return debug()
}

function toClient(p: DebugPlot, x: number, y: number): [number, number] {
  const b = p.bounds
  return [p.over.left + ((x - b.xMin) / (b.xMax - b.xMin)) * p.width, p.over.top + p.height - ((y - b.yMin) / (b.yMax - b.yMin)) * p.height]
}

function toData(p: DebugPlot, cx: number, cy: number): [number, number] {
  const b = p.bounds
  return [b.xMin + ((cx - p.over.left) / p.width) * (b.xMax - b.xMin), b.yMin + ((p.over.top + p.height - cy) / p.height) * (b.yMax - b.yMin)]
}

async function openFile(path: string, timeout = 60_000): Promise<void> {
  const before = (await debug()).tableId
  await page.setInputFiles('#file-input', resolve(path))
  await expect.poll(async () => (await debug()).tableId !== before, { timeout, intervals: [100, 250] }).toBe(true)
}

test.beforeAll(async () => {
  // Fresh profile (so the default theme is observable) and a local update feed announcing v99.
  const profile = mkdtempSync(join(tmpdir(), 'vernier-e2e-'))
  const feed = join(profile, 'latest-release.json')
  writeFileSync(
    feed,
    JSON.stringify({
      tag_name: 'v99.0.0',
      html_url: 'https://github.com/Jelatine/vernier/releases/tag/v99.0.0',
      body: '- e2e 模拟的发布说明',
      published_at: '2026-09-15T00:00:00Z',
      assets: [{ name: 'Vernier-99.0.0-mac-arm64.dmg', browser_download_url: 'https://example.invalid/Vernier-99.0.0-mac-arm64.dmg' }]
    })
  )
  app = await electron.launch({
    args: [resolve('out/main/index.js')],
    env: { ...process.env, VERNIER_USER_DATA: profile, VERNIER_UPDATE_URL: pathToFileURL(feed).toString() }
  })
  page = await app.firstWindow()
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
  await page.setViewportSize({ width: 1440, height: 920 }).catch(() => undefined)
  await page.waitForFunction(() => (window as any).__vernier?.ready === true, null, { timeout: 60_000 })
})

test.afterAll(async () => {
  if (logs.length) console.log(logs.join('\n'))
  await app?.close()
})

test('security posture of the window', async () => {
  const prefs = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]!
    // Present at runtime but not in Electron's public typings.
    const p = (w.webContents as unknown as { getLastWebPreferences(): Electron.WebPreferences }).getLastWebPreferences()
    return { contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration, sandbox: p.sandbox, url: w.webContents.getURL() }
  })
  expect(prefs).toMatchObject({ contextIsolation: true, nodeIntegration: false, sandbox: true })
  expect(prefs.url.startsWith('app://vernier/')).toBe(true)
  expect(await page.evaluate(() => typeof (window as any).require)).toBe('undefined')
})

test('title bar, theme switching, about and update check', async () => {
  const version = resolveVersion()
  await expect(page.locator('.topbar')).toHaveCount(0)
  const bar = (await page.locator('#titlebar').boundingBox())!
  expect(bar.y).toBe(0)
  expect(bar.height).toBe(40)
  await expect(page.locator('#titlebar .tb-logo')).toBeVisible()
  expect(await page.evaluate(() => (document.querySelector('.tb-logo') as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  if (process.platform === 'darwin') {
    const brand = (await page.locator('.tb-brand').boundingBox())!
    expect(brand.x).toBeGreaterThanOrEqual(76) // clear of the traffic lights
  }

  // Default theme is light, for page and native chrome alike.
  const themeState = () => page.evaluate(() => [document.documentElement.dataset['theme'], document.documentElement.dataset['themeMode']])
  expect(await themeState()).toEqual(['light', 'light'])
  expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('light')

  await page.locator('#btn-theme').click()
  await expect(page.locator('#theme-menu')).toBeVisible()
  await page.locator('[data-theme-choice="dark"]').click()
  await expect.poll(themeState).toEqual(['dark', 'dark'])
  await expect(page.locator('#theme-menu')).toBeHidden()
  expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('dark')
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(13, 13, 13)')
  await page.screenshot({ path: join(SHOTS, '00-dark-empty.png') })
  await page.locator('#btn-theme').click()
  await page.locator('[data-theme-choice="light"]').click()
  await expect.poll(themeState).toEqual(['light', 'light'])
  expect(await page.evaluate(() => localStorage.getItem('vernier.theme'))).toBe('light')

  // Version from git tags in the status bar; update feed announces a newer release.
  await expect(page.locator('#sb-version')).toHaveText(`v${version}`)
  await expect(page.locator('#btn-update')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('#btn-update')).toContainText('99.0.0')

  await page.locator('#btn-about').click()
  const about = page.locator('#about')
  await expect(about).toBeVisible()
  await expect(about.locator('#about-version')).toHaveText(version)
  await expect(about.locator('#about-author')).toHaveText('Jelatine')
  await expect(about.locator('#about-author')).toHaveAttribute('href', 'https://github.com/Jelatine')
  await expect(about.locator('#about-repo')).toHaveAttribute('href', 'https://github.com/Jelatine/vernier')
  await expect(about.locator('#about-runtime')).toContainText('Electron')
  await expect(about.locator('#update-text')).toContainText('v99.0.0')
  // Unpackaged build can't self-install: the action is a download link.
  await expect(about.locator('#update-action')).toHaveText('前往下载')
  await expect(about.locator('#update-notes')).toBeVisible()
  await page.screenshot({ path: join(SHOTS, '00-about.png') })
  await page.keyboard.press('Escape')
  await expect(about).toBeHidden()
})

test('CSV → table preview → default plot', async () => {
  await openFile('samples/small.csv')
  const d = await waitPlot((d) => d.plots[0]?.stats?.phase === 'full')
  expect(d.meta!.rowCount).toBe(2000)
  expect(d.meta!.columns.map((c) => c.name)).toEqual(['time_s', 'sine', 'chirp', 'spiky', 'square_gaps', 'random_walk', 'label', 'timestamp', 'scatter_x', 'scatter_y'])
  expect(d.selection).toMatchObject({ x: 'c0', ys: ['c1'] })
  expect(d.plots[0]!.sorted).toBe(true)
  expect(d.plots[0]!.mode).toBe('line')
  await expect(page.locator('.ag-row[row-index="0"] .ag-cell[col-id="c0"]')).toHaveText('0')
  await expect(page.locator('.ag-row[row-index="3"] .ag-cell[col-id="c6"]')).toHaveText('alpha')
  await page.screenshot({ path: join(SHOTS, '01-small-csv.png') })
})

test('datatip snaps to the exact raw sample and follows zoom', async () => {
  let d = await debug()
  let p = d.plots[0]!
  // Click near sample 300 (steep part of the sine), a few pixels off the curve.
  const target = { x: 0.3, y: Number(Math.sin(2 * Math.PI * 0.5 * 0.3).toFixed(6)) }
  const [cx0, cy0] = toClient(p, target.x, target.y)
  const [cx, cy] = [cx0 + 2, cy0 + 5]
  await page.mouse.click(cx, cy)
  const clickedOn = p
  d = await waitPlot((d) => d.plots[0]!.tips.length === 1)
  p = d.plots[0]!
  // Pinning must not resize the axes (the curve would jump under the pointer).
  expect([p.over, p.bounds]).toEqual([clickedOn.over, clickedOn.bounds])
  const hit = p.tips[0]!
  // The tip must be the brute-force nearest raw sample to the click, with its exact raw values.
  const truth = await page.evaluate(
    async ({ px, py, b, w, h }) => {
      const v = (window as any).__vernier
      const s = await v.core.fetchSeries({ tableId: v.app.debug().tableId, x: 'c0', ys: ['c1'] })
      let best = Infinity
      let idx = -1
      for (let i = 0; i < s.x.length; i++) {
        const dx = ((s.x[i] - b.xMin) / (b.xMax - b.xMin)) * w - px
        const dy = h - ((s.ys[0][i] - b.yMin) / (b.yMax - b.yMin)) * h - py
        const dd = Math.hypot(dx, dy)
        if (dd < best) {
          best = dd
          idx = i
        }
      }
      return { idx, x: s.x[idx] as number, y: s.ys[0][idx] as number }
    },
    { px: cx - p.over.left, py: cy - p.over.top, b: p.bounds, w: p.width, h: p.height }
  )
  expect(Math.abs(hit.index - 300)).toBeLessThanOrEqual(8)
  expect(hit).toMatchObject({ index: truth.idx, row: truth.idx, x: truth.x, y: truth.y })
  const tipIndex = hit.index
  await expect(page.locator('.vn-tip [data-k="y"]')).toHaveText(String(truth.y))

  // wheel zoom, anchored at an arbitrary point
  // Pointer events carry whole-pixel coordinates; anchor on one so the check is exact.
  const ax = Math.round(p.over.left + p.width * 0.31)
  const ay = Math.round(p.over.top + p.height * 0.42)
  const before = toData(p, ax, ay)
  await page.mouse.move(ax, ay)
  for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -120)
  d = await waitPlot((d) => d.plots[0]!.stats?.phase === 'full' && d.plots[0]!.bounds.xMax - d.plots[0]!.bounds.xMin < (p.bounds.xMax - p.bounds.xMin) * 0.5)
  const z = d.plots[0]!
  const after = toData(z, ax, ay)
  expect(Math.abs(after[0] - before[0]) / (z.bounds.xMax - z.bounds.xMin)).toBeLessThan(1e-6)
  expect(Math.abs(after[1] - before[1]) / (z.bounds.yMax - z.bounds.yMin)).toBeLessThan(1e-6)

  // the tip is still on the same sample and its DOM marker sits at that sample's new pixel
  const tip = z.tips[0]!
  expect(tip.index).toBe(tipIndex)
  const [tx, ty] = toClient(z, truth.x, truth.y)
  const box = await page.locator('.vn-tip').first().boundingBox()
  if (tip.px >= 0 && tip.px <= z.width) {
    expect(Math.abs(box!.x - tx)).toBeLessThan(1.5)
    expect(Math.abs(box!.y - ty)).toBeLessThan(1.5)
  }
  await page.screenshot({ path: join(SHOTS, '02-zoomed-with-tip.png') })

  // ctrl+wheel zooms X only
  const yBefore = [z.bounds.yMin, z.bounds.yMax]
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -120)
  await page.keyboard.up('Control')
  d = await waitPlot((d) => d.plots[0]!.bounds.xMax - d.plots[0]!.bounds.xMin < z.bounds.xMax - z.bounds.xMin)
  expect([d.plots[0]!.bounds.yMin, d.plots[0]!.bounds.yMax]).toEqual(yBefore)
})

test('pan, box zoom, reset', async () => {
  let p = (await debug()).plots[0]!
  // pan in explore mode: the data under the grab point follows the pointer
  const sx = p.over.left + p.width * 0.5
  const sy = p.over.top + p.height * 0.5
  const grabbed = toData(p, sx, sy)
  await page.mouse.move(sx, sy)
  await page.mouse.down()
  await page.mouse.move(sx - 60, sy + 20, { steps: 6 })
  await page.mouse.move(sx - 120, sy + 40, { steps: 6 })
  await page.mouse.up()
  p = (await waitPlot((d) => d.plots[0]!.stats?.phase === 'full')).plots[0]!
  const now = toData(p, sx - 120, sy + 40)
  expect(now[0]).toBeCloseTo(grabbed[0], 6)
  expect(now[1]).toBeCloseTo(grabbed[1], 6)

  // box zoom tool
  await page.keyboard.press('z')
  const [x0, y0, x1, y1] = [p.over.left + 100, p.over.top + 40, p.over.left + 400, p.over.top + 160]
  const want = [toData(p, x0, y1), toData(p, x1, y0)]
  await page.mouse.move(x0, y0)
  await page.mouse.down()
  await page.mouse.move(x1, y1, { steps: 10 })
  await page.mouse.up()
  p = (await waitPlot((d) => d.plots[0]!.bounds.xMin !== p.bounds.xMin)).plots[0]!
  expect(p.bounds.xMin).toBeCloseTo(want[0]![0], 6)
  expect(p.bounds.xMax).toBeCloseTo(want[1]![0], 6)
  expect(p.bounds.yMin).toBeCloseTo(want[0]![1], 6)
  expect(p.bounds.yMax).toBeCloseTo(want[1]![1], 6)
  await page.keyboard.press('e')

  // double-click resets to the full extent (tight X for a sorted line)
  await page.mouse.dblclick(p.over.left + 200, p.over.top + 100)
  p = (await waitPlot((d) => Math.abs(d.plots[0]!.bounds.xMax - 1.999) < 1e-9)).plots[0]!
  expect(p.bounds.xMin).toBe(0)
})

test('1M-row CSV: M4 rendering, datatip hits the true spike, table reveals row', async () => {
  const t0 = Date.now()
  await openFile('samples/signals_1m.csv', 90_000)
  let d = await waitPlot((d) => d.plots[0]?.stats?.total === 1_000_000 && d.plots[0]!.stats!.phase === 'full', 90_000)
  const importMs = Date.now() - t0
  console.log(`1M import+plot: ${importMs} ms, status: ${await page.locator('#status').textContent()}`)
  expect(d.meta!.rowCount).toBe(1_000_000)

  // swap Y: sine off, spiky on
  await page.locator('.col-item[data-id="c3"] .pick-y').click()
  await page.locator('.col-item[data-id="c1"] .pick-y').click()
  d = await waitPlot((d) => d.selection!.ys.join() === 'c3' && d.plots[0]!.series[0]?.id === 'c3' && d.plots[0]!.stats?.phase === 'full')
  let p = d.plots[0]!
  expect(p.stats!.mode).toBe('m4')
  expect(p.stats!.visible).toBe(1_000_000)
  expect(p.stats!.drawn).toBeLessThan(p.width * 2 * 4 + 10)
  await page.screenshot({ path: join(SHOTS, '03-1m-m4.png') })

  // spike at row 5000 (t = 5.000 s, y ≈ 25). Click slightly off its apex.
  const spikeY = await page.evaluate(async () => {
    const core = (window as any).__vernier.core
    const s = await core.fetchSeries({ tableId: (window as any).__vernier.app.debug().tableId, x: 'c0', ys: ['c3'] })
    return s.ys[0][5000] as number
  })
  expect(spikeY).toBeGreaterThan(20)
  const [cx, cy] = toClient(p, 5, spikeY)
  await page.mouse.click(cx + 2, cy + 6)
  d = await waitPlot((d) => d.plots[0]!.tips.length === 1)
  p = d.plots[0]!
  expect(p.tips[0]).toMatchObject({ index: 5000, row: 5000, x: 5, y: spikeY })

  // the tip's row is revealed in the table
  await expect(page.locator('.ag-row[row-index="5000"] .ag-cell[col-id="c3"]')).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.ag-row[row-index="5000"] .ag-cell[col-id="c0"]')).toHaveText('5')

  // interactive zoom goes through the coarse phase, then settles at full precision
  const phases: string[] = []
  const hx = p.over.left + p.width * 0.2
  const hy = p.over.top + p.height * 0.5
  await page.mouse.move(hx, hy)
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, -100)
    phases.push((await debug()).plots[0]!.stats!.phase)
  }
  d = await waitPlot((d) => d.plots[0]!.stats?.phase === 'full')
  expect(phases).toContain('coarse')
  const frameMs = d.plots[0]!.stats!.ms
  console.log(`full-precision frame after zoom: ${frameMs.toFixed(1)} ms, drawn ${d.plots[0]!.stats!.drawn}`)
  await page.screenshot({ path: join(SHOTS, '04-1m-zoomed.png') })
})

test('stacked layout links X across axes', async () => {
  await page.locator('.col-item[data-id="c2"] .pick-y').click()
  await page.locator('[data-layout="stack"]').click()
  let d = await waitPlot((d) => d.plots.length === 2 && d.plots.every((p) => p.stats?.phase === 'full'))
  const p0 = d.plots[0]!
  await page.mouse.move(p0.over.left + p0.width * 0.6, p0.over.top + p0.height * 0.5)
  await page.mouse.wheel(0, -300)
  d = await waitPlot((d) => d.plots[0]!.bounds.xMax !== p0.bounds.xMax)
  expect(d.plots[1]!.bounds.xMin).toBeCloseTo(d.plots[0]!.bounds.xMin, 9)
  expect(d.plots[1]!.bounds.xMax).toBeCloseTo(d.plots[0]!.bounds.xMax, 9)
  await page.screenshot({ path: join(SHOTS, '05-stacked.png') })
  await page.locator('[data-layout="overlay"]').click()
  await waitPlot((d) => d.plots.length === 1)
})

test('SQL over the loaded data becomes a new dataset', async () => {
  const d0 = await debug()
  await page.locator('#sql-input').fill(`SELECT label, count(*) AS n, avg(random_walk) AS mean_walk, max(spiky) AS max_spike FROM ${d0.meta!.sqlName} GROUP BY label ORDER BY label`)
  await page.locator('#btn-sql').click()
  const d = await waitPlot((d) => d.tableId !== d0.tableId && d.meta?.rowCount === 3)
  expect(d.meta!.columns.map((c) => c.name)).toEqual(['label', 'n', 'mean_walk', 'max_spike'])
  await expect(page.locator('.ag-row[row-index="1"] .ag-cell[col-id="c0"]')).toHaveText('beta')
  await expect(page.locator('.ag-row[row-index="0"] .ag-cell[col-id="c1"]')).toHaveText('333334')
})

test('XLSX: sheets, types, unsorted X → scatter/polyline with 2-D snapping', async () => {
  await openFile('samples/workbook.xlsx')
  let d = await waitPlot((d) => d.meta?.sheets?.length === 2 && (d.plots[0]?.stats?.phase === 'full' || d.selection!.ys.length === 0))
  expect(d.meta!.rowCount).toBe(20_000)
  expect(d.meta!.columns.map((c) => [c.name, c.kind])).toEqual([
    ['日期', 'time'],
    ['温度 (°C)', 'number'],
    ['压力 kPa', 'number'],
    ['状态', 'bool'],
    ['备注', 'string'],
    ['lissajous_x', 'number'],
    ['lissajous_y', 'number']
  ])
  expect(d.selection).toMatchObject({ x: 'c0', ys: ['c1'] })
  await expect(page.locator('#sheet-select option')).toHaveCount(2)
  await page.screenshot({ path: join(SHOTS, '06-xlsx-time.png') })

  await page.locator('.col-item[data-id="c5"] .pick-x').click()
  await page.locator('.col-item[data-id="c6"] .pick-y').click()
  await page.locator('.col-item[data-id="c1"] .pick-y').click()
  d = await waitPlot((d) => d.selection!.x === 'c5' && d.selection!.ys.join() === 'c6' && d.plots[0]?.series[0]?.id === 'c6' && d.plots[0]!.stats?.phase === 'full')
  let p = d.plots[0]!
  expect(p.sorted).toBe(false)
  expect(p.mode).toBe('scatter')
  expect(p.stats!.mode).toBe('raster')
  // Changing X then Y quickly must re-home the view on the new X (regression: kept old X range).
  expect(p.bounds.xMin).toBeLessThan(-1)
  expect(p.bounds.xMax).toBeGreaterThan(1)
  expect(p.stats!.drawn).toBeGreaterThan(1000)

  // click near a known sample and verify the tip is the true 2-D nearest raw point
  const sample = await page.evaluate(async () => {
    const v = (window as any).__vernier
    const s = await v.core.fetchSeries({ tableId: v.app.debug().tableId, x: 'c5', ys: ['c6'] })
    return { x: s.x[7777] as number, y: s.ys[0][7777] as number }
  })
  const [cx, cy] = toClient(p, sample.x, sample.y)
  await page.mouse.click(cx, cy)
  d = await waitPlot((d) => d.plots[0]!.tips.length === 1)
  p = d.plots[0]!
  const t = p.tips[0]!
  expect(Math.hypot(t.px - (cx - p.over.left), t.py - (cy - p.over.top))).toBeLessThan(1)

  await page.locator('[data-mode="line"]').click()
  d = await waitPlot((d) => d.plots[0]!.stats?.mode === 'polyline')
  await page.screenshot({ path: join(SHOTS, '07-xlsx-lissajous.png') })

  await page.locator('#sheet-select').selectOption('Sheet2')
  d = await waitPlot((d) => d.meta?.sheet === 'Sheet2' && d.meta.rowCount === 2)
  expect(d.meta!.columns.map((c) => c.name)).toEqual(['k', 'v'])
})

test('dark theme with data re-renders grid and plot', async () => {
  await page.locator('#btn-theme').click()
  await page.locator('[data-theme-choice="dark"]').click()
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset['theme'])).toBe('dark')
  const d = await waitPlot((d) => d.plots[0]?.stats?.phase === 'full')
  expect(d.plots.length).toBeGreaterThan(0)
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(SHOTS, '08-dark-with-data.png') })
  await page.locator('#btn-theme').click()
  await page.locator('[data-theme-choice="light"]').click()
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset['theme'])).toBe('light')
})

test('no renderer errors', async () => {
  const errors = logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]'))
  expect(errors).toEqual([])
})
