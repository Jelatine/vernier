import type { AppInfo, ThemeSource, UpdateState } from '../shared/types'

export interface OpenBytesPayload {
  name: string
  size: number
  bytes: Uint8Array
}

export interface VernierBridge {
  platform: string
  ready(): void
  onMenu(cb: (command: string) => void): () => void
  onOpenBytes(cb: (payload: OpenBytesPayload) => void): () => void
  onFullscreen(cb: (fullscreen: boolean) => void): () => void
  appInfo(): Promise<AppInfo>
  setTheme(source: ThemeSource): Promise<boolean>
  openExternal(url: string): Promise<void>
  update: {
    state(): Promise<UpdateState>
    check(): Promise<UpdateState>
    download(): Promise<UpdateState>
    install(): Promise<void>
    onState(cb: (state: UpdateState) => void): () => void
  }
}

declare global {
  interface Window {
    /** Absent when the renderer runs in a plain browser (e.g. vite dev without Electron). */
    vernier?: VernierBridge
  }
}
