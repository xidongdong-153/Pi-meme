import type { PlatformAdapter } from '@pi-meme/contracts/host'
import { SHORTCUT_IDS, type ShortcutId, type ShortcutPreferences } from '@pi-meme/contracts/keyboard-shortcuts'

export const WEB_STORAGE_KEY = 'pi-meme:shortcuts:v1'

export function validatePreferencesShape(value: unknown): asserts value is ShortcutPreferences {
  if (!value || typeof value !== 'object' || (value as { version?: unknown }).version !== 1) {
    throw new Error('快捷键配置损坏或格式不匹配')
  }
  const overrides = (value as { overrides?: unknown }).overrides
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error('快捷键 overrides 字段无效')
  }
  for (const [key, val] of Object.entries(overrides)) {
    if (!SHORTCUT_IDS.includes(key as ShortcutId)) {
      throw new Error(`未知快捷键动作: ${key}`)
    }
    if (val !== null && typeof val !== 'string') {
      throw new Error(`快捷键动作 ${key} 的值无效`)
    }
  }
}

export async function loadClientShortcuts(platform?: PlatformAdapter): Promise<ShortcutPreferences> {
  if (platform?.shortcuts) {
    const data = await platform.shortcuts.read()
    validatePreferencesShape(data)
    return data
  }

  if (typeof window === 'undefined' || !window.localStorage) {
    return { version: 1, overrides: {} }
  }

  const raw = window.localStorage.getItem(WEB_STORAGE_KEY)
  if (!raw) {
    return { version: 1, overrides: {} }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new Error(`快捷键配置解析失败：${String(cause)}`)
  }
  validatePreferencesShape(parsed)
  return parsed
}

export async function saveClientShortcuts(value: ShortcutPreferences, platform?: PlatformAdapter): Promise<void> {
  validatePreferencesShape(value)

  if (platform?.shortcuts) {
    await platform.shortcuts.save(value)
    return
  }

  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(WEB_STORAGE_KEY, JSON.stringify(value))
  }
}
