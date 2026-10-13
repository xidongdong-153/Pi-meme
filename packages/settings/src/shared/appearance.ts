import type {
  AppearanceOverrides,
  AppearanceSettings,
  DesktopSettings,
  FontStyle,
  Theme,
} from '@pi-meme/contracts/settings'
import { builtinThemes, parseTheme, parseThemeTokens } from './themes'

export const fontStyles: FontStyle[] = ['regular', 'bold', 'italic', 'bold-italic']
export function defaultAppearance(): AppearanceSettings {
  return {
    mode: 'system',
    lightThemeId: 'light',
    darkThemeId: 'dark',
    separate: false,
    shared: {},
    uiSize: 14,
    codeSize: 13,
    reducedMotion: 'system',
    translucentSidebar: false,
    contrast: 50,
  }
}
export function migrateAppearance(settings: DesktopSettings, themes: Theme[]): AppearanceSettings {
  if (settings.appearance) return structuredClone(settings.appearance)
  const theme = themes.find((entry) => entry.id === settings.themeId) ?? builtinThemes[0]
  return { ...defaultAppearance(), mode: theme.appearance, [`${theme.appearance}ThemeId`]: theme.id }
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
export function validateAppearance(value: unknown): asserts value is AppearanceSettings {
  if (
    !record(value) ||
    typeof value.mode !== 'string' ||
    !['system', 'light', 'dark'].includes(value.mode) ||
    typeof value.reducedMotion !== 'string' ||
    !['system', 'on', 'off'].includes(value.reducedMotion) ||
    typeof value.separate !== 'boolean' ||
    typeof value.translucentSidebar !== 'boolean' ||
    typeof value.lightThemeId !== 'string' ||
    typeof value.darkThemeId !== 'string'
  )
    throw new Error('外观设置无效')
  for (const [key, min, max] of [
    ['uiSize', 12, 20],
    ['codeSize', 10, 24],
    ['contrast', 0, 100],
  ] as const) {
    const number = value[key]
    if (typeof number !== 'number' || !Number.isInteger(number) || number < min || number > max)
      throw new Error(
        `${{ uiSize: '界面字号', codeSize: '代码字体大小', contrast: '对比度' }[key]} 必须是 ${min}–${max} 之间的整数`,
      )
  }
  for (const key of ['shared', 'light', 'dark'] as const) {
    const overrides = value[key]
    if (overrides === undefined && key !== 'shared') continue
    if (!record(overrides)) throw new Error('外观覆盖值无效')
    if (
      overrides.colors !== undefined &&
      (!record(overrides.colors) ||
        Object.entries(overrides.colors).some(
          ([name, color]) =>
            !['background', 'text', 'accent'].includes(name) ||
            typeof color !== 'string' ||
            !/^#[0-9a-f]{6}$/i.test(color),
        ))
    )
      throw new Error('颜色必须是六位 HEX 值')
    parseTheme({
      id: 'validation',
      name: '校验',
      appearance: 'dark',
      fonts: overrides.fonts,
      fontStyles: overrides.fontStyles,
    })
    if (overrides.tokens !== undefined) parseThemeTokens(overrides.tokens)
    if (overrides.background !== undefined) {
      if (
        !record(overrides.background) ||
        Object.keys(overrides.background).some((key) => !['opacity', 'blur'].includes(key))
      )
        throw new Error('背景覆盖只支持透明度和模糊值')
      for (const [key, maximum] of [
        ['opacity', 1],
        ['blur', 32],
      ] as const) {
        const number = overrides.background[key]
        if (
          number !== undefined &&
          (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > maximum)
        )
          throw new Error('背景透明度或模糊值无效')
      }
    }
  }
}
export function editingOverrides(value: AppearanceSettings, mode: 'light' | 'dark'): AppearanceOverrides {
  return value.separate ? (value[mode] ?? {}) : value.shared
}
export function setOverrides(
  value: AppearanceSettings,
  mode: 'light' | 'dark',
  overrides: AppearanceOverrides,
): AppearanceSettings {
  return { ...value, [value.separate ? mode : 'shared']: overrides }
}
export function toggleSeparate(
  value: AppearanceSettings,
  mode: 'light' | 'dark',
  separate: boolean,
): AppearanceSettings {
  return separate
    ? {
        ...value,
        separate,
        light: value.light ?? structuredClone(value.shared),
        dark: value.dark ?? structuredClone(value.shared),
      }
    : { ...value, separate, shared: structuredClone(value[mode] ?? {}) }
}
export function selectAppearanceTheme(value: AppearanceSettings, theme: Theme): AppearanceSettings {
  return setOverrides({ ...value, [`${theme.appearance}ThemeId`]: theme.id }, theme.appearance, {})
}
export function resolvedMode(value: AppearanceSettings, systemDark: boolean): 'light' | 'dark' {
  return value.mode === 'system' ? (systemDark ? 'dark' : 'light') : value.mode
}
function mix(source: string, target: string, amount: number) {
  return `#${[1, 3, 5]
    .map((offset) =>
      Math.round(
        Number.parseInt(source.slice(offset, offset + 2), 16) * (1 - amount) +
          Number.parseInt(target.slice(offset, offset + 2), 16) * amount,
      )
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`
}
export function resolveTheme(
  value: AppearanceSettings,
  themes: Theme[],
  mode: 'light' | 'dark',
  contrast = true,
): Theme {
  const base =
    themes.find((theme) => theme.id === value[`${mode}ThemeId`] && theme.appearance === mode) ??
    builtinThemes.find((theme) => theme.appearance === mode)!
  const overrides = editingOverrides(value, mode)
  const colors = { ...base.colors, ...overrides.colors }
  if (overrides.colors?.accent) {
    const rgb = [1, 3, 5].map((offset) => Number.parseInt(colors.accent.slice(offset, offset + 2), 16))
    colors.accentText = rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114 > 150 ? '#181818' : '#ffffff'
  }
  if (contrast && value.contrast !== 50) {
    const amount = (Math.abs(value.contrast - 50) / 50) * 0.2
    for (const key of ['surface', 'elevated', 'border', 'muted'] as const)
      colors[key] = mix(colors[key], value.contrast > 50 ? colors.text : colors.background, amount)
  }
  const fonts = { ...base.fonts, ...overrides.fonts }
  if (!fonts.content || fonts.content === 'inherit') fonts.content = fonts.ui
  const fontStyles = { ...base.fontStyles, ...overrides.fontStyles }
  if (overrides.fonts?.content === 'inherit' && !overrides.fontStyles?.content)
    fontStyles.content = fontStyles.ui ?? 'regular'
  return {
    ...base,
    colors,
    fonts,
    fontStyles,
    tokens: { spacing: 1, radius: 8, surfaceOpacity: 1, ...base.tokens, ...overrides.tokens },
    ...(base.background ? { background: { ...base.background, ...overrides.background } } : {}),
  }
}
