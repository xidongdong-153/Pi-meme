import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { FontStyle, InstalledFont } from '@pi-meme/contracts/settings'
import { queryWindowsNative } from '@pi-meme/windows-native/runtime'

const execute = promisify(execFile)
const fontScript = `
ObjC.import('AppKit')
var manager = $.NSFontManager.sharedFontManager
JSON.stringify(ObjC.deepUnwrap(manager.availableFontFamilies).map(function (family) {
  return {
    family: ObjC.unwrap(manager.localizedNameForFamilyFace(family, $())),
    members: ObjC.deepUnwrap(manager.availableMembersOfFontFamily(family)) || []
  }
}))
`

export function parseInstalledFonts(value: unknown): InstalledFont[] {
  if (!Array.isArray(value)) throw new Error('系统字体列表格式无效')
  const families = new Map<string, InstalledFont>()
  for (const font of value) {
    if (
      !font ||
      typeof font !== 'object' ||
      typeof font.family !== 'string' ||
      !font.family.trim() ||
      !Array.isArray(font.members)
    )
      throw new Error('系统字体列表格式无效')
    const installed: InstalledFont = families.get(font.family) ?? { family: font.family, styles: [], monospace: false }
    for (const member of font.members) {
      if (
        !Array.isArray(member) ||
        typeof member[0] !== 'string' ||
        typeof member[1] !== 'string' ||
        typeof member[2] !== 'number' ||
        !Number.isFinite(member[2]) ||
        !Number.isInteger(member[3])
      )
        throw new Error('系统字体列表格式无效')
      const traits = member[3]
      const bold = (traits & 2) !== 0
      const italic = (traits & 1) !== 0
      const regular = member[2] === 5 || /regular|normal|常规|标准|roman|book/i.test(member[1])
      if (!bold && !italic && !regular) continue
      const style: FontStyle = bold ? (italic ? 'bold-italic' : 'bold') : italic ? 'italic' : 'regular'
      if (!installed.styles.includes(style)) installed.styles.push(style)
      installed.monospace ||= (traits & 1024) !== 0
    }
    if (installed.styles.length) families.set(font.family, installed)
  }
  return [...families.values()].sort((a, b) => a.family.localeCompare(b.family))
}
let cached: Promise<InstalledFont[]> | undefined
export function parseWindowsFonts(value: unknown): InstalledFont[] {
  if (!Array.isArray(value)) throw new Error('系统字体列表格式无效')
  const families = new Map<string, InstalledFont>()
  for (const font of value) {
    if (!font || typeof font.family !== 'string' || !font.family.trim() || !Array.isArray(font.faces))
      throw new Error('系统字体列表格式无效')
    const installed = families.get(font.family) ?? { family: font.family, styles: [] as FontStyle[], monospace: false }
    for (const face of font.faces) {
      if (
        !face ||
        !Number.isInteger(face.weight) ||
        face.weight < 1 ||
        face.weight > 999 ||
        typeof face.italic !== 'boolean' ||
        typeof face.monospace !== 'boolean'
      )
        throw new Error('系统字体列表格式无效')
      const bold = face.weight >= 600
      const style: FontStyle = bold ? (face.italic ? 'bold-italic' : 'bold') : face.italic ? 'italic' : 'regular'
      if (!installed.styles.includes(style)) installed.styles.push(style)
      installed.monospace ||= face.monospace
    }
    if (installed.styles.length) families.set(installed.family, installed)
  }
  return [...families.values()].sort((a, b) => a.family.localeCompare(b.family))
}
export function getInstalledFonts(): Promise<InstalledFont[]> {
  if (!['darwin', 'win32'].includes(process.platform)) return Promise.resolve([])
  cached ??= (
    process.platform === 'win32'
      ? queryWindowsNative('fonts').then(parseWindowsFonts)
      : execute('/usr/bin/osascript', ['-l', 'JavaScript', '-e', fontScript], {
          timeout: 5000,
          maxBuffer: 1024 * 1024,
        }).then(({ stdout }) => parseInstalledFonts(JSON.parse(stdout)))
  ).catch((cause) => {
    cached = undefined
    throw new Error(`无法读取系统字体：${String(cause)}`)
  })
  return cached
}
