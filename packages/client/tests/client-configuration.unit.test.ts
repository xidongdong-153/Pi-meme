import assert from 'node:assert/strict'
import { test } from 'vitest'
import { snapshot, create } from './host-client-fixture'

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
