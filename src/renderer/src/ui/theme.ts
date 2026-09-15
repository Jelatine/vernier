import type { ThemeSource } from '../../../shared/types'

const KEY = 'vernier.theme'

const svg = (d: string) =>
  `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`

export const THEME_ICONS: Record<ThemeSource | 'check', string> = {
  light: svg('<circle cx="8" cy="8" r="2.75"/><path d="M8 1.5v1.25M8 13.25v1.25M1.5 8h1.25M13.25 8h1.25M3.4 3.4l.9.9M11.7 11.7l.9.9M3.4 12.6l.9-.9M11.7 4.3l.9-.9"/>'),
  dark: svg('<path d="M13.25 9.6A5.5 5.5 0 0 1 6.4 2.75a5.5 5.5 0 1 0 6.85 6.85z"/>'),
  system: svg('<rect x="1.75" y="2.5" width="12.5" height="8.5" rx="1.5"/><path d="M5.5 13.75h5M8 11v2.75"/>'),
  check: svg('<path d="M3.5 8.25l3 3 6-6.5"/>')
}

const LABELS: Record<ThemeSource, string> = { light: '浅色', dark: '深色', system: '跟随系统' }

/**
 * Light / dark / follow-system, defaulting to light. The main process is told first so
 * nativeTheme (and with it prefers-color-scheme, native dialogs and the Windows caption
 * buttons) agrees with the page.
 */
export class ThemeController {
  mode: ThemeSource
  private readonly mq = window.matchMedia('(prefers-color-scheme: dark)')

  constructor(private readonly onChange: (effective: 'light' | 'dark') => void) {
    this.mode = readStored()
    this.mq.addEventListener('change', () => {
      if (this.mode === 'system') void this.apply()
    })
  }

  get effective(): 'light' | 'dark' {
    return this.mode === 'system' ? (this.mq.matches ? 'dark' : 'light') : this.mode
  }

  async set(mode: ThemeSource): Promise<void> {
    this.mode = mode
    try {
      localStorage.setItem(KEY, mode)
    } catch {
      // storage unavailable: keep the choice for this session only
    }
    await this.apply()
  }

  async apply(notify = true): Promise<void> {
    let dark: boolean | undefined
    if (window.vernier) dark = await window.vernier.setTheme(this.mode)
    const effective = this.mode === 'system' && dark !== undefined ? (dark ? 'dark' : 'light') : this.effective
    const root = document.documentElement
    const changed = root.dataset['theme'] !== effective
    root.dataset['theme'] = effective
    root.dataset['themeMode'] = this.mode
    if (changed && notify) this.onChange(effective)
  }
}

function readStored(): ThemeSource {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch {
    // ignore
  }
  return 'light'
}

export function bindThemeMenu(theme: ThemeController, button: HTMLButtonElement, menu: HTMLElement): void {
  const items = [...menu.querySelectorAll<HTMLButtonElement>('[data-theme-choice]')]
  for (const item of items) {
    const mode = item.dataset['themeChoice'] as ThemeSource
    item.querySelector('.mi-icon')!.innerHTML = THEME_ICONS[mode]
  }

  const sync = () => {
    button.innerHTML = THEME_ICONS[theme.mode]
    button.title = `外观：${LABELS[theme.mode]}`
    for (const item of items) {
      const on = item.dataset['themeChoice'] === theme.mode
      item.setAttribute('aria-checked', String(on))
      item.querySelector('.mi-check')!.innerHTML = on ? THEME_ICONS.check : ''
    }
  }
  const close = () => {
    menu.hidden = true
    button.setAttribute('aria-expanded', 'false')
  }
  const open = () => {
    menu.hidden = false
    button.setAttribute('aria-expanded', 'true')
    items.find((i) => i.dataset['themeChoice'] === theme.mode)?.focus()
  }

  button.addEventListener('click', () => (menu.hidden ? open() : close()))
  for (const item of items) {
    item.addEventListener('click', () => {
      void theme.set(item.dataset['themeChoice'] as ThemeSource).then(sync)
      close()
      button.focus()
    })
  }
  menu.addEventListener('keydown', (e) => {
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]!.focus()
    } else if (e.key === 'Escape') {
      close()
      button.focus()
    }
  })
  document.addEventListener('pointerdown', (e) => {
    if (!menu.hidden && !menu.contains(e.target as Node) && !button.contains(e.target as Node)) close()
  })
  sync()
}
