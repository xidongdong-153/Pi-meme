import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { startHostServer } from '../src/server'
import { MemoryCredentialStorage } from '@pi-meme/pi-runtime/secure-store'
import { setTimeout as delay } from 'node:timers/promises'
import type { Snapshot } from '@pi-meme/contracts/desktop'
import { setup, selectAgentPlugins, installAgentFixture } from './host-server-fixture'

test('AppAgent 命令按会话启用，插件接口不能停用内置资源模块', async () => {
  const fixture = await setup(true)
  try {
    const pluginId = 'command-fixture'
    await installAgentFixture(
      fixture.server.host,
      path.join(fixture.root, pluginId),
      pluginId,
      `export function activate(context) { context.commands.register({ name: 'native-resource', description: '应用命令', execute: async () => {} }) }\n`,
    )
    const initial = (await fixture.rpc('resource', 'pi:snapshot')).result as Snapshot
    const key = initial.connection.sessionKey!
    await selectAgentPlugins(fixture.server.host, key, [pluginId])
    assert.equal((await fixture.rpc('resource', 'pi:access-mode', [key, 'full-access'], key)).error, undefined)
    assert.equal((await fixture.rpc('resource', 'pi:prompt', [key, '资源扫描', [], []], key)).error, undefined)
    const commands = (await fixture.rpc('resource', 'pi:commands', [], key)).result as Array<{ name: string }>
    assert.ok(commands.some((command) => command.name === 'native-resource'))
    assert.equal(((await fixture.rpc('resource', 'pi:snapshot', [], key)).result as Snapshot).extensionError, undefined)
    assert.match(
      (await fixture.rpc('resource', 'plugins:disable', ['@pi-meme/resources'])).error?.message ?? '',
      /内置模块/,
    )
    for (let count = 0; count < 200; count++) {
      if (((await fixture.rpc('resource', 'pi:snapshot', [], key)).result as Snapshot).agent?.status === 'completed')
        break
      await delay(25)
    }
    assert.equal(
      (await fixture.rpc('resource', 'pi:prompt', [key, '拒绝停用后继续运行', [], []], key)).error,
      undefined,
    )
    const commandsAfter = (await fixture.rpc('resource', 'pi:commands', [], key)).result as Array<{ name: string }>
    assert.ok(commandsAfter.some((command) => command.name === 'native-resource'))
  } finally {
    await fixture.dispose()
  }
})

test('同地址新 Host 的插件入口与相对子模块都使用新的实例路径', async () => {
  const fixture = await setup()
  let restarted: Awaited<ReturnType<typeof startHostServer>> | undefined
  try {
    const directory = path.join(fixture.root, 'relative-ui')
    await mkdir(path.join(directory, 'dist/ui'), { recursive: true })
    await writeFile(
      path.join(directory, 'package.json'),
      JSON.stringify({ name: 'relative-ui', version: '1.0.0', piMeme: { sdkVersion: 2, ui: 'dist/ui/entry.js' } }),
    )
    await writeFile(
      path.join(directory, 'dist/ui/entry.js'),
      `import { text } from './child.js'; export const label = text\n`,
    )
    await writeFile(path.join(directory, 'dist/ui/child.js'), `export const text = '第一版'\n`)
    await fixture.server.host.plugins.loadDirectory(directory)
    const descriptors = (await fixture.rpc('a', 'plugins:list')).result as Array<{
      id: string
      generation: number
      ui?: string
    }>
    const first = descriptors.find((descriptor) => descriptor.id === 'relative-ui')!
    const firstChild = new URL('./child.js', new URL(first.ui!, fixture.server.url))
    assert.match(await (await fetch(firstChild, { headers: { Cookie: fixture.cookie } })).text(), /第一版/)
    const port = Number(new URL(fixture.server.url).port)
    await fixture.server.dispose()
    await writeFile(path.join(directory, 'dist/ui/child.js'), `export const text = '第二版'\n`)
    restarted = await startHostServer({
      dataRoot: path.join(fixture.root, 'restarted'),
      port,
      token: 'new-token',
      credentials: new MemoryCredentialStorage(),
    })
    await restarted.host.plugins.loadDirectory(directory)
    const auth = await fetch(`${restarted.url}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'new-token' }),
    })
    const cookie = auth.headers.get('set-cookie')!.split(';')[0]
    const response = await restarted.host.rpc({ requestId: 'ui', clientId: 'b', method: 'plugins:list', args: [] })
    const second = (response.result as typeof descriptors).find((descriptor) => descriptor.id === 'relative-ui')!
    assert.equal(first.generation, second.generation, '不同 Host 可重复相同插件代次')
    const secondChild = new URL('./child.js', new URL(second.ui!, restarted.url))
    assert.notEqual(secondChild.href, firstChild.href)
    assert.match(await (await fetch(secondChild, { headers: { Cookie: cookie } })).text(), /第二版/)
    assert.equal((await fetch(firstChild, { headers: { Cookie: cookie } })).status, 404)
  } finally {
    await restarted?.dispose()
    await fixture.dispose()
  }
})

test('运行中安装与卸载 Agent 插件，旧任务保持原工具，新任务加载新工具集合', { timeout: 30000 }, async () => {
  const fixture = await setup(true)
  const pluginId = 'hot-agent-fixture'
  const directory = path.join(fixture.root, 'hot-plugin')
  await mkdir(path.join(directory, 'dist', 'agent'), { recursive: true })
  await writeFile(
    path.join(directory, 'package.json'),
    JSON.stringify({ name: pluginId, version: '1.0.0', piMeme: { sdkVersion: 2, agent: 'dist/agent/entry.js' } }),
  )
  await writeFile(
    path.join(directory, 'dist', 'agent', 'entry.js'),
    `export function activate(context) { context.tools.register({ name: 'hot_fixture_tool', title: '热更工具', description: '验证新会话工具集合', parameters: { type: 'object', properties: {} }, execute: async () => ({ text: '工具已执行', data: {} }) }); context.commands.register({ name: 'hot-fixture-command', description: '热更命令', execute: async () => {} }) }\n`,
  )
  const snapshot = async () => {
    const response = await fixture.rpc('a', 'pi:snapshot')
    assert.equal(response.error, undefined)
    return response.result as Snapshot
  }
  const settled = async () => {
    for (let count = 0; count < 200; count++) {
      if (!(await snapshot()).state.isStreaming) return
      await delay(25)
    }
    throw new Error('假模型任务未结束')
  }
  try {
    const key = (await snapshot()).connection.sessionKey!
    await fixture.rpc('a', 'pi:access-mode', [key, 'full-access'], key)
    assert.equal((await fixture.rpc('a', 'pi:prompt', [key, '旧工具集合'], key)).error, undefined)
    assert.equal((await snapshot()).state.isStreaming, true)
    assert.equal((await fixture.rpc('a', 'plugins:install-directory', [directory])).error, undefined)
    const duringInstall = await snapshot()
    assert.equal(duringInstall.state.isStreaming, true)
    assert.equal(
      duringInstall.uiPlugins?.some((plugin) => plugin.id === pluginId),
      false,
    )
    await settled()
    await selectAgentPlugins(fixture.server.host, key, [pluginId])
    assert.equal((await fixture.rpc('a', 'pi:prompt', [key, '新工具集合'], key)).error, undefined)
    assert.ok(
      ((await fixture.rpc('a', 'pi:commands')).result as Array<{ name: string }>).some(
        (command) => command.name === 'hot-fixture-command',
      ),
    )
    assert.equal((await fixture.rpc('a', 'plugins:remove', [pluginId])).error, undefined)
    const duringRemove = await snapshot()
    assert.equal(duringRemove.state.isStreaming, true)
    assert.ok(duringRemove.uiPlugins?.some((plugin) => plugin.id === pluginId))
    await settled()
    assert.equal((await fixture.rpc('a', 'pi:prompt', [key, '卸载后工具集合'], key)).error, undefined)
    await settled()
    assert.equal(
      ((await fixture.rpc('a', 'pi:commands')).result as Array<{ name: string }>).some(
        (command) => command.name === 'hot-fixture-command',
      ),
      false,
    )
    assert.equal(fixture.modelTools[0].includes('hot_fixture_tool'), false)
    assert.equal(fixture.modelTools[1].includes('hot_fixture_tool'), true)
    assert.equal(fixture.modelTools[2].includes('hot_fixture_tool'), false)
  } finally {
    await fixture.dispose()
  }
})
