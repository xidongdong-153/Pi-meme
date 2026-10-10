import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  defaultAppearance,
  editingOverrides,
  migrateAppearance,
  resolveTheme,
  resolvedMode,
  selectAppearanceTheme,
  setOverrides,
  toggleSeparate,
  validateAppearance,
} from '../src/shared/appearance'
import { builtinThemes, parseTheme } from '../src/shared/themes'
import { SettingsStore } from '../src/server/store'
import { parseInstalledFonts } from '../src/server/fonts'
import { AppearanceSaver } from '../src/ui/appearance-save'
import type { AppearanceSettings, SettingsSnapshot } from '@pi-meme/contracts/settings'

function snapshot(appearance: AppearanceSettings): SettingsSnapshot {
  return {
    settings: { themeId: 'dark', appearance },
    themes: builtinThemes,
    errors: [],
    themesDirectory: '',
    extensionsDirectory: '',
  }
}
test('旧主题按明暗迁移，新设置跟随系统，系统变化选择匹配模式', () => {
  const value = defaultAppearance()
  assert.equal(value.mode, 'system')
  assert.equal(resolvedMode(value, true), 'dark')
  assert.equal(resolvedMode(value, false), 'light')
  const custom = { ...builtinThemes[1], id: 'custom' }
  assert.equal(migrateAppearance({ themeId: 'custom' }, [...builtinThemes, custom]).lightThemeId, 'custom')
  assert.equal(migrateAppearance({ themeId: 'dark' }, builtinThemes).mode, 'dark')
})
test('共享覆盖值复制为独立配置，关闭时共享当前侧，再开启恢复两侧', () => {
  let value = setOverrides(defaultAppearance(), 'dark', { colors: { accent: '#123456' } })
  assert.equal(resolveTheme(value, builtinThemes, 'light').colors.accent, '#123456')
  value = toggleSeparate(value, 'dark', true)
  value = setOverrides(value, 'light', { colors: { accent: '#abcdef' } })
  assert.equal(editingOverrides(value, 'dark').colors?.accent, '#123456')
  value = toggleSeparate(value, 'light', false)
  assert.equal(value.shared.colors?.accent, '#abcdef')
  value = toggleSeparate(value, 'light', true)
  assert.equal(value.dark?.colors?.accent, '#123456')
  const reset = selectAppearanceTheme({ ...value, uiSize: 18 }, builtinThemes[0])
  assert.deepEqual(reset.dark, {})
  assert.equal(reset.uiSize, 18)
  assert.equal(defaultAppearance().uiSize, 14)
})
test('非法颜色、字号、字体及样式被拒绝，对比度只改变层次颜色', () => {
  for (const patch of [
    { uiSize: 11 },
    { codeSize: 25 },
    { contrast: NaN },
    { uiSize: 14.5 },
    { reducedMotion: 'invalid' },
    { mode: ['system'] },
    { shared: { colors: { accent: '#fff' } } },
    { shared: { fonts: { ui: 'x; color:red' } } },
    { shared: { fontStyles: { code: 'heavy' } } },
  ])
    assert.throws(() => validateAppearance({ ...defaultAppearance(), ...patch }))
  const value = defaultAppearance()
  assert.deepEqual(resolveTheme(value, builtinThemes, 'dark').colors, builtinThemes[0].colors)
  for (const contrast of [0, 100]) {
    const next = resolveTheme({ ...value, contrast }, builtinThemes, 'dark')
    for (const key of ['background', 'text', 'accent'] as const)
      assert.equal(next.colors[key], builtinThemes[0].colors[key])
    assert.notEqual(next.colors.border, builtinThemes[0].colors.border)
  }
  const custom = parseTheme({
    ...builtinThemes[0],
    fonts: { ...builtinThemes[0].fonts, content: 'Georgia' },
    fontStyles: { content: 'italic' },
  })
  assert.equal(custom.fonts.content, 'Georgia')
  assert.equal(custom.fontStyles?.content, 'italic')
})
test('读取旧配置不写文件，独立保存保留运行配置，导入导出兼容并拒绝重复 ID', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-appearance-'))
  try {
    const filename = path.join(directory, 'settings.json')
    const original = JSON.stringify({
      themeId: 'light',
      pinnedPaths: ['项目'],
      preferredProjectApp: 'zed',
    })
    await writeFile(filename, original)
    const store = new SettingsStore(directory)
    await store.load()
    assert.equal(await readFile(filename, 'utf8'), original)
    await Promise.all([store.saveAppearance({ ...defaultAppearance(), uiSize: 18 }), store.togglePin('另一个项目')])
    assert.equal(store.settings.appearance?.uiSize, 18)
    assert.equal(store.settings.appearance?.mode, 'system')
    assert.equal(store.settings.preferredProjectApp, 'zed')
    assert.deepEqual(store.settings.pinnedPaths, ['项目', '另一个项目'])
    await store.save({ ...store.settings, preferredProjectApp: 'vscode' })
    assert.equal(store.settings.appearance?.uiSize, 18)
    const exported = path.join(directory, 'export.json')
    await store.exportTheme(exported, {
      ...builtinThemes[0],
      id: 'exported',
      fonts: { ...builtinThemes[0].fonts, content: 'Georgia' },
      fontStyles: { content: 'italic' },
    })
    const imported = await store.importTheme(exported)
    assert.equal(imported.themes.find((theme) => theme.id === 'exported')?.fontStyles?.content, 'italic')
    await assert.rejects(store.importTheme(exported), /已存在/)
    await writeFile(exported, '{bad')
    await assert.rejects(store.importTheme(exported))
    const restart = new SettingsStore(directory)
    assert.equal((await restart.load()).settings.appearance?.uiSize, 18)
    await assert.rejects(store.saveAppearance({ ...defaultAppearance(), lightThemeId: 'dark' }), /不匹配/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
test('本机字体按字体族合并实际样式，拒绝无效字体列表', () => {
  const fonts = parseInstalledFonts({
    SPFontsDataType: [
      {
        typefaces: [
          { family: 'Mono', style: 'Regular' },
          { family: 'Mono', style: 'Bold Italic' },
          { family: 'Hidden', enabled: 'no' },
        ],
      },
    ],
  })
  assert.deepEqual(fonts, [{ family: 'Mono', styles: ['regular', 'bold-italic'] }])
  assert.throws(() => parseInstalledFonts({}), /格式无效/)
})
test('连续修改合并保存，保存过程中更新不被旧结果覆盖，离开页面立即刷新', async () => {
  const calls: number[] = []
  const accepted: boolean[] = []
  let finish!: (value: SettingsSnapshot) => void
  const saver = new AppearanceSaver(
    async (value) => {
      calls.push(value.uiSize)
      if (calls.length === 1)
        return new Promise((resolve) => {
          finish = resolve
        })
      return snapshot(value)
    },
    (_, current) => accepted.push(current),
    () => assert.fail('不得失败'),
  )
  saver.schedule({ ...defaultAppearance(), uiSize: 15 })
  saver.schedule({ ...defaultAppearance(), uiSize: 16 })
  const flushing = saver.flush()
  saver.schedule({ ...defaultAppearance(), uiSize: 18 })
  finish(snapshot({ ...defaultAppearance(), uiSize: 16 }))
  await flushing
  assert.deepEqual(calls, [16, 18])
  assert.deepEqual(accepted, [false, true])
})
test('保存失败回滚当前预览，旧保存失败仍继续提交新编辑', async () => {
  const failures: boolean[] = []
  let reject!: (cause: Error) => void
  const saver = new AppearanceSaver(
    async (value) => {
      if (value.uiSize === 15)
        return new Promise((_, fail) => {
          reject = fail
        })
      return snapshot(value)
    },
    () => {},
    (_, current) => failures.push(current),
  )
  saver.schedule({ ...defaultAppearance(), uiSize: 15 })
  const flushing = saver.flush()
  saver.schedule({ ...defaultAppearance(), uiSize: 18 })
  reject(new Error('磁盘不可写'))
  await flushing
  assert.deepEqual(failures, [false])
  saver.schedule({ ...defaultAppearance(), uiSize: 15 })
  const failed = saver.flush()
  reject(new Error('磁盘不可写'))
  await failed
  assert.deepEqual(failures, [false, true])
})

test('磁盘写入失败保留最后成功配置，恢复写入后可继续保存', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-appearance-failure-'))
  const store = new SettingsStore(directory)
  try {
    await store.load()
    await store.saveAppearance(defaultAppearance())
    await mkdir(path.join(directory, 'settings.json.tmp'))
    await assert.rejects(store.saveAppearance({ ...defaultAppearance(), uiSize: 20 }))
    assert.equal(store.settings.appearance?.uiSize, 14)
    assert.equal(JSON.parse(await readFile(path.join(directory, 'settings.json'), 'utf8')).appearance.uiSize, 14)
    await rm(path.join(directory, 'settings.json.tmp'), { recursive: true })
    await store.saveAppearance({ ...defaultAppearance(), uiSize: 20 })
    assert.equal(store.settings.appearance?.uiSize, 20)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
