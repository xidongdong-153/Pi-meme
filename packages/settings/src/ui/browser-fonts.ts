import type { FontStyle, InstalledFont } from '@pi-meme/contracts/settings'
import { fontStyles } from '../shared/appearance'

type LocalFont = { family: string; style: string }
type FontWindow = Window & { queryLocalFonts?: () => Promise<LocalFont[]>; piPlatform?: unknown }

const commonFamilies = [
  'Arial',
  'Arial Unicode MS',
  'Aptos',
  'Calibri',
  'Cambria',
  'Candara',
  'Comic Sans MS',
  'Consolas',
  'Courier New',
  'DejaVu Sans',
  'DejaVu Sans Mono',
  'DengXian',
  'FangSong',
  'Fira Code',
  'Fira Mono',
  'Georgia',
  'Helvetica',
  'Helvetica Neue',
  'IBM Plex Mono',
  'Inter',
  'JetBrains Mono',
  'KaiTi',
  'Liberation Mono',
  'Liberation Sans',
  'LXGW WenKai',
  'Maple Mono',
  'Menlo',
  'Microsoft JhengHei',
  'Microsoft YaHei',
  'Microsoft YaHei UI',
  'Monaco',
  'Noto Sans',
  'Noto Sans CJK SC',
  'Noto Serif CJK SC',
  'NSimSun',
  'PingFang SC',
  'PingFang TC',
  'Roboto',
  'Sarasa Gothic SC',
  'Sarasa Mono SC',
  'Segoe UI',
  'SF Mono',
  'SF Pro Text',
  'SimHei',
  'SimSun',
  'Songti SC',
  'Source Code Pro',
  'Source Han Sans SC',
  'Source Han Serif SC',
  'STHeiti',
  'STKaiti',
  'Tahoma',
  'Times New Roman',
  'Trebuchet MS',
  'Ubuntu',
  'Ubuntu Mono',
  'Verdana',
  'WenQuanYi Micro Hei',
]
const genericFamily =
  /^(?:inherit|initial|unset|revert(?:-layer)?|default|serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-.+|emoji|math)$/i
function validFamily(name: string) {
  if (!name || name.length > 200 || /[;{}<>\\]/.test(name) || genericFamily.test(name)) return false
  for (const character of name) {
    const code = character.charCodeAt(0)
    if (code < 32 || code === 127) return false
  }
  return true
}

export function firstFontFamily(value = '') {
  const first = value.trim().match(/^"(?:[^"\\]|\\.)*"|^'[^']*'|^[^,]+/)?.[0] ?? ''
  if (first.startsWith('"')) {
    try {
      return JSON.parse(first) as string
    } catch {
      return first.slice(1, -1)
    }
  }
  return first.replace(/^'|'$/g, '').trim()
}

export function usesBrowserFonts() {
  return !(window as FontWindow).piPlatform
}

export class BrowserFontCatalog {
  private readonly families = new Map<string, InstalledFont>()
  private localFamilies = new Map<string, InstalledFont>()
  private readonly remembered = new Set<string>()
  private readonly probed = new Map<string, InstalledFont | null>()
  private context: CanvasRenderingContext2D | null | undefined
  private flight?: Promise<InstalledFont[]>

  constructor() {
    this.refreshFallbacks()
  }

  private refreshFallbacks() {
    this.probed.clear()
    this.families.clear()
    for (const family of [...commonFamilies, ...this.remembered]) {
      const font = this.find(family)
      if (font) this.families.set(family.toLowerCase(), font)
    }
    for (const [key, font] of this.localFamilies) this.families.set(key, font)
  }

  get canReadAll() {
    return window.isSecureContext && typeof (window as FontWindow).queryLocalFonts === 'function'
  }

  get hint() {
    if (this.canReadAll) return ''
    return window.isSecureContext
      ? '当前浏览器不支持读取全部字体，可输入本机字体名称。'
      : '读取全部本机字体需要 HTTPS 或 localhost，也可输入字体名称。'
  }

  list() {
    return [...this.families.values()].sort((a, b) => a.family.localeCompare(b.family))
  }

  find(input: string): InstalledFont | null {
    const family = input.trim()
    if (!validFamily(family)) return null
    const key = family.toLowerCase()
    const known = this.localFamilies.get(key)
    if (known) return known
    if (this.probed.has(key)) return this.probed.get(key) ?? null
    try {
      if (this.context === undefined) this.context = document.createElement('canvas').getContext('2d')
      const context = this.context
      if (!context) return null
      const measure = (text: string, stack: string) => {
        context.font = `72px ${stack}`
        return context.measureText(text).width
      }
      const quoted = JSON.stringify(family)
      const sample = 'mmmlli WwQ@ 0123456789 中文字体'
      const drawn = ['monospace', 'serif', 'sans-serif'].some(
        (fallback) => measure(sample, `${quoted}, ${fallback}`) !== measure(sample, fallback),
      )
      const font = drawn
        ? {
            family,
            styles: [...fontStyles],
            monospace:
              Math.abs(measure('iiiiiiii', `${quoted}, monospace`) - measure('WWWWWWWW', `${quoted}, monospace`)) <
                0.01 &&
              Math.abs(measure('00000000', `${quoted}, monospace`) - measure('........', `${quoted}, monospace`)) <
                0.01,
          }
        : null
      this.probed.set(key, font)
      // Keep arbitrary search text out of the catalogue and bound the probe cache.
      if (this.probed.size > 256) this.probed.delete(this.probed.keys().next().value!)
      return font
    } catch {
      // Privacy settings can block canvas access; default fonts and local enumeration still work.
      this.context = undefined
      return null
    }
  }

  remember(family: string) {
    const font = this.find(family)
    if (font) {
      this.remembered.add(font.family)
      this.families.set(font.family.toLowerCase(), font)
    }
  }

  async read(requestAccess = false): Promise<InstalledFont[]> {
    if (!this.canReadAll) return this.list()
    if (requestAccess) return this.enumerate()
    try {
      const permission = await navigator.permissions.query({ name: 'local-fonts' as PermissionName })
      if (permission.state === 'granted') return await this.enumerate()
    } catch {
      // A passive read must not prompt or hide the usable fallback catalogue.
    }
    return this.list()
  }

  private enumerate() {
    if (this.flight) return this.flight
    // Invoke before awaiting anything: the browser requires the button's user activation.
    const task = (window as FontWindow).queryLocalFonts!().then((faces) => {
      const families = new Map<string, InstalledFont>()
      for (const face of faces) {
        if (typeof face.family !== 'string' || !validFamily(face.family)) continue
        const key = face.family.toLowerCase()
        const font: InstalledFont = families.get(key) ?? {
          family: face.family,
          styles: [],
          monospace: this.find(face.family)?.monospace ?? false,
        }
        const name = String(face.style).toLowerCase()
        const bold = /bold|black|heavy|fett|粗|重/.test(name)
        const italic = /italic|oblique|kursiv|斜/.test(name)
        const style: FontStyle = bold ? (italic ? 'bold-italic' : 'bold') : italic ? 'italic' : 'regular'
        if (!font.styles.includes(style)) font.styles.push(style)
        families.set(key, font)
      }
      for (const font of families.values()) {
        font.styles.sort((a, b) => fontStyles.indexOf(a) - fontStyles.indexOf(b))
      }
      this.localFamilies = families
      this.refreshFallbacks()
      return this.list()
    })
    this.flight = task.finally(() => {
      this.flight = undefined
    })
    return this.flight
  }
}
