import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'vitest'
import {
  readShortcutPreferences,
  validateShortcutPreferences,
  writeShortcutPreferences,
} from '../src/main/shortcut-preferences'

let testDir = ''

beforeEach(async () => {
  testDir = await mkdtemp(path.join(tmpdir(), 'pi-meme-shortcuts-test-'))
})

afterEach(async () => {
  if (testDir) await rm(testDir, { recursive: true, force: true })
})

test('不存在配置文件时返回默认空覆盖', async () => {
  const result = await readShortcutPreferences(testDir)
  assert.deepEqual(result, { version: 1, overrides: {} })
})

test('正常读写快捷键偏好', async () => {
  const overrides = { newChat: 'Mod+Shift+N', searchSessions: null }
  await writeShortcutPreferences(testDir, { version: 1, overrides })
  const result = await readShortcutPreferences(testDir)
  assert.deepEqual(result, { version: 1, overrides })
})

test('校验拒绝未知动作或无效格式', () => {
  assert.throws(() => validateShortcutPreferences(null), /损坏/)
  assert.throws(() => validateShortcutPreferences({ version: 2, overrides: {} }), /损坏/)
  assert.throws(
    () => validateShortcutPreferences({ version: 1, overrides: { unknownAction: 'Mod+K' } }),
    /未知快捷键动作/,
  )
  assert.throws(() => validateShortcutPreferences({ version: 1, overrides: { newChat: 123 } }), /绑定值无效/)
})
