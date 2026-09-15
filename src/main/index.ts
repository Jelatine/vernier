import { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, net, protocol, shell } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { basename, extname, join, normalize, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AUTHOR, AUTHOR_URL, REPOSITORY, isThemeSource, type AppInfo, type ThemeSource } from '../shared/types'
import { Updater } from './updater'

const VERSION = __APP_VERSION__
const isMac = process.platform === 'darwin'
const TITLEBAR_HEIGHT = 40

app.setName('Vernier')
if (process.env['VERNIER_USER_DATA']) app.setPath('userData', process.env['VERNIER_USER_DATA'])

// The renderer is served from a privileged custom scheme rather than file://, so that
// fetch() of the DuckDB .wasm, module workers and streaming instantiation all behave
// exactly as they would on an https origin.
const SCHEME = 'app'
const HOST = 'vernier'

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
  }
])

const RENDERER_DIR = join(import.meta.dirname, '../renderer')
const PRELOAD = join(import.meta.dirname, '../preload/index.cjs')
const SUPPORTED = new Set(['.csv', '.tsv', '.txt', '.xlsx', '.xls', '.parquet'])

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self' blob: data:",
  "font-src 'self' data:"
].join('; ')

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2'
}

// Window chrome colors per effective theme; they match --chrome / --page in styles.css.
const CHROME = {
  light: { overlay: '#f3f3f0', symbols: '#3a3a38', background: '#f9f9f7' },
  dark: { overlay: '#222221', symbols: '#e6e5df', background: '#0d0d0d' }
}

function registerAppProtocol(): void {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url)
    const rel = normalize(decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname))
    const target = join(RENDERER_DIR, rel)
    if (relative(RENDERER_DIR, target).startsWith('..')) {
      return new Response('Forbidden', { status: 403 })
    }
    const res = await net.fetch(pathToFileURL(target).toString())
    if (!res.ok) return res
    const headers = new Headers(res.headers)
    headers.set('Content-Type', MIME[extname(target)] ?? 'application/octet-stream')
    headers.set('Content-Security-Policy', CSP)
    return new Response(res.body, { status: 200, headers })
  })
}

// ------------------------------------------------------------------ settings (theme)

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function loadThemeSource(): ThemeSource {
  try {
    const t: unknown = JSON.parse(readFileSync(settingsPath(), 'utf8')).theme
    if (isThemeSource(t)) return t
  } catch {
    // first run
  }
  return 'light'
}

function saveThemeSource(theme: ThemeSource): void {
  try {
    writeFileSync(settingsPath(), JSON.stringify({ theme }))
  } catch {
    // non-fatal
  }
}

function chrome() {
  return nativeTheme.shouldUseDarkColors ? CHROME.dark : CHROME.light
}

function applyChrome(win: BrowserWindow): void {
  const c = chrome()
  win.setBackgroundColor(c.background)
  if (!isMac) win.setTitleBarOverlay({ color: c.overlay, symbolColor: c.symbols, height: TITLEBAR_HEIGHT })
}

// ------------------------------------------------------------------ windows & files

let mainWindow: BrowserWindow | null = null
// Files handed to us by the OS (argv / open-file) before the renderer is ready.
const pendingPaths: string[] = []
let rendererReady = false

const updater = new Updater(VERSION, (state) => {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('vernier:update', state)
})

async function sendFileToRenderer(path: string): Promise<void> {
  if (!mainWindow) return
  try {
    const info = await stat(path)
    const bytes = await readFile(path)
    // Structured clone of a Uint8Array over IPC: a binary copy, never JSON.
    mainWindow.webContents.send('vernier:open-bytes', {
      name: basename(path),
      size: info.size,
      bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    })
  } catch (err) {
    dialog.showErrorBox('无法打开文件', `${path}\n${String(err)}`)
  }
}

function openPath(path: string): void {
  if (rendererReady) void sendFileToRenderer(path)
  else pendingPaths.push(path)
}

function createWindow(): void {
  const c = chrome()
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Vernier',
    backgroundColor: c.background,
    // Our own title bar: macOS keeps the traffic lights, Windows/Linux keep native caption
    // buttons drawn as an overlay in the theme's colors.
    titleBarStyle: 'hidden',
    ...(isMac
      ? { trafficLightPosition: { x: 14, y: 13 } }
      : { titleBarOverlay: { color: c.overlay, symbolColor: c.symbols, height: TITLEBAR_HEIGHT } }),
    ...(process.platform === 'linux' ? { icon: join(app.getAppPath(), 'resources', 'icon.png') } : {}),
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  })
  const win = mainWindow

  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    mainWindow = null
    rendererReady = false
  })
  win.on('enter-full-screen', () => win.webContents.send('vernier:fullscreen', true))
  win.on('leave-full-screen', () => win.webContents.send('vernier:fullscreen', false))

  // No popups, no navigation away from the app (dropping a file must not navigate).
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())

  if (!app.isPackaged) {
    // Surface renderer console output in the terminal during development.
    win.webContents.on('console-message', (e) => {
      if (e.level === 'warning' || e.level === 'error') console.log(`[renderer:${e.level}] ${e.message}`)
    })
    // No menu bar on Windows/Linux, so give development builds a DevTools shortcut.
    win.webContents.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) {
        win.webContents.toggleDevTools()
      }
    })
  }

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) void win.loadURL(devUrl)
  else void win.loadURL(`${SCHEME}://${HOST}/index.html`)
}

function sendMenu(command: string): void {
  mainWindow?.webContents.send('vernier:menu', command)
}

function buildMenu(): void {
  if (!isMac) {
    // The window has its own title bar; file/view commands live there and in shortcuts.
    Menu.setApplicationMenu(null)
    return
  }
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Vernier',
      submenu: [
        { label: '关于 Vernier', click: () => sendMenu('about') },
        { label: '检查更新…', click: () => sendMenu('check-update') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: '文件',
      submenu: [
        { label: '打开…', accelerator: 'CmdOrCtrl+O', click: () => sendMenu('open') },
        { type: 'separator' },
        { label: '导出图像 (PNG)…', accelerator: 'CmdOrCtrl+Shift+E', click: () => sendMenu('export-png') },
        { type: 'separator' },
        { role: 'close' }
      ]
    },
    { role: 'editMenu' },
    {
      label: '视图',
      submenu: [
        { label: '复位坐标轴', accelerator: 'CmdOrCtrl+0', click: () => sendMenu('reset-view') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function registerIpc(): void {
  ipcMain.on('vernier:ready', () => {
    rendererReady = true
    for (const p of pendingPaths.splice(0)) void sendFileToRenderer(p)
  })

  ipcMain.handle(
    'vernier:app-info',
    (): AppInfo => ({
      name: 'Vernier',
      version: VERSION,
      author: AUTHOR,
      authorUrl: AUTHOR_URL,
      repository: REPOSITORY,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      packaged: app.isPackaged
    })
  )

  ipcMain.handle('vernier:set-theme', (_e, source: unknown) => {
    if (!isThemeSource(source)) return nativeTheme.shouldUseDarkColors
    nativeTheme.themeSource = source
    saveThemeSource(source)
    if (mainWindow) applyChrome(mainWindow)
    return nativeTheme.shouldUseDarkColors
  })

  ipcMain.handle('vernier:open-external', async (_e, url: unknown) => {
    if (typeof url === 'string' && url.startsWith('https://')) await shell.openExternal(url)
  })

  ipcMain.handle('vernier:update-state', () => updater.snapshot)
  ipcMain.handle('vernier:update-check', () => updater.check())
  ipcMain.handle('vernier:update-download', () => updater.download())
  ipcMain.handle('vernier:update-install', () => updater.install())
}

function pathsFromArgv(argv: string[]): string[] {
  return argv.slice(app.isPackaged ? 1 : 2).filter((a) => SUPPORTED.has(extname(a).toLowerCase()))
}

app.on('open-file', (event, path) => {
  event.preventDefault()
  openPath(path)
})

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    pathsFromArgv(argv).forEach(openPath)
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  void app.whenReady().then(() => {
    nativeTheme.themeSource = loadThemeSource()
    nativeTheme.on('updated', () => {
      if (mainWindow) applyChrome(mainWindow)
    })
    registerAppProtocol()
    registerIpc()
    buildMenu()
    pathsFromArgv(process.argv).forEach(openPath)
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
