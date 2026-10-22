import path from 'node:path'
import { SHORTCUT_IDS, type ShortcutId, type ShortcutPreferences } from '@pi-meme/contracts/keyboard-shortcuts'
import { readJson, writeJson } from '@pi-meme/host/storage/files'

export function validateShortcutPreferences(value: unknown): asserts value is ShortcutPreferences {
  if (!value || typeof value !== 'object' || (value as { version?: unknown }).version !== 1) {
    throw new Error('快捷键配置文件损坏或版本不匹配')
  }
  const overrides = (value as { overrides?: unknown }).overrides
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error('快捷键配置 overrides 字段无效')
  }
  for (const [key, val] of Object.entries(overrides)) {
    if (!SHORTCUT_IDS.includes(key as ShortcutId)) {
      throw new Error(`未知快捷键动作: ${key}`)
    }
    if (val !== null && typeof val !== 'string') {
      throw new Error(`快捷键动作 ${key} 绑定值无效`)
    }
  }
}

export async function readShortcutPreferences(userDataDir: string): Promise<ShortcutPreferences> {
  const file = path.join(userDataDir, 'keyboard-shortcuts.json')
  const data = await readJson<unknown>(file)
  if (data === undefined) {
    return { version: 1, overrides: {} }
  }
  validateShortcutPreferences(data)
  return data
}

export async function writeShortcutPreferences(userDataDir: string, value: unknown): Promise<ShortcutPreferences> {
  validateShortcutPreferences(value)
  const file = path.join(userDataDir, 'keyboard-shortcuts.json')
  await writeJson(file, value)
  return value
}
