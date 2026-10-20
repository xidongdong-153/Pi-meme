import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { startHostServer } from '../src/server'
import { MemoryCredentialStorage } from '@pi-meme/pi-runtime/secure-store'
import { setTimeout as delay } from 'node:timers/promises'
import type { Snapshot } from '@pi-meme/contracts/desktop'
import { setup, selectAgentPlugins, installAgentFixture } from './host-server-fixture'
import { trustPluginFixture, writeAgentFixture } from './plugin-fixture'

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

test.each(['prompt', 'follow-up', 'steer'] as const)(
  '授权变更回收已完成的 warm Worker 后，原会话快照可读且后续 %s 可启动',
  { timeout: 20000 },
  async (delivery) => {
    const fixture = await setup(true)
    let off: (() => void) | undefined
    try {
      const pluginId = 'warm-grant-fixture'
      await installAgentFixture(
        fixture.server.host,
        path.join(fixture.root, pluginId),
        pluginId,
        `export function activate() {}`,
      )
      const first = (await fixture.rpc('warm-grant', 'pi:snapshot')).result as Snapshot
      const key = first.connection.sessionKey!
      await selectAgentPlugins(fixture.server.host, key, [pluginId])
      assert.equal((await fixture.rpc('warm-grant', 'pi:access-mode', [key, 'full-access'], key)).error, undefined)
      assert.equal((await fixture.rpc('warm-grant', 'pi:session-mode', [key, 'plan'], key)).error, undefined)
      assert.equal(
        (await fixture.rpc('warm-grant', 'pi:prompt', [key, '授权变更前已完成的消息'], key)).error,
        undefined,
      )
      let before: Snapshot | undefined
      for (let count = 0; count < 200; count++) {
        const response = await fixture.rpc('warm-grant', 'pi:snapshot', [], key)
        assert.equal(response.error, undefined)
        before = response.result as Snapshot
        if (!before.state.isStreaming) break
        await delay(25)
      }
      assert.equal(before?.state.isStreaming, false)
      assert.ok(before.messages.some((message) => message.role === 'assistant'))
      let notifiedIdle = false
      let cancelledRuns = 0
      off = await fixture.server.host.subscribe('warm-grant', (event) => {
        if (event.type === 'connection' && event.value.sessionKey === key && event.value.status === 'idle')
          notifiedIdle = true
        if (event.type === 'event' && event.value.event.type === 'agent_settled') cancelledRuns++
      })
      await trustPluginFixture(fixture.server.host.plugins, pluginId)
      assert.equal(notifiedIdle, true)
      assert.equal(cancelledRuns, 0)
      const after = await fixture.rpc('warm-grant', 'pi:snapshot', [], key)
      assert.equal(after.error, undefined)
      const snapshot = after.result as Snapshot
      assert.equal(snapshot.connection.status, 'idle')
      assert.equal(snapshot.state.isStreaming, false)
      assert.deepEqual(snapshot.messages, before.messages)
      const invalid = await fixture.rpc(
        'warm-grant',
        `pi:${delivery}`,
        [key, '不得投递的错误审计输入', [], [], { mode: 'plan', clientProcessingAudit: {} }],
        key,
      )
      assert.match(invalid.error?.message ?? '', /客户端处理来源记录无效/)
      const message = '授权变更后首次新任务\n[附件：保留的附件]\nfixture-content'
      const audit = [
        {
          attemptId: 'confirmed-skip',
          pluginId,
          generation: fixture.server.host.plugins.list().find((entry) => entry.id === pluginId)!.generation,
          hookId: 'before-send',
          outcome: 'skipped',
          userConfirmedAt: new Date().toISOString(),
        },
      ]
      const forged = await fixture.rpc(
        'warm-grant',
        `pi:${delivery}`,
        [
          key,
          '不得投递的伪造scope',
          [],
          [],
          { mode: 'plan', clientProcessingAudit: [{ ...audit[0], runId: 'forged-run' }] },
        ],
        key,
      )
      assert.match(forged.error?.message ?? '', /客户端处理来源记录无效/)
      assert.equal(
        (
          await fixture.rpc(
            'warm-grant',
            `pi:${delivery}`,
            [key, message, [], [], { mode: 'plan', clientProcessingAudit: audit }],
            key,
          )
        ).error,
        undefined,
      )
      let completed: Snapshot | undefined
      for (let count = 0; count < 200; count++) {
        const response = await fixture.rpc('warm-grant', 'pi:snapshot', [], key)
        assert.equal(response.error, undefined)
        completed = response.result as Snapshot
        if (
          !completed.state.isStreaming &&
          completed.messages.filter((message) => message.role === 'user').length === 2
        )
          break
        await delay(25)
      }
      assert.equal(completed?.state.isStreaming, false)
      assert.equal(completed.messages.filter((message) => message.role === 'user').length, 2)
      assert.equal(completed.messages.filter((message) => message.role === 'assistant').length, 2)
      assert.equal(completed.state.mode, 'plan')
      assert.match(JSON.stringify(completed.messages.findLast((message) => message.role === 'user')), /fixture-content/)
      const saved = (await readFile(completed.connection.sessionFile!, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { type: string; customType?: string; data?: unknown })
      assert.deepEqual(
        saved.find((entry) => entry.type === 'custom' && entry.customType === 'pi-meme-client-processing')?.data,
        { clientDeclared: true, entries: audit },
      )
    } finally {
      off?.()
      await fixture.dispose()
    }
  },
)

test('同地址新 Host 的插件入口与相对子模块都使用新的实例路径', async () => {
  const fixture = await setup()
  let restarted: Awaited<ReturnType<typeof startHostServer>> | undefined
  try {
    const directory = path.join(fixture.root, 'relative-ui')
    await mkdir(path.join(directory, 'dist/ui'), { recursive: true })
    await writeFile(
      path.join(directory, 'package.json'),
      JSON.stringify({ name: 'relative-ui', version: '1.0.0', piMeme: { sdkVersion: 3, ui: 'dist/ui/entry.js' } }),
    )
    await writeFile(
      path.join(directory, 'dist/ui/entry.js'),
      `import { text } from './child.js'; export const label = text\n`,
    )
    await writeFile(path.join(directory, 'dist/ui/child.js'), `export const text = '第一版'\n`)
    await fixture.server.host.plugins.loadDirectory(directory)
    await trustPluginFixture(fixture.server.host.plugins, 'relative-ui')
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
    await trustPluginFixture(restarted.host.plugins, 'relative-ui')
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

test(
  '运行中安装 Agent 插件保留旧任务，显式卸载立即撤权，新任务使用明确选择的工具集合',
  { timeout: 30000 },
  async () => {
    const fixture = await setup(true)
    const pluginId = 'hot-agent-fixture'
    const directory = path.join(fixture.root, 'hot-plugin')
    await writeAgentFixture(
      directory,
      pluginId,
      `export function activate(context) { context.tools.register({ name: 'hot_fixture_tool', title: '热更工具', description: '验证新会话工具集合', parameters: { type: 'object', properties: {} }, effect:'read',capabilities:[], execute: async () => ({ text: '工具已执行', data: {} }) }); context.commands.register({ name: 'hot-fixture-command', description: '热更命令', execute: async () => {} }) }\n`,
      '1.0.0',
      'dist/agent/entry.js',
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
      assert.equal(
        fixture.server.host.plugins.list().find((plugin) => plugin.id === pluginId)?.grant?.trusted.agent,
        false,
      )
      await trustPluginFixture(fixture.server.host.plugins, pluginId)
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
      const active = fixture.server.host.plugins.list().find((plugin) => plugin.id === pluginId)!
      assert.equal((await fixture.rpc('a', 'plugins:remove', [pluginId])).error, undefined)
      const duringRemove = await snapshot()
      assert.equal(duringRemove.state.isStreaming, false)
      assert.equal(
        duringRemove.uiPlugins?.some((plugin) => plugin.id === pluginId),
        false,
      )
      assert.equal(
        fixture.server.host.plugins.isGrantCurrent(pluginId, active.generation, active.grant!.revision),
        false,
      )
      await settled()
      const ref = await fixture.server.host.control.sessionForRuntime(key)
      assert.deepEqual((await fixture.server.host.app.sessions.get(ref)).configuration.agentPlugins, [pluginId])
      const requestsBefore = fixture.modelTools.length
      const unavailable = await fixture.rpc('a', 'pi:prompt', [key, '卸载后工具集合'], key)
      assert.ok(unavailable.error)
      assert.equal(
        unavailable.error.message,
        `operation-unavailable-in-runtime: 已选择的插件 ${pluginId} 不可用：插件已卸载或不存在`,
      )
      assert.equal(fixture.modelTools.length, requestsBefore)
      assert.deepEqual((await snapshot()).messages, duringRemove.messages)
      await selectAgentPlugins(fixture.server.host, key, [])
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
  },
)
