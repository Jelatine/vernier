import { REPOSITORY, type AppInfo, type UpdateState } from '../../../shared/types'

const AUTO_KEY = 'vernier.autoCheckUpdates'

export function openExternal(url: string): void {
  if (window.vernier) void window.vernier.openExternal(url)
  else window.open(url, '_blank', 'noopener')
}

function autoCheckEnabled(): boolean {
  try {
    return localStorage.getItem(AUTO_KEY) !== 'false'
  } catch {
    return true
  }
}

const PLATFORM: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }

/** About dialog: version, author, repository, runtime, and the update section. */
export class AboutDialog {
  private readonly text: HTMLElement
  private readonly action: HTMLButtonElement
  private readonly progress: HTMLElement
  private readonly notes: HTMLDetailsElement

  constructor(
    private readonly el: HTMLDialogElement,
    onAction: () => void
  ) {
    this.text = el.querySelector('#update-text')!
    this.action = el.querySelector('#update-action')!
    this.progress = el.querySelector('#update-progress')!
    this.notes = el.querySelector('#update-notes')!
    el.querySelector('#about-version')!.textContent = __APP_VERSION__

    el.querySelectorAll<HTMLAnchorElement>('a[data-external]').forEach((a) =>
      a.addEventListener('click', (e) => {
        e.preventDefault()
        openExternal(a.href)
      })
    )
    // Click on the backdrop closes.
    el.addEventListener('click', (e) => {
      if (e.target === el) el.close()
    })
    this.action.addEventListener('click', onAction)

    const auto = el.querySelector<HTMLInputElement>('#update-auto')!
    auto.checked = autoCheckEnabled()
    auto.addEventListener('change', () => {
      try {
        localStorage.setItem(AUTO_KEY, String(auto.checked))
      } catch {
        // ignore
      }
    })
  }

  open(): void {
    if (!this.el.open) this.el.showModal()
  }

  setInfo(info: AppInfo): void {
    this.el.querySelector('#about-runtime')!.textContent =
      `${PLATFORM[info.platform] ?? info.platform} ${info.arch} · Electron ${info.electron} · Chromium ${info.chrome.split('.')[0]} · Node ${info.node}${info.packaged ? '' : ' · 开发版'}`
  }

  renderUpdate(state: UpdateState, supported: boolean): void {
    const set = (text: string, label: string, disabled = false) => {
      this.text.textContent = text
      this.action.textContent = label
      this.action.disabled = disabled
    }
    this.progress.hidden = state.status !== 'downloading'
    this.notes.hidden = !(state.status === 'available' && state.notes.trim())
    if (!supported) {
      set('浏览器预览模式不支持检查更新', '打开发布页')
      return
    }
    switch (state.status) {
      case 'idle':
        set('尚未检查更新', '检查更新')
        break
      case 'checking':
        set('正在检查更新…', '检查中…', true)
        break
      case 'latest':
        set(`已是最新版本 · 检查于 ${new Date(state.checkedAt).toLocaleTimeString()}`, '重新检查')
        break
      case 'available': {
        const date = state.publishedAt ? `（${new Date(state.publishedAt).toLocaleDateString()} 发布）` : ''
        set(`发现新版本 v${state.latest}${date}${state.canInstall ? '' : ' · 需下载安装包手动更新'}`, state.canInstall ? '下载并安装' : '前往下载')
        this.notes.querySelector('pre')!.textContent = state.notes.trim()
        break
      }
      case 'downloading':
        set(`正在下载 v${state.latest}… ${Math.round(state.percent)}%`, '下载中…', true)
        ;(this.progress.firstElementChild as HTMLElement).style.width = `${state.percent}%`
        break
      case 'ready':
        set(`v${state.latest} 已下载完成，重启后生效`, '重启并安装')
        break
      case 'error':
        set(`检查更新失败：${state.message}`, '重试')
        break
    }
  }
}

/** Title-bar badge + about dialog, driven by the main process updater's state. */
export class UpdateController {
  state: UpdateState = { status: 'idle' }

  constructor(
    private readonly about: AboutDialog,
    private readonly badge: HTMLButtonElement
  ) {
    badge.addEventListener('click', () => {
      if (this.state.status === 'ready') void window.vernier?.update.install()
      else about.open()
    })
  }

  async start(): Promise<void> {
    const bridge = window.vernier
    if (!bridge) {
      this.render()
      return
    }
    bridge.update.onState((s) => {
      this.state = s
      this.render()
    })
    this.state = await bridge.update.state()
    this.render()
    if (autoCheckEnabled() && this.state.status === 'idle') setTimeout(() => void this.check(), 2000)
  }

  async check(): Promise<void> {
    const bridge = window.vernier
    if (!bridge) return
    this.state = await bridge.update.check()
    this.render()
  }

  async act(): Promise<void> {
    const bridge = window.vernier
    if (!bridge) {
      openExternal(`${REPOSITORY}/releases/latest`)
      return
    }
    switch (this.state.status) {
      case 'available':
        this.state = await bridge.update.download()
        break
      case 'ready':
        await bridge.update.install()
        return
      case 'checking':
      case 'downloading':
        return
      default:
        await this.check()
        return
    }
    this.render()
  }

  private render(): void {
    const s = this.state
    const b = this.badge
    b.hidden = !(s.status === 'available' || s.status === 'downloading' || s.status === 'ready')
    if (s.status === 'available') {
      b.textContent = `新版本 v${s.latest}`
      b.title = '有可用更新，点击查看'
    } else if (s.status === 'downloading') {
      b.textContent = `下载更新 ${Math.round(s.percent)}%`
      b.title = '正在下载更新'
    } else if (s.status === 'ready') {
      b.textContent = '重启以完成更新'
      b.title = `v${s.latest} 已下载，点击重启安装`
    }
    this.about.renderUpdate(s, !!window.vernier)
  }
}
