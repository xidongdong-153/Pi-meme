import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadPluginThemes } from '../src/server/plugin-themes'
import { SettingsStore } from '../src/server/store'
import { parseTheme } from '../src/shared/themes'

test('主题资源绑定插件代次与包内图片，禁用和重启恢复所选主题', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'app-theme-'))
  try {
    await mkdir(path.join(root, 'assets'))
    await writeFile(path.join(root, 'assets/bg.png'), 'fixture')
    const input = {
      id: 'land',
      name: '山景',
      appearance: 'dark',
      tokens: { spacing: 1.2, radius: 12, surfaceOpacity: 0.8 },
      background: { image: 'assets/bg.png', area: 'workspace' },
    }
    await writeFile(path.join(root, 'theme.json'), JSON.stringify(input))
    const pkg = {
      id: 'theme-fixture',
      generation: 3,
      directory: root,
      enabled: true,
      resources: { themes: ['theme.json'], assets: ['assets'] },
    }
    const themes = await loadPluginThemes([pkg], (p, file) => `/api/plugins/${p.generation}/${file}`)
    assert.equal(themes[0].background!.url, '/api/plugins/3/assets/bg.png')
    assert.equal(themes[0].plugin!.generation, 3)
    const data = path.join(root, 'data')
    const store = new SettingsStore(data)
    await store.load()
    await store.setPluginThemes(themes)
    await store.selectTheme(themes[0].id)
    const restarted = new SettingsStore(data)
    await restarted.load()
    await restarted.setPluginThemes(themes)
    assert.equal(restarted.settings.themeId, themes[0].id)
    await restarted.setPluginThemes([])
    assert.equal(restarted.settings.themeId, 'dark')
    assert.equal(
      restarted.snapshot().themes.some((theme) => theme.plugin),
      false,
    )
    assert.deepEqual(await loadPluginThemes([{ ...pkg, enabled: false }], () => ''), [])
    await writeFile(path.join(root, 'secret.png'), 'private')
    await symlink(path.join(root, 'secret.png'), path.join(root, 'assets/link.png'))
    await writeFile(path.join(root, 'theme.json'), JSON.stringify({ ...input, background: { image: '../secret.png' } }))
    await assert.rejects(
      loadPluginThemes([pkg], () => ''),
      /路径|包内|图片/,
    )
    await writeFile(path.join(root, 'theme.json'), JSON.stringify({ ...input, background: { image: 'secret.png' } }))
    await assert.rejects(
      loadPluginThemes([pkg], () => ''),
      /assets/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('主题只接受有边界的结构化字段', () => {
  const theme = { id: 'test', name: '测试', appearance: 'dark' }
  for (const value of [
    { ...theme, css: 'body{}' },
    { ...theme, background: { image: 'https://example.com/a.png' } },
    { ...theme, background: { image: 'a.svg' } },
    { ...theme, background: { image: 'a.png', url: 'file:///x' } },
    { ...theme, background: { image: 'a.png', blur: 33 } },
    { ...theme, tokens: { spacing: 10 } },
    { ...theme, tokens: { surfaceOpacity: 0 } },
  ])
    assert.throws(() => parseTheme(value))
})
