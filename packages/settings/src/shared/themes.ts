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
    id: 'pi-orange',
    name: 'Pi Orange',
    appearance: 'dark',
    fonts,
    colors: {
      background: '#19120f',
      surface: '#211814',
      elevated: '#2f2520',
      text: '#eadfd8',
      muted: '#b19f92',
      border: '#3d312b',
      accent: '#fb923c',
      accentText: '#120d0b',
      success: '#9cd67a',
      error: '#f28b82',
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
    id: 'dracula',
    name: 'Dracula',
    appearance: 'dark',
    fonts,
    colors: {
      background: '#21222c',
      surface: '#282a36',
      elevated: '#343746',
      text: '#f8f8f2',
      muted: '#6272a4',
      border: '#44475a',
      accent: '#bd93f9',
      accentText: '#21222c',
      success: '#50fa7b',
      error: '#ff5555',
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
    id: 'rose-pine-dawn',
    name: 'Rosé Pine Dawn',
    appearance: 'light',
    fonts,
    colors: {
      background: '#faf4ed',
      surface: '#fffaf3',
      elevated: '#f2e9e1',
      text: '#464261',
      muted: '#797593',
      border: '#dfdad9',
      accent: '#d7827e',
      accentText: '#faf4ed',
      success: '#286983',
      error: '#b4637a',
    },
  },
  {
    id: 'rose-pine-moon',
    name: 'Rosé Pine Moon',
    appearance: 'dark',
    fonts,
    colors: {
      background: '#232136',
      surface: '#2a273f',
      elevated: '#393552',
      text: '#e0def4',
      muted: '#908caa',
      border: '#44415a',
      accent: '#ea9a97',
      accentText: '#232136',
      success: '#3e8fb0',
      error: '#eb6f92',
    },
  },
  {
    id: 'rose-pine',
    name: 'Rosé Pine',
    appearance: 'dark',
    fonts,
    colors: {
      background: '#191724',
      surface: '#1f1d2e',
      elevated: '#26233a',
      text: '#e0def4',
      muted: '#908caa',
      border: '#403d52',
      accent: '#ebbcba',
      accentText: '#191724',
      success: '#31748f',
      error: '#eb6f92',
    },
  },
  {
    id: 'shades-of-purple',
    name: 'Shades of Purple',
    appearance: 'dark',
    fonts,
    colors: {
      background: '#1e1e3f',
      surface: '#2d2b55',
      elevated: '#262650',
      text: '#ffffff',
      muted: '#a599e9',
      border: '#353366',
      accent: '#b362ff',
      accentText: '#ffffff',
      success: '#3ad900',
      error: '#ec3a37',
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
