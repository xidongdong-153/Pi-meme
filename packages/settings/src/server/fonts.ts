import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { FontStyle, InstalledFont } from '@pi-meme/contracts/settings'

const execute = promisify(execFile)
export function parseInstalledFonts(value: unknown): InstalledFont[] {
  if (!value || typeof value !== 'object' || !('SPFontsDataType' in value) || !Array.isArray(value.SPFontsDataType))
    throw new Error('系统字体列表格式无效')
  const families = new Map<string, Set<FontStyle>>()
  for (const file of value.SPFontsDataType) {
    if (file.enabled === 'no' || file.valid === 'no' || !Array.isArray(file.typefaces)) continue
    for (const face of file.typefaces) {
      if (typeof face.family !== 'string' || face.enabled === 'no' || face.valid === 'no') continue
      const style = `${face.style ?? ''} ${face._name ?? ''}`
      const bold = /bold|粗体/i.test(style)
      const italic = /italic|oblique|斜体/i.test(style)
      const regular = /regular|normal|常规|标准|roman|book/i.test(style)
      if (!bold && !italic && !regular) continue
      const name: FontStyle = bold ? (italic ? 'bold-italic' : 'bold') : italic ? 'italic' : 'regular'
      const styles = families.get(face.family) ?? new Set<FontStyle>()
      styles.add(name)
      families.set(face.family, styles)
    }
  }
  return [...families]
    .map(([family, styles]) => ({ family, styles: [...styles] }))
    .sort((a, b) => a.family.localeCompare(b.family))
}
let cached: Promise<InstalledFont[]> | undefined
export function getInstalledFonts(): Promise<InstalledFont[]> {
  if (process.platform !== 'darwin') return Promise.resolve([])
  cached ??= execute('/usr/sbin/system_profiler', ['SPFontsDataType', '-json'], {
    timeout: 30000,
    maxBuffer: 16 * 1024 * 1024,
  })
    .then(({ stdout }) => parseInstalledFonts(JSON.parse(stdout)))
    .catch((cause) => {
      cached = undefined
      throw new Error(`无法读取系统字体：${String(cause)}`)
    })
  return cached
}
