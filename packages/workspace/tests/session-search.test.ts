import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SidebarSessionEntry } from '../src/ui/sidebar/sidebar-model'
import { searchSidebarContents } from '../src/ui/sidebar/session-search'

function entry(serviceId: string, path: string): SidebarSessionEntry {
  return {
    kind: 'session',
    key: JSON.stringify([serviceId, path]),
    serviceId,
    projectName: '项目',
    session: { id: path, path, cwd: '/project', name: '已改名', created: '', modified: '', messageCount: 2 },
  }
}

test('同路径的跨Host正文结果分别绑定各自会话，忽略响应中未请求的路径', async () => {
  const entries = [entry('local', '/same'), entry('remote', '/same')]
  const calls: string[] = []
  const result = await searchSidebarContents('正文', entries, async (serviceId, query, paths) => {
    calls.push(serviceId)
    assert.equal(query, '正文')
    assert.deepEqual(paths, ['/same'])
    return [
      { path: '/same', excerpt: `${serviceId}的正文` },
      { path: '/unexpected', excerpt: '不应显示' },
    ]
  })
  assert.deepEqual(calls.sort(), ['local', 'remote'])
  assert.deepEqual(
    new Map(result.matches.map((match) => [match.key, match.excerpt])),
    new Map([
      [entries[0].key, 'local的正文'],
      [entries[1].key, 'remote的正文'],
    ]),
  )
  assert.deepEqual(result.errors, [])
})

test('大量历史按100条分批；远程失败不丢弃其他Host已找到的正文', async () => {
  const entries = [...Array.from({ length: 205 }, (_, index) => entry('local', `/${index}`)), entry('offline', '/same')]
  const sizes: number[] = []
  const result = await searchSidebarContents('正文', entries, async (serviceId, _query, paths) => {
    if (serviceId === 'offline') throw new Error('Host 未连接')
    sizes.push(paths.length)
    return paths.map((path) => ({ path, excerpt: '正文命中' }))
  })
  assert.deepEqual(sizes, [100, 100, 5])
  assert.equal(result.matches.length, 205)
  assert.deepEqual(result.errors, [{ serviceId: 'offline', message: 'Error: Host 未连接' }])
})
