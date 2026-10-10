import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createPlugin } from '../src/create'
import { buildPlugin, packagePlugin, validatePlugin } from '../src/build'
import { PluginManager } from '@pi-meme/plugin-runtime/manager'

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
    assert.equal((await validatePlugin(directory)).piMeme.sdkVersion, 1)
    const agent = await readFile(path.join(directory, 'dist/agent/entry.js'), 'utf8')
    assert.match(agent, /registerTool/)
    assert.match(agent, /session_start/)
    assert.doesNotMatch(agent, /from ["']typebox["']/)
    const ui = await readFile(path.join(directory, 'dist/ui/entry.js'), 'utf8')
    assert.match(ui, /react\/jsx-runtime/)
    assert.doesNotMatch(ui, /module\.exports/)
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
