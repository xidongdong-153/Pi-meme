import type { Theme } from '@pi-meme/contracts/settings'

export function applyTheme(theme: Theme) {
  const root = document.documentElement
  root.style.colorScheme = theme.appearance
  root.dataset.appearance = theme.appearance
  for (const [key, value] of Object.entries(theme.colors)) root.style.setProperty(`--color-${key}`, value)
  root.style.setProperty('--font-ui', theme.fonts.ui)
  root.style.setProperty('--font-code', theme.fonts.code)
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
    const style =
      theme.fontStyles?.[role] ??
      (role === 'content' && theme.fonts.content === theme.fonts.ui ? theme.fontStyles?.ui : undefined) ??
      'regular'
    root.style.setProperty(`--font-${role}-weight`, style.includes('bold') ? '700' : '400')
    root.style.setProperty(`--font-${role}-style`, style.includes('italic') ? 'italic' : 'normal')
  }
  root.dataset.reducedMotion = String(
    value.reducedMotion === 'on' || (value.reducedMotion === 'system' && systemMotion),
  )
  root.dataset.translucentSidebar = String(value.translucentSidebar)
}
