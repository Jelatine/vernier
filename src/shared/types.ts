export const AUTHOR = 'Jelatine'
export const AUTHOR_URL = 'https://github.com/Jelatine'
export const REPO_SLUG = 'Jelatine/vernier'
export const REPOSITORY = `https://github.com/${REPO_SLUG}`

export type ThemeSource = 'light' | 'dark' | 'system'

export function isThemeSource(v: unknown): v is ThemeSource {
  return v === 'light' || v === 'dark' || v === 'system'
}

export interface AppInfo {
  name: string
  version: string
  author: string
  authorUrl: string
  repository: string
  electron: string
  chrome: string
  node: string
  platform: string
  arch: string
  packaged: boolean
}

export type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'latest'; latest: string; checkedAt: number }
  | {
      status: 'available'
      latest: string
      notes: string
      releaseUrl: string
      /** Direct installer for this platform/arch, when the release has one. */
      downloadUrl: string | null
      publishedAt: string
      /** true when this build can download and install in place (Windows NSIS, Linux AppImage). */
      canInstall: boolean
    }
  | { status: 'downloading'; latest: string; percent: number }
  | { status: 'ready'; latest: string }
  | { status: 'error'; message: string }
