// @vitest-environment jsdom
import assert from 'node:assert/strict'
import { afterEach, beforeEach, test, vi } from 'vitest'
import { loadClientShortcuts, saveClientShortcuts, WEB_STORAGE_KEY } from '../src/shortcuts/shortcut-storage'
import type { PlatformAdapter } from '@pi-meme/contracts/host'

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  window.localStorage.clear()
  vi.restoreAllMocks()
})

test('Web 环境下默认从 localStorage 读取并能成功写入', async () => {
  const initial = await loadClientShortcuts()
  assert.deepEqual(initial, { version: 1, overrides: {} })

  const next = { version: 1 as const, overrides: { newChat: 'Mod+Alt+N' } }
  await saveClientShortcuts(next)

  const reloaded = await loadClientShortcuts()
  assert.deepEqual(reloaded, next)
})

test('Web 环境损坏 JSON 会抛错', async () => {
  window.localStorage.setItem(WEB_STORAGE_KEY, 'invalid json')
  await assert.rejects(async () => loadClientShortcuts(), /解析失败/)
})

test('Desktop 优先使用 platform.shortcuts', async () => {
  const mockShortcuts = {
    read: vi.fn().mockResolvedValue({ version: 1, overrides: { openSettings: 'Mod+Alt+Comma' } }),
    save: vi.fn().mockResolvedValue(undefined),
  }
  const platform = { shortcuts: mockShortcuts } as unknown as PlatformAdapter

  const data = await loadClientShortcuts(platform)
  assert.deepEqual(data, { version: 1, overrides: { openSettings: 'Mod+Alt+Comma' } })
  assert.equal(mockShortcuts.read.mock.calls.length, 1)

  await saveClientShortcuts({ version: 1, overrides: {} }, platform)
  assert.equal(mockShortcuts.save.mock.calls.length, 1)
})
