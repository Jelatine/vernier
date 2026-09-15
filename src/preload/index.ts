import { contextBridge, ipcRenderer } from 'electron'

export interface OpenBytesPayload {
  name: string
  size: number
  bytes: Uint8Array
}

// The only surface the renderer gets: menu commands in, OS-opened files in, "ready" out.
// File contents from drag-drop / the file picker never touch IPC at all — the renderer
// hands the File handle straight to the data worker.
const api = {
  platform: process.platform,
  ready: (): void => ipcRenderer.send('vernier:ready'),
  onMenu: (cb: (command: string) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, command: string): void => cb(command)
    ipcRenderer.on('vernier:menu', listener)
    return () => ipcRenderer.off('vernier:menu', listener)
  },
  onOpenBytes: (cb: (payload: OpenBytesPayload) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: OpenBytesPayload): void => cb(payload)
    ipcRenderer.on('vernier:open-bytes', listener)
    return () => ipcRenderer.off('vernier:open-bytes', listener)
  }
}

contextBridge.exposeInMainWorld('vernier', api)

export type VernierBridge = typeof api
