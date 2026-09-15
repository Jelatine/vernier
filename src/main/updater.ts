import { app, net, shell } from 'electron'
import type { AppUpdater } from 'electron-updater'
import { REPO_SLUG, type UpdateState } from '../shared/types'
import { isNewer, parseVersion } from '../shared/version'

interface GithubRelease {
  tag_name?: string
  html_url?: string
  body?: string | null
  published_at?: string | null
  assets?: { name: string; browser_download_url: string }[]
}

/**
 * Version check against the latest GitHub release, plus in-place upgrade where the platform
 * allows it: electron-updater for Windows (NSIS) and Linux (AppImage). Unsigned macOS builds
 * cannot be swapped in place, so there the upgrade opens the matching .dmg download.
 */
export class Updater {
  private state: UpdateState = { status: 'idle' }
  private updater: AppUpdater | null = null
  private inflight: Promise<UpdateState> | null = null

  constructor(
    private readonly current: string,
    private readonly emit: (state: UpdateState) => void
  ) {}

  get snapshot(): UpdateState {
    return this.state
  }

  private set(state: UpdateState): void {
    this.state = state
    this.emit(state)
  }

  check(): Promise<UpdateState> {
    if (this.state.status === 'downloading' || this.state.status === 'ready') return Promise.resolve(this.state)
    this.inflight ??= this.fetchLatest().finally(() => (this.inflight = null))
    return this.inflight
  }

  private async fetchLatest(): Promise<UpdateState> {
    this.set({ status: 'checking' })
    try {
      const url = process.env['VERNIER_UPDATE_URL'] || `https://api.github.com/repos/${REPO_SLUG}/releases/latest`
      const res = await net.fetch(url, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Vernier/${this.current}` }
      })
      if (res.status === 404) {
        this.set({ status: 'latest', latest: this.current, checkedAt: Date.now() })
        return this.state
      }
      if (!res.ok) throw new Error(`GitHub 返回 HTTP ${res.status}`)
      const rel = (await res.json()) as GithubRelease
      const latest = String(rel.tag_name ?? '').replace(/^v/, '')
      if (!parseVersion(latest)) throw new Error(`无法识别的版本标签：${rel.tag_name ?? '(空)'}`)
      if (!isNewer(latest, this.current)) {
        this.set({ status: 'latest', latest, checkedAt: Date.now() })
      } else {
        this.set({
          status: 'available',
          latest,
          notes: rel.body ?? '',
          releaseUrl: rel.html_url ?? `https://github.com/${REPO_SLUG}/releases/latest`,
          downloadUrl: pickAsset(rel.assets ?? []),
          publishedAt: rel.published_at ?? '',
          canInstall: canSelfInstall()
        })
      }
    } catch (err) {
      this.set({ status: 'error', message: errText(err) })
    }
    return this.state
  }

  async download(): Promise<UpdateState> {
    const s = this.state
    if (s.status !== 'available') return s
    if (!s.canInstall) {
      await shell.openExternal(s.downloadUrl ?? s.releaseUrl)
      return s
    }
    try {
      const updater = await this.loadUpdater()
      this.set({ status: 'downloading', latest: s.latest, percent: 0 })
      const result = await updater.checkForUpdates()
      if (!result?.isUpdateAvailable) throw new Error('更新源中没有找到可安装的新版本')
      await updater.downloadUpdate()
      this.set({ status: 'ready', latest: s.latest })
    } catch (err) {
      this.set({ status: 'error', message: errText(err) })
    }
    return this.state
  }

  install(): void {
    if (this.state.status === 'ready' && this.updater) this.updater.quitAndInstall(false, true)
  }

  private async loadUpdater(): Promise<AppUpdater> {
    if (this.updater) return this.updater
    const mod = (await import('electron-updater')) as typeof import('electron-updater') & { default?: typeof import('electron-updater') }
    const updater = mod.autoUpdater ?? mod.default!.autoUpdater
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = true
    updater.allowPrerelease = false
    updater.on('download-progress', (p) => {
      const s = this.state
      if (s.status === 'downloading') this.set({ ...s, percent: p.percent })
    })
    this.updater = updater
    return updater
  }
}

function canSelfInstall(): boolean {
  if (!app.isPackaged) return false
  return process.platform === 'win32' || (process.platform === 'linux' && !!process.env['APPIMAGE'])
}

/** The installer asset for this OS/arch, matching electron-builder.yml's artifactName patterns. */
export function pickAsset(assets: { name: string; browser_download_url: string }[], platform = process.platform, arch = process.arch): string | null {
  const pattern =
    platform === 'darwin'
      ? new RegExp(`-mac-${arch === 'arm64' ? 'arm64' : 'x64'}\\.dmg$`)
      : platform === 'win32'
        ? /-win-x64-setup\.exe$/
        : /-linux-x86_64\.AppImage$/
  return assets.find((a) => pattern.test(a.name))?.browser_download_url ?? null
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
