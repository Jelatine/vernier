import { contextBridge, ipcRenderer } from 'electron'
import type { AppInfo, ThemeSource, UpdateState } from '../shared/types'

export interface OpenBytesPayload {
  name: string
  size: number
  bytes: Uint8Array
}

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.off(channel, listener)
}

// The renderer's whole view of the main process. File contents from drag-drop / the file
// picker never touch IPC — the renderer hands the File handle straight to the data worker.
const api = {
  platform: process.platform,
  ready: (): void => ipcRenderer.send('vernier:ready'),
  onMenu: (cb: (command: string) => void) => subscribe('vernier:menu', cb),
  onOpenBytes: (cb: (payload: OpenBytesPayload) => void) => subscribe('vernier:open-bytes', cb),
  onFullscreen: (cb: (fullscreen: boolean) => void) => subscribe('vernier:fullscreen', cb),
  appInfo: (): Promise<AppInfo> => ipcRenderer.invoke('vernier:app-info'),
  /** Resolves to whether the effective theme is dark. */
  setTheme: (source: ThemeSource): Promise<boolean> => ipcRenderer.invoke('vernier:set-theme', source),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('vernier:open-external', url),
  update: {
    state: (): Promise<UpdateState> => ipcRenderer.invoke('vernier:update-state'),
    check: (): Promise<UpdateState> => ipcRenderer.invoke('vernier:update-check'),
    download: (): Promise<UpdateState> => ipcRenderer.invoke('vernier:update-download'),
    install: (): Promise<void> => ipcRenderer.invoke('vernier:update-install'),
    onState: (cb: (state: UpdateState) => void) => subscribe('vernier:update', cb)
  }
}

contextBridge.exposeInMainWorld('vernier', api)

export type VernierBridge = typeof api
