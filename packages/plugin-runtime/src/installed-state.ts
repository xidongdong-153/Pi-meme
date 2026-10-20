import { open, mkdir, readFile, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { PluginGrant } from '@pi-meme/plugin-sdk/permissions'

export type SavedPlugin = {
  id: string
  directory: string
  builtin?: boolean
  enabled: boolean
  sourceDirectory?: string
  policyHash?: string
  grant?: PluginGrant
  [key: string]: unknown
}
export type InstalledState = {
  format: 'pi-meme-plugins'
  version: 1
  generationHighWaterMark: number
  records: SavedPlugin[]
}
export function installedState(generationHighWaterMark: number, records: SavedPlugin[]): InstalledState {
  return { format: 'pi-meme-plugins', version: 1, generationHighWaterMark, records }
}
export async function readInstalledState(directory: string): Promise<InstalledState> {
  let source: string
  try {
    source = await readFile(path.join(directory, 'installed.json'), 'utf8')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return installedState(0, [])
    throw cause
  }
  const value: unknown = JSON.parse(source)
  const state = Array.isArray(value) ? installedState(0, value as SavedPlugin[]) : (value as InstalledState)
  if (!state || state.format !== 'pi-meme-plugins' || state.version !== 1)
    throw new Error('已安装插件清单 schema 版本不支持')
  if (!Number.isSafeInteger(state.generationHighWaterMark) || state.generationHighWaterMark < 0)
    throw new Error('插件代次高水位必须是非负 safe integer')
  if (!Array.isArray(state.records)) throw new Error('已安装插件清单 records 必须是数组')
  const seen = new Set<string>()
  for (const item of state.records) {
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      typeof item.id !== 'string' ||
      !item.id ||
      typeof item.directory !== 'string' ||
      !item.directory ||
      typeof item.enabled !== 'boolean' ||
      (item.builtin !== undefined && typeof item.builtin !== 'boolean') ||
      (item.sourceDirectory !== undefined && typeof item.sourceDirectory !== 'string')
    )
      throw new Error('已安装插件记录字段无效')
    if (seen.has(item.id)) throw new Error(`已安装插件 ID 重复：${item.id}`)
    seen.add(item.id)
  }
  return state
}

/** 确认文件与目录均已同步后，调用方才能使用预留的代次。 */
export async function writeInstalledState(directory: string, state: InstalledState) {
  await mkdir(directory, { recursive: true })
  const temporary = path.join(directory, `installed-${randomUUID()}.tmp`)
  try {
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(JSON.stringify(state, null, 2))
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, path.join(directory, 'installed.json'))
    const parent = await open(directory, 'r')
    try {
      await parent.sync()
    } finally {
      await parent.close()
    }
  } finally {
    await rm(temporary, { force: true })
  }
}
