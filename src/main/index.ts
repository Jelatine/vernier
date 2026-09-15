import { app, BrowserWindow, Menu, dialog, ipcMain, net, protocol, shell } from 'electron'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, relative, basename } from 'node:path'
import { pathToFileURL } from 'node:url'

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

let mainWindow: BrowserWindow | null = null
// Files handed to us by the OS (argv / open-file) before the renderer is ready.
const pendingPaths: string[] = []
let rendererReady = false

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
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Vernier',
    backgroundColor: '#f7f7f5',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
    rendererReady = false
  })

  // No popups, no navigation away from the app (dropping a file must not navigate).
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault())

  if (!app.isPackaged) {
    // Surface renderer console output in the terminal during development.
    mainWindow.webContents.on('console-message', (e) => {
      if (e.level === 'warning' || e.level === 'error') console.log(`[renderer:${e.level}] ${e.message}`)
    })
  }

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) void mainWindow.loadURL(devUrl)
  else void mainWindow.loadURL(`${SCHEME}://${HOST}/index.html`)
}

function sendMenu(command: string): void {
  mainWindow?.webContents.send('vernier:menu', command)
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: '文件',
      submenu: [
        { label: '打开…', accelerator: 'CmdOrCtrl+O', click: () => sendMenu('open') },
        { type: 'separator' },
        { label: '导出图像 (PNG)…', accelerator: 'CmdOrCtrl+Shift+E', click: () => sendMenu('export-png') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
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
    registerAppProtocol()
    buildMenu()

    ipcMain.on('vernier:ready', () => {
      rendererReady = true
      for (const p of pendingPaths.splice(0)) void sendFileToRenderer(p)
    })

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
