import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'
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
import { storageLayoutRelativePaths } from '@pi-meme/contracts/storage-paths'
import { SettingsStore } from '../src/server/store'
import { getInstalledFonts, parseInstalledFonts } from '../src/server/fonts'
import { AppearanceSaver } from '../src/ui/appearance-save'
import type { AppearanceSettings, SettingsSnapshot } from '@pi-meme/contracts/settings'

const executeFonts = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (importOriginal) => {
  const childProcess = await importOriginal<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  return {
    ...childProcess,
    execFile: Object.assign(vi.fn(), { [promisify.custom]: executeFonts }),
  }
})
afterEach(() => vi.unstubAllGlobals())

function snapshot(appearance: AppearanceSettings): SettingsSnapshot {
  return {
    settings: { themeId: 'dark', appearance },
    themes: builtinThemes,
    errors: [],
    themesDirectory: '',
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
    const filename = path.join(directory, storageLayoutRelativePaths.appConfigFile)
    await mkdir(path.dirname(filename), { recursive: true })
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
test('原生字体保留中文名，合并字体族的实际样式和等宽属性', () => {
  const fonts = parseInstalledFonts([
    { family: '苹方-简', members: [['PingFangSC-Regular', '常规', 5, 0]] },
    {
      family: 'Mono',
      members: [
        ['Mono-Regular', 'Regular', 5, 1028],
        ['Mono-Oblique', '倾斜', 5, 1025],
      ],
    },
    {
      family: 'Mono',
      members: [
        ['Mono-Bold', '粗体', 9, 1026],
        ['Mono-BoldItalic', '粗斜体', 9, 1027],
        ['Mono-Regular', 'Regular', 5, 1028],
      ],
    },
    { family: 'Light Only', members: [['LightOnly', 'Light', 3, 0]] },
  ])
  assert.deepEqual(
    fonts.find((font) => font.family === 'Mono'),
    { family: 'Mono', styles: ['regular', 'italic', 'bold', 'bold-italic'], monospace: true },
  )
  assert.deepEqual(
    fonts.find((font) => font.family === '苹方-简'),
    {
      family: '苹方-简',
      styles: ['regular'],
      monospace: false,
    },
  )
  assert.equal(fonts.length, 2)
  assert.deepEqual(
    fonts,
    [...fonts].sort((a, b) => a.family.localeCompare(b.family)),
  )
  assert.deepEqual(parseInstalledFonts([]), [])
})
test('原生字体数据结构无效时拒绝读取，不把损坏数据缓存为空列表', () => {
  for (const value of [
    null,
    {},
    { SPFontsDataType: [] },
    [null],
    [{ family: '', members: [] }],
    [{ family: 'Invalid', members: null }],
    [{ family: 'Invalid', members: [[]] }],
    [{ family: 'Invalid', members: [['Invalid', 'Regular', 5, '1024']] }],
  ])
    assert.throws(() => parseInstalledFonts(value), /格式无效/)
})
test('字体读取失败和解析失败可重试，并发与成功结果共用 Host 缓存', async () => {
  vi.stubGlobal('process', { ...process, platform: 'darwin' })
  executeFonts.mockReset()
  executeFonts
    .mockRejectedValueOnce(new Error('测试权限不足'))
    .mockResolvedValueOnce({ stdout: '{bad' })
    .mockResolvedValueOnce({ stdout: '[{"family":"Mono","members":[["Mono-Regular","Regular",5,1028]]}]' })
  const first = getInstalledFonts()
  assert.equal(first, getInstalledFonts())
  await assert.rejects(first, /无法读取系统字体.*测试权限不足/)
  await assert.rejects(getInstalledFonts(), /无法读取系统字体/)
  const retry = getInstalledFonts()
  assert.equal(retry, getInstalledFonts())
  const fonts = await retry
  assert.deepEqual(fonts, [{ family: 'Mono', styles: ['regular'], monospace: true }])
  assert.equal(getInstalledFonts(), retry)
  assert.equal(await getInstalledFonts(), fonts)
  assert.equal(executeFonts.mock.calls.length, 3)
  const [command, args, options] = executeFonts.mock.calls[0]
  assert.equal(command, '/usr/bin/osascript')
  assert.deepEqual(args.slice(0, 3), ['-l', 'JavaScript', '-e'])
  assert.match(args[3], /NSFontManager/)
  assert.deepEqual(options, { timeout: 5000, maxBuffer: 1024 * 1024 })
})
test('非 macOS Host 不启动字体枚举，保持空列表', async () => {
  executeFonts.mockReset()
  for (const platform of ['linux', 'win32']) {
    vi.stubGlobal('process', { ...process, platform })
    assert.deepEqual(await getInstalledFonts(), [])
  }
  assert.equal(executeFonts.mock.calls.length, 0)
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
    const filename = path.join(directory, storageLayoutRelativePaths.appConfigFile)
    await mkdir(`${filename}.tmp`)
    await assert.rejects(store.saveAppearance({ ...defaultAppearance(), uiSize: 20 }))
    assert.equal(store.settings.appearance?.uiSize, 14)
    assert.equal(JSON.parse(await readFile(filename, 'utf8')).appearance.uiSize, 14)
    await rm(`${filename}.tmp`, { recursive: true })
    await store.saveAppearance({ ...defaultAppearance(), uiSize: 20 })
    assert.equal(store.settings.appearance?.uiSize, 20)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
