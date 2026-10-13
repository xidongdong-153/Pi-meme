import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createPlugin } from '../src/create'
import { buildPlugin, packagePlugin, validatePlugin } from '../src/build'
import { PluginManager } from '@pi-meme/plugin-runtime/manager'
import type { PluginManifest } from '@pi-meme/plugin-sdk/manifest'

test('模板构建出 Node 工具和浏览器 UI，验证打包并安装服务', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-meme-devkit-'))
  const directory = path.join(root, 'clock')
  const manager = new PluginManager({ directory: path.join(root, 'installed'), dataDirectory: path.join(root, 'data') })
  try {
    await createPlugin(directory, 'clock')
    await symlink(
      path.resolve(import.meta.dirname, '../../../node_modules'),
      path.join(directory, 'node_modules'),
      'dir',
    )
    await buildPlugin(directory)
    assert.equal((await validatePlugin(directory)).piMeme.sdkVersion, 2)
    const agent = await readFile(path.join(directory, 'dist/agent/entry.js'), 'utf8')
    assert.match(agent, /tools\.register/)
    assert.match(agent, /sessionStart/)
    assert.doesNotMatch(agent, /from ["']typebox["']/)
    const ui = await readFile(path.join(directory, 'dist/ui/entry.js'), 'utf8')
    assert.match(ui, /react\/jsx-runtime/)
    assert.doesNotMatch(ui, /module\.exports/)
    assert.match(ui, /location: ["']right["']/)
    const packed = await packagePlugin(directory, path.join(root, 'clock.pim'))
    await manager.installPackage(await readFile(packed))
    assert.match(String(await manager.handlers()['clock:time']!()), /^\d{4}-\d{2}/)
    const artifact = JSON.parse(await readFile(path.join(directory, 'dist/server/chord-facets.json'), 'utf8')) as {
      entries: { server: { file: string } }
    }
    await appendFile(path.join(directory, 'dist/server', artifact.entries.server.file), '\n// 已篡改\n')
    await assert.rejects(validatePlugin(directory), /integrity|hash|sha256|校验/i)
  } finally {
    await manager.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('DevKit 构建和打包保留显式资源目录、辅助脚本与显示图标', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-meme-devkit-resources-'))
  const directory = path.join(root, 'review')
  const manager = new PluginManager({ directory: path.join(root, 'installed'), dataDirectory: path.join(root, 'data') })
  try {
    await createPlugin(directory, 'review')
    await symlink(
      path.resolve(import.meta.dirname, '../../../node_modules'),
      path.join(directory, 'node_modules'),
      'dir',
    )
    const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')) as PluginManifest
    manifest.piMeme.resources = { skills: ['skills/review'], assets: ['assets'] }
    manifest.piMeme.display = { name: '代码检查', icon: 'assets/icon.svg' }
    for (const child of ['skills/review/scripts', 'extensions/review', 'assets'])
      await mkdir(path.join(directory, child), { recursive: true })
    await writeFile(
      path.join(directory, 'skills/review/SKILL.md'),
      '---\nname: review\ndescription: 检查代码\n---\n说明',
    )
    await writeFile(path.join(directory, 'skills/review/scripts/check.js'), 'export const check = true')
    await writeFile(path.join(directory, 'extensions/review/index.ts'), 'export default function extension() {}')
    await writeFile(path.join(directory, 'assets/icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    await writeFile(path.join(directory, 'package.json'), JSON.stringify(manifest))
    await buildPlugin(directory)
    const packed = await packagePlugin(directory, path.join(root, 'review.pim'))
    const installed = await manager.installPackage(await readFile(packed))
    assert.equal(installed.display?.name, '代码检查')
    assert.equal(
      await readFile(path.join(installed.directory, 'skills/review/scripts/check.js'), 'utf8'),
      'export const check = true',
    )
    assert.match(await readFile(path.join(installed.directory, 'assets/icon.svg'), 'utf8'), /<svg/)
  } finally {
    await manager.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
