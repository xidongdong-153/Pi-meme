import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SettingsStore } from '../src/server/store'
import { builtinThemes, parseTheme } from '../src/shared/themes'

test('未配置的个人资料使用通用默认值，空白字段保存后仍可恢复', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-default-profile-'))
  try {
    const store = new SettingsStore(directory)
    const expected = {
      name: 'meme 用户',
      username: '@meme',
      email: 'meme@example.com',
      avatarText: 'M',
      avatarUrl: undefined,
    }
    assert.deepEqual(await store.getUserProfile(), expected)

    const profileFile = path.join(store.profileDirectory, 'profile.json')
    await writeFile(profileFile, JSON.stringify({ name: ' ', username: '', email: '\t', avatarText: '' }))
    assert.deepEqual(await store.getUserProfile(), expected)
    assert.deepEqual(await store.saveUserProfile({ name: '', username: ' ', email: '', avatarText: ' ' }), expected)
    const saved = JSON.parse(await readFile(profileFile, 'utf8'))
    for (const key of ['name', 'username', 'email', 'avatarText'] as const) assert.equal(saved[key], expected[key])
    assert.deepEqual(await new SettingsStore(directory).getUserProfile(), expected)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('修改个人资料的单个字段时保留自定义内容和头像，重启后仍可恢复', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-custom-profile-'))
  try {
    const store = new SettingsStore(directory)
    const custom = {
      name: '自定义姓名',
      username: '@custom',
      email: 'custom@example.com',
      avatarText: '自',
      avatarData: 'data:image/png;base64,YXZhdGFy',
    }
    await store.saveUserProfile(custom)
    await store.saveUserProfile({ name: '新姓名' })

    assert.deepEqual(await new SettingsStore(directory).getUserProfile(), {
      name: '新姓名',
      username: custom.username,
      email: custom.email,
      avatarText: custom.avatarText,
      avatarUrl: custom.avatarData,
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('设置忽略旧扩展路径，不再暴露或创建扩展目录', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-extension-settings-'))
  try {
    const file = path.join(directory, 'settings.json')
    const original = JSON.stringify({
      themeId: 'dark',
      preferredProjectApp: 'cursor',
      userExtensionPaths: ['/tmp/old.ts'],
    })
    await writeFile(file, original)
    const store = new SettingsStore(directory)
    const loaded = await store.load()
    assert.equal('userExtensionPaths' in loaded.settings, false)
    assert.equal('extensionsDirectory' in loaded, false)
    assert.equal(await readFile(file, 'utf8'), original)
    await store.save({ themeId: 'light' })
    await store.togglePin('/tmp/project')
    assert.equal(store.settings.preferredProjectApp, 'cursor')
    assert.equal('userExtensionPaths' in store.settings, false)
    const saved = JSON.parse(await readFile(file, 'utf8'))
    assert.equal('userExtensionPaths' in saved, false)
    const restarted = new SettingsStore(directory)
    assert.equal('userExtensionPaths' in (await restarted.load()).settings, false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('扩展目录不接受 Desktop 设置中的外部路径', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-invalid-extension-'))
  const store = new SettingsStore(directory)
  try {
    await store.load()
    await store.save({ ...store.settings, userExtensionPaths: [path.join(directory, 'outside.mjs')] } as never)
    assert.equal('userExtensionPaths' in store.settings, false)
    assert.equal('extensionsDirectory' in store.snapshot(), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('主题补全语义颜色，拒绝无效颜色、字体和元数据', () => {
  const custom = parseTheme({ id: 'custom', name: '自用', appearance: 'light', colors: { accent: '#123456' } })
  assert.equal(custom.colors.accent, '#123456')
  assert.equal(custom.colors.background, builtinThemes[1].colors.background)
  for (const value of [
    null,
    {},
    { id: '../bad', name: '坏', appearance: 'dark' },
    { id: 'bad', name: '坏', appearance: 'dark', colors: { accent: 'red' } },
    { id: 'bad', name: '坏', appearance: 'dark', fonts: { ui: 'url(x);' } },
  ])
    assert.throws(() => parseTheme(value))
})
test('配置重启恢复，损坏的当前主题保留原配色，重复主题与坏 JSON 可见', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-desktop-settings-'))
  try {
    const store = new SettingsStore(directory)
    await store.load()
    const themeFile = path.join(store.themesDirectory, 'custom.json')
    await writeFile(
      themeFile,
      JSON.stringify({ id: 'custom', name: '自用', appearance: 'dark', colors: { accent: '#123456' } }),
    )
    await store.reloadThemes()
    await store.save({ themeId: 'custom', preferredProjectApp: 'cursor' })
    const restarted = new SettingsStore(directory)
    assert.equal((await restarted.load()).settings.themeId, 'custom')
    assert.equal(restarted.settings.preferredProjectApp, 'cursor')
    await writeFile(themeFile, '{bad')
    await writeFile(
      path.join(store.themesDirectory, 'duplicate.json'),
      JSON.stringify({ id: 'dark', name: '重复', appearance: 'dark' }),
    )
    const snapshot = await store.reloadThemes()
    assert.equal(snapshot.themes.find((theme) => theme.id === 'custom')?.colors.accent, '#123456')
    assert.equal(snapshot.errors.length, 2)
    await assert.rejects(store.save({ themeId: 'missing' }), /主题不存在/)

    // 测试 togglePin 与持久化
    const pinned1 = await store.togglePin('/path/to/project-a')
    assert.deepEqual(pinned1, ['/path/to/project-a'])
    assert.deepEqual(store.settings.pinnedPaths, ['/path/to/project-a'])
    const pinned2 = await store.togglePin('/path/to/project-a')
    assert.deepEqual(pinned2, [])
    assert.deepEqual(store.settings.pinnedPaths, [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('新安装常驻工具执行，旧能力选择仍可保存且普通设置不丢记录', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-capability-settings-'))
  const store = new SettingsStore(directory)
  try {
    await store.load()
    assert.equal(store.settings.codemodeEnabled, true)
    assert.equal(store.settings.mcpEnabled, true)
    await store.save({ ...store.settings, mcpEnabled: true })
    assert.equal(store.settings.codemodeEnabled, true)
    await store.save({ themeId: 'dark' })
    assert.equal(store.settings.mcpEnabled, true)
    assert.equal(store.settings.codemodeEnabled, true)
    await store.save({ ...store.settings, mcpEnabled: false, codemodeEnabled: false })
    const restarted = new SettingsStore(directory)
    assert.equal((await restarted.load()).settings.codemodeEnabled, false)
    await assert.rejects(store.save({ ...store.settings, mcpEnabled: 'true' }), /布尔值/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('新安装提供SubAgent，旧角色选择保存并拒绝无效 ID', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-subagent-settings-'))
  try {
    const store = new SettingsStore(directory)
    await store.load()
    assert.equal(store.settings.subagentsEnabled, true)
    assert.deepEqual(store.settings.enabledSubagents, [])
    await store.save({ ...store.settings, subagentsEnabled: true, enabledSubagents: ['explorer', 'test-runner'] })
    const restarted = new SettingsStore(directory)
    const snapshot = await restarted.load()
    assert.equal(snapshot.settings.subagentsEnabled, true)
    assert.deepEqual(snapshot.settings.enabledSubagents, ['explorer', 'test-runner'])
    await assert.rejects(store.save({ ...store.settings, enabledSubagents: ['../outside'] }), /子 Agent 启用列表无效/)
    await assert.rejects(store.save({ ...store.settings, enabledSubagents: 'explorer' }), /子 Agent 启用列表无效/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('默认访问权限保存后保留，非法值拒绝写入', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-access-settings-'))
  const store = new SettingsStore(directory)
  try {
    await store.load()
    assert.equal(store.settings.defaultAccessMode, undefined)
    await store.save({ ...store.settings, defaultAccessMode: 'full-access' })
    assert.equal(store.settings.defaultAccessMode, 'full-access')
    await store.save({ themeId: 'dark' })
    assert.equal(store.settings.defaultAccessMode, 'full-access')
    const restarted = new SettingsStore(directory)
    assert.equal((await restarted.load()).settings.defaultAccessMode, 'full-access')
    await assert.rejects(store.save({ ...store.settings, defaultAccessMode: 'unsafe' }), /访问权限/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('内置主题 ID 不重复且全部校验通过', () => {
  const ids = builtinThemes.map((theme) => theme.id)
  assert.equal(new Set(ids).size, ids.length, '内置主题 ID 不得重复')
  for (const expectedId of [
    'dark',
    'light',
    'pi-orange',
    'catppuccin-mocha',
    'dracula',
    'everforest-dark',
    'everforest-light',
    'rose-pine-dawn',
    'rose-pine-moon',
    'rose-pine',
    'shades-of-purple',
  ]) {
    assert.ok(ids.includes(expectedId), `缺少内置主题 ${expectedId}`)
  }
  for (const theme of builtinThemes) {
    const parsed = parseTheme(theme)
    assert.equal(parsed.id, theme.id)
    assert.equal(parsed.appearance, theme.appearance)
  }
})

test('全新设置常驻内置能力，旧MCP关闭选择在加载和保存后保留', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-legacy-mcp-choice-'))
  try {
    const fresh = new SettingsStore(directory)
    assert.equal((await fresh.load()).settings.mcpEnabled, true)
    await writeFile(path.join(directory, 'settings.json'), JSON.stringify({ themeId: 'dark', mcpEnabled: false }))
    const migrated = new SettingsStore(directory)
    const snapshot = await migrated.load()
    assert.equal(snapshot.settings.mcpEnabled, false)
    assert.equal(
      (await migrated.save({ ...snapshot.settings, preferredProjectApp: 'vscode' })).settings.mcpEnabled,
      false,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
