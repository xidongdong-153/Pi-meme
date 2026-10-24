import assert from 'node:assert/strict'
import { test } from 'vitest'
import {
  defaultKeybinding,
  formatKeybindingDisplay,
  isAllowedKeybinding,
  isReservedKeybinding,
  keybindingFromEvent,
  keybindingMatchesEvent,
  keybindingsConflict,
  normalizeKeybinding,
  resolveKeybinding,
  SHORTCUT_DEFINITIONS,
  SHORTCUT_IDS,
} from '../src/keyboard-shortcuts'

test('包含全部 13 个快捷键定义且无重复动作 ID', () => {
  assert.equal(SHORTCUT_DEFINITIONS.length, 13)
  const ids = SHORTCUT_DEFINITIONS.map((def) => def.id)
  assert.deepEqual(ids.sort(), [...SHORTCUT_IDS].sort())
  assert.equal(new Set(ids).size, 13)
})

test('Desktop 与 Web 默认键位正确解析且无内部冲突', () => {
  for (const env of ['desktop', 'web'] as const) {
    const bindings = SHORTCUT_DEFINITIONS.map((def) => defaultKeybinding(def, env))
    assert.equal(bindings.length, 13)
    assert.equal(new Set(bindings).size, 13, `${env} 默认键位存在冲突`)
  }

  const newChat = SHORTCUT_DEFINITIONS.find((d) => d.id === 'newChat')!
  assert.equal(defaultKeybinding(newChat, 'desktop'), 'Mod+N')
  assert.equal(defaultKeybinding(newChat, 'web'), 'Mod+Alt+N')

  const toggleTools = SHORTCUT_DEFINITIONS.find((d) => d.id === 'toggleTools')!
  assert.equal(defaultKeybinding(toggleTools, 'desktop'), 'Mod+J')
  assert.equal(defaultKeybinding(toggleTools, 'web'), 'Mod+Alt+Shift+J')

  const modelPicker = SHORTCUT_DEFINITIONS.find((d) => d.id === 'openModelPicker')!
  assert.equal(defaultKeybinding(modelPicker, 'desktop'), 'Mod+Alt+Shift+M')
  assert.equal(defaultKeybinding(modelPicker, 'web'), 'Mod+Alt+Shift+M')
})

test('normalizeKeybinding 规范化修饰键顺序与键名', () => {
  assert.equal(normalizeKeybinding('Alt+Mod+k'), 'Mod+Alt+K')
  assert.equal(normalizeKeybinding('Shift+Cmd+l'), 'Mod+Shift+L')
  assert.equal(normalizeKeybinding('Meta+Comma'), 'Mod+Comma')
  assert.equal(normalizeKeybinding('ctrl+shift+p'), 'Ctrl+Shift+P')
  assert.equal(normalizeKeybinding(''), null)
  assert.equal(normalizeKeybinding('Mod+'), null)
  assert.equal(normalizeKeybinding('Invalid+K'), null)
})

test('isAllowedKeybinding 要求包含修饰键与非修饰键', () => {
  assert.equal(isAllowedKeybinding('Mod+K'), true)
  assert.equal(isAllowedKeybinding('Mod+Shift+L'), true)
  assert.equal(isAllowedKeybinding('K'), false)
  assert.equal(isAllowedKeybinding('Enter'), false)
  assert.equal(isAllowedKeybinding('F1'), false)
})

test('isReservedKeybinding 识别系统与浏览器保留组合', () => {
  assert.equal(isReservedKeybinding('Mod+C', 'darwin', 'desktop'), true)
  assert.equal(isReservedKeybinding('Mod+V', 'win32', 'desktop'), true)
  assert.equal(isReservedKeybinding('Mod+Q', 'darwin', 'desktop'), true)
  assert.equal(isReservedKeybinding('Mod+Q', 'win32', 'desktop'), false)
  assert.equal(isReservedKeybinding('Alt+F4', 'win32', 'desktop'), true)
  assert.equal(isReservedKeybinding('Mod+T', 'darwin', 'web'), true)
  assert.equal(isReservedKeybinding('Mod+T', 'darwin', 'desktop'), false)
})

test('resolveKeybinding 处理覆盖、禁用与默认回退', () => {
  const def = SHORTCUT_DEFINITIONS.find((d) => d.id === 'newChat')!
  assert.equal(resolveKeybinding(def, undefined, 'desktop'), 'Mod+N')
  assert.equal(resolveKeybinding(def, { newChat: 'Mod+Shift+N' }, 'desktop'), 'Mod+Shift+N')
  assert.equal(resolveKeybinding(def, { newChat: null }, 'desktop'), null)
  assert.equal(resolveKeybinding(def, {}, 'web'), 'Mod+Alt+N')
})

test('keybindingMatchesEvent 精确区分 macOS 与 Windows/Linux 修饰键', () => {
  const darwinEvent = { key: 'k', code: 'KeyK', metaKey: true, ctrlKey: false }
  assert.equal(keybindingMatchesEvent('Mod+K', darwinEvent, 'darwin'), true)
  assert.equal(keybindingMatchesEvent('Mod+K', darwinEvent, 'win32'), false)

  const winEvent = { key: 'k', code: 'KeyK', metaKey: false, ctrlKey: true }
  assert.equal(keybindingMatchesEvent('Mod+K', winEvent, 'win32'), true)
  assert.equal(keybindingMatchesEvent('Mod+K', winEvent, 'darwin'), false)

  const extraModEvent = { key: 'k', code: 'KeyK', metaKey: true, altKey: true }
  assert.equal(keybindingMatchesEvent('Mod+K', extraModEvent, 'darwin'), false)
})

test('keybindingFromEvent 优先使用物理 code 避免输入法或符号影响', () => {
  const event = { key: '，', code: 'Comma', metaKey: true }
  assert.equal(keybindingFromEvent(event, 'darwin'), 'Mod+Comma')
  const slashEvent = { key: '?', code: 'Slash', metaKey: true, shiftKey: true }
  assert.equal(keybindingFromEvent(slashEvent, 'darwin'), 'Mod+Shift+Slash')
  // 纯修饰键返回 null
  assert.equal(keybindingFromEvent({ key: 'Shift', metaKey: true, shiftKey: true }, 'darwin'), null)
})

test('formatKeybindingDisplay 格式化平台可读键位', () => {
  assert.equal(formatKeybindingDisplay('Mod+K', 'darwin'), '⌘K')
  assert.equal(formatKeybindingDisplay('Mod+Shift+L', 'darwin'), '⌘⇧L')
  assert.equal(formatKeybindingDisplay('Mod+Comma', 'darwin'), '⌘,')
  assert.equal(formatKeybindingDisplay('Mod+K', 'win32'), 'Ctrl+K')
  assert.equal(formatKeybindingDisplay('Mod+Alt+P', 'linux'), 'Ctrl+Alt+P')
  assert.equal(formatKeybindingDisplay(null, 'darwin'), '')
})

test('keybindingsConflict 比较规范化后的组合', () => {
  assert.equal(keybindingsConflict('Mod+K', 'Cmd+k'), true)
  assert.equal(keybindingsConflict('Mod+Alt+N', 'Alt+Mod+N'), true)
  assert.equal(keybindingsConflict('Mod+K', 'Mod+J'), false)
  assert.equal(keybindingsConflict(null, 'Mod+K'), false)
})
