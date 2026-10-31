import type { Theme } from '@pi-meme/contracts/settings'

export function applyTheme(theme: Theme) {
  const root = document.documentElement
  root.style.colorScheme = theme.appearance
  root.dataset.appearance = theme.appearance
  for (const [key, value] of Object.entries(theme.colors)) root.style.setProperty(`--color-${key}`, value)
  root.style.setProperty('--font-ui', theme.fonts.ui)
  root.style.setProperty('--font-code', theme.fonts.code)
  root.style.setProperty('--theme-space-scale', String(theme.tokens?.spacing ?? 1))
  root.style.setProperty('--radius', `${theme.tokens?.radius ?? 8}px`)
  root.style.setProperty('--theme-radius-scale', String((theme.tokens?.radius ?? 8) / 8))
  root.style.setProperty('--theme-surface-opacity', `${(theme.tokens?.surfaceOpacity ?? 1) * 100}%`)
  const background = theme.background
  root.dataset.themeBackground = background?.url ? background.area : ''
  root.style.setProperty(
    '--theme-background-image',
    background?.url ? `url(${JSON.stringify(background.url)})` : 'none',
  )
  root.style.setProperty('--theme-background-fit', background?.fit ?? 'cover')
  root.style.setProperty('--theme-background-position', background?.position ?? 'center')
  root.style.setProperty('--theme-background-opacity', String(background?.opacity ?? 0))
  root.style.setProperty('--theme-background-overlay', background?.overlay ?? theme.colors.background)
  root.style.setProperty('--theme-background-blur', `${background?.blur ?? 0}px`)
}

export function applyAppearance(
  theme: Theme,
  value: import('@pi-meme/contracts/settings').AppearanceSettings,
  systemMotion: boolean,
) {
  applyTheme(theme)
  const root = document.documentElement
  root.style.fontSize = `${(16 * value.uiSize) / 14}px`
  root.style.setProperty('--text-ui', `${value.uiSize}px`)
  root.style.setProperty('--font-content', theme.fonts.content ?? theme.fonts.ui)
  root.style.setProperty('--code-size', `${value.codeSize}px`)
  for (const role of ['ui', 'content', 'code'] as const) {
    const style = theme.fontStyles?.[role] ?? 'regular'
    root.style.setProperty(`--font-${role}-weight`, style.includes('bold') ? '700' : '400')
    root.style.setProperty(`--font-${role}-style`, style.includes('italic') ? 'italic' : 'normal')
  }
  root.dataset.reducedMotion = String(
    value.reducedMotion === 'on' || (value.reducedMotion === 'system' && systemMotion),
  )
  root.dataset.translucentSidebar = String(value.translucentSidebar)
}
