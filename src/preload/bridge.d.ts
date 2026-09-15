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
}

declare global {
  interface Window {
    /** Absent when the renderer runs in a plain browser (e.g. vite dev without Electron). */
    vernier?: VernierBridge
  }
}
