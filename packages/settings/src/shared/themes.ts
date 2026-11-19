import type { FontStyle, Theme, ThemeColors, ThemeTokens, ThemeBackground } from '@pi-meme/contracts/settings'

const fonts = {
  ui: '-apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif',
  code: 'ui-monospace, SFMono-Regular, Menlo, monospace',
}
export const builtinThemes: Theme[] = [
  {
    id: 'dark',
    name: '深色',
    appearance: 'dark',
    fonts,
    colors: {
      background: '#18181a',
      surface: '#1e1e21',
      elevated: '#29292e',
      text: '#e9e9eb',
      muted: '#a0a0aa',
      border: '#3a3a42',
      accent: '#b6a4ed',
      accentText: '#211c2e',
      success: '#7bb795',
      error: '#f5a49b',
    },
  },
  {
    id: 'light',
    name: '浅色',
    appearance: 'light',
    fonts,
    colors: {
      background: '#faf9fc',
      surface: '#f1eff5',
      elevated: '#e8e4ef',
      text: '#262330',
      muted: '#686271',
      border: '#d2cddc',
      accent: '#6c4eb3',
      accentText: '#ffffff',
      success: '#257548',
      error: '#b2372d',
    },
  },
  {
    id: 'catppuccin-latte',
    name: 'Catppuccin Latte',
    appearance: 'light',
    fonts,
    colors: {
      background: '#e6e9ef',
      surface: '#eff1f5',
      elevated: '#ccd0da',
      text: '#4c4f69',
      muted: '#5c5f77',
      border: '#bcc0cc',
      accent: '#1e66f5',
      accentText: '#dce0e8',
      success: '#40a02b',
      error: '#d20f39',
    },
  },
  {
    id: 'catppuccin-mocha',
    name: 'Catppuccin Mocha',
    appearance: 'dark',
    fonts,
    colors: {
      background: '#181825',
      surface: '#1e1e2e',
      elevated: '#313244',
      text: '#cdd6f4',
      muted: '#a6adc8',
      border: '#45475a',
      accent: '#89b4fa',
      accentText: '#11111b',
      success: '#a6e3a1',
      error: '#f38ba8',
    },
  },
  {
    id: 'everforest-light',
    name: 'Everforest Light',
    appearance: 'light',
    fonts,
    colors: {
      background: '#fdf6e3',
      surface: '#f4f0d9',
      elevated: '#efebd4',
      text: '#5c6a72',
      muted: '#939f91',
      border: '#e0dcc7',
      accent: '#8da101',
      accentText: '#ffffff',
      success: '#8da101',
      error: '#f85552',
    },
  },
  {
    id: 'everforest-dark',
    name: 'Everforest Dark',
    appearance: 'dark',
    fonts,
    colors: {
      background: '#232a2e',
      surface: '#2d353b',
      elevated: '#343f44',
      text: '#d3c6aa',
      muted: '#859289',
      border: '#475258',
      accent: '#a7c080',
      accentText: '#232a2e',
      success: '#a7c080',
      error: '#e67e80',
    },
  },
]
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
export function parseThemeTokens(value: unknown): ThemeTokens {
  if (!object(value) || Object.keys(value).some((key) => !['spacing', 'radius', 'surfaceOpacity'].includes(key)))
    throw new Error('主题 tokens 只支持 spacing、radius 和 surfaceOpacity')
  const tokens = { spacing: 1, radius: 8, surfaceOpacity: 1, ...value }
  for (const [key, minimum, maximum] of [
    ['spacing', 0.5, 2],
    ['radius', 0, 24],
    ['surfaceOpacity', 0.4, 1],
  ] as const) {
    const number = tokens[key]
    if (typeof number !== 'number' || !Number.isFinite(number) || number < minimum || number > maximum)
      throw new Error(`主题 ${key} 必须在 ${minimum} 到 ${maximum} 之间`)
  }
  return tokens as ThemeTokens
}
function parseBackground(value: unknown): ThemeBackground {
  if (
    !object(value) ||
    Object.keys(value).some((key) => !['image', 'area', 'fit', 'position', 'opacity', 'overlay', 'blur'].includes(key))
  )
    throw new Error('主题背景字段无效，不接受 URL、CSS 或脚本')
  const background = {
    image: value.image,
    area: 'app',
    fit: 'cover',
    position: 'center',
    opacity: 0.25,
    overlay: '#18181a',
    blur: 0,
    ...value,
  }
  if (
    typeof background.image !== 'string' ||
    !/\.(?:png|jpe?g|webp|avif)$/i.test(background.image) ||
    background.image.startsWith('/') ||
    /[\\:%?#]/.test(background.image) ||
    Array.from(background.image).some((character) => character.charCodeAt(0) < 32) ||
    background.image.split('/').some((part) => !part || part === '.' || part === '..') ||
    !['app', 'workspace', 'sidebar'].includes(String(background.area)) ||
    !['cover', 'contain'].includes(String(background.fit)) ||
    !['center', 'top', 'bottom'].includes(String(background.position)) ||
    typeof background.overlay !== 'string' ||
    !/^#[0-9a-f]{6}$/i.test(background.overlay) ||
    typeof background.opacity !== 'number' ||
    !Number.isFinite(background.opacity) ||
    background.opacity < 0 ||
    background.opacity > 1 ||
    typeof background.blur !== 'number' ||
    !Number.isFinite(background.blur) ||
    background.blur < 0 ||
    background.blur > 32
  )
    throw new Error('主题背景需要包内图片、合法显示区域和有效的透明度及模糊值')
  return background as ThemeBackground
}
export function parseTheme(value: unknown): Theme {
  if (
    !object(value) ||
    typeof value.id !== 'string' ||
    !/^[a-z0-9][\w-]*$/i.test(value.id) ||
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    (value.appearance !== 'dark' && value.appearance !== 'light')
  ) {
    throw new Error('主题需要有效的 id、name 和 appearance')
  }
  if (value.css !== undefined || value.script !== undefined) throw new Error('主题只接受结构化 JSON，不执行 CSS 或脚本')
  const base = builtinThemes.find((theme) => theme.appearance === value.appearance)!
  if (value.colors !== undefined && !object(value.colors)) throw new Error('colors 必须是对象')
  const colors = { ...base.colors }
  for (const [key, color] of Object.entries(value.colors ?? {})) {
    if (!(key in colors) || typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color))
      throw new Error(`主题颜色 ${key} 必须是六位十六进制颜色`)
    colors[key as keyof ThemeColors] = color
  }
  const resolvedFonts: Theme['fonts'] = { ...base.fonts }
  if (value.fonts !== undefined) {
    if (!object(value.fonts)) throw new Error('fonts 必须是对象')
    for (const [key, font] of Object.entries(value.fonts)) {
      if (
        !['ui', 'code', 'content'].includes(key) ||
        typeof font !== 'string' ||
        !font.trim() ||
        /[;{}<>\\]/.test(font)
      )
        throw new Error(`字体 ${key} 无效`)
      resolvedFonts[key as keyof typeof resolvedFonts] = font
    }
  }
  const fontStyles: NonNullable<Theme['fontStyles']> = {}
  if (value.fontStyles !== undefined) {
    if (!object(value.fontStyles)) throw new Error('fontStyles 必须是对象')
    for (const [key, style] of Object.entries(value.fontStyles)) {
      if (
        !['ui', 'content', 'code'].includes(key) ||
        typeof style !== 'string' ||
        !['regular', 'bold', 'italic', 'bold-italic'].includes(style)
      )
        throw new Error(`字体样式 ${key} 无效`)
      fontStyles[key as keyof typeof fontStyles] = style as FontStyle
    }
  }
  return {
    fontStyles,
    id: value.id,
    name: value.name,
    appearance: value.appearance,
    colors,
    fonts: resolvedFonts,
    ...(value.tokens !== undefined ? { tokens: parseThemeTokens(value.tokens) } : {}),
    ...(value.background !== undefined ? { background: parseBackground(value.background) } : {}),
  }
}
