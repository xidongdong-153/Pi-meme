import assert from 'node:assert/strict'
import { test } from 'vitest'
import { snapshot, create } from './host-client-fixture'
import type { PlatformAdapter } from '@pi-meme/contracts/host'

test('侧栏设置通过独立 RPC 保存补丁并返回偏好', async () => {
  const preferences = {
    groupMode: 'merged',
    sortMode: 'recent',
    collapsed: { pinned: false, projects: false, recents: false },
    orders: {},
  }
  const { client, requests } = create(() => preferences)
  try {
    const patch = { groupMode: 'merged' as const }
    assert.deepEqual(await client.bridge.saveSidebarPreferences(patch), preferences)
    assert.equal(requests[0].method, 'settings:sidebar')
    assert.deepEqual(requests[0].args, [patch])
  } finally {
    client.close()
  }
})

test('编辑器显示设置经独立 RPC 保存，不携带当前会话且不走运行时配置接口', async () => {
  const saved = {
    settings: { themeId: 'dark', showComposerHint: false, showContextUsage: true },
    themes: [],
    themesDirectory: '/test/themes',
    errors: [],
  }
  const { client, requests } = create((request) => (request.method === 'pi:snapshot' ? snapshot('selected') : saved))
  try {
    await client.bridge.getConnection()
    const patch = { showComposerHint: false }
    assert.deepEqual(await client.bridge.saveEditorSettings(patch), saved)
    assert.equal(requests.at(-1)?.method, 'settings:editor')
    assert.deepEqual(requests.at(-1)?.args, [patch])
    assert.equal(requests.at(-1)?.sessionId, undefined)
  } finally {
    client.close()
  }
})

test('指令接口经当前 Host RPC，连接展示信息不包含令牌', async () => {
  const { client, requests } = create(() => ({}))
  const input = { kind: 'agents' as const, content: '测试指令', revision: 'a'.repeat(64) }
  await client.bridge.getInstructions()
  await client.bridge.saveInstruction(input)
  assert.deepEqual(
    requests.map((request) => [request.method, request.args]),
    [
      ['settings:instructions', []],
      ['settings:save-instruction', [input]],
    ],
  )
  assert.equal(client.hostAddress, 'http://127.0.0.1:3141')
  assert.equal(client.localHost, true)
  client.close()
})

test('选择会话后插件管理仍请求 Host，不携带当前 sessionId', async () => {
  const { client, requests } = create((request) => (request.method === 'pi:snapshot' ? snapshot('A') : undefined))
  await client.bridge.getConnection()
  await client.plugins.list()
  await client.plugins.installDirectory('/plugin')
  await client.plugins.installPackage('package')
  await client.plugins.reload('plugin')
  await client.plugins.enable('plugin')
  await client.plugins.disable('plugin')
  await client.plugins.remove('plugin')
  const pluginRequests = requests.filter((request) => request.method.startsWith('plugins:'))
  assert.equal(pluginRequests.length, 7)
  assert.ok(pluginRequests.every((request) => !Object.hasOwn(request, 'sessionId')))
  client.close()
})

test('存储只读信息不携带界面会话；远程客户端不暴露本机维护能力', async () => {
  const platform: PlatformAdapter = {
    storage: {
      getInfo: async () => {
        throw new Error('不应调用')
      },
      chooseTarget: async () => null,
      migrate: async () => {},
      clearCache: async () => {},
      openDirectory: async () => {},
    },
    getHostConnection: async () => ({ hostId: 'host-1', url: 'http://127.0.0.1:3141', token: '', local: true }),
    setHostConnection: async () => {},
    chooseDirectory: async () => null,
    getProjectApps: async () => [],
    openProject: async () => {},
    importTheme: async () => null,
    exportTheme: async () => {},
    openPath: async () => {},
  }
  for (const local of [true, false]) {
    const { client, requests } = create(
      (request) =>
        request.method === 'pi:snapshot' ? snapshot('selected') : { hostId: 'host-1', dataRoot: '/profile' },
      {
        platform,
        connection: { hostId: 'host-1', url: 'http://127.0.0.1:3141', token: '', local },
      },
    )
    try {
      await client.bridge.getConnection()
      assert.deepEqual(await client.bridge.getStorageInfo(), { hostId: 'host-1', dataRoot: '/profile' })
      assert.equal(requests.at(-1)?.method, 'host:storage-info')
      assert.equal(requests.at(-1)?.sessionId, undefined)
      assert.equal(client.bridge.storage, local ? platform.storage : undefined)
    } finally {
      client.close()
    }
  }
})
