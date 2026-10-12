import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { DesktopBridge } from '@pi-meme/contracts/desktop'
import type { UiPluginDescriptor, UiPluginModule } from '@pi-meme/plugin-sdk/ui'
import { UiPluginRegistry } from '../src/plugin-registry'

function plugin(generation: number): UiPluginDescriptor {
  return {
    id: 'example',
    generation,
    version: `1.${generation}`,
    enabled: true,
    ui: `/plugin-${generation}.js`,
    status: 'active',
  }
}

test('动态注册、更新和停用按次释放贡献与插件资源', async () => {
  const disposed: string[] = []
  const registry = new UiPluginRegistry({} as DesktopBridge, async (url): Promise<UiPluginModule> => ({
    activate(context) {
      context.contribute({ id: 'example:status', slot: 'status', render: () => url })
      return () => {
        disposed.push(url)
      }
    },
  }))
  await registry.synchronize([plugin(1)])
  assert.equal(registry.getSnapshot().length, 1)
  await registry.synchronize([plugin(2)])
  assert.deepEqual(disposed, ['/plugin-1.js'])
  assert.equal(registry.getSnapshot()[0].render({ bridge: {} as DesktopBridge }), '/plugin-2.js')
  await registry.synchronize([])
  assert.deepEqual(disposed, ['/plugin-1.js', '/plugin-2.js'])
  assert.equal(registry.getSnapshot().length, 0)
  await registry.dispose()
  assert.equal(disposed.length, 2)
})

test('新版本激活失败会保留旧贡献并回收新版本注册的资源', async () => {
  let removed = 0
  const registry = new UiPluginRegistry({} as DesktopBridge, async (url) => ({
    activate(context) {
      const dispose = context.contribute({ id: 'example:status', slot: 'status', render: () => url })
      if (url.includes('2')) {
        void dispose()
        removed++
        throw new Error('测试激活失败')
      }
    },
  }))
  await registry.synchronize([plugin(1)])
  await registry.synchronize([plugin(2)])
  assert.equal(registry.getSnapshot()[0].render({ bridge: {} as DesktopBridge }), '/plugin-1.js')
  assert.equal(removed, 1)
  assert.match(registry.errors().example, /测试激活失败/)
  await registry.dispose()
})

test('不接受越界贡献名称，失败插件没有残留贡献', async () => {
  const registry = new UiPluginRegistry({} as DesktopBridge, async () => ({
    activate(context) {
      context.contribute({ id: 'other:status', slot: 'status', render: () => null })
    },
  }))
  await registry.synchronize([plugin(1)])
  assert.equal(registry.getSnapshot().length, 0)
  assert.match(registry.errors().example, /前缀/)
  await registry.dispose()
})

test('同版本同代次但 Host 实例 URL 变化时重新加载并释放旧贡献', async () => {
  const loaded: string[] = []
  const disposed: string[] = []
  const registry = new UiPluginRegistry({} as DesktopBridge, async (url) => {
    loaded.push(url)
    return {
      activate(context) {
        context.contribute({ id: 'example:status', slot: 'status', render: () => url })
        return () => {
          disposed.push(url)
        }
      },
    }
  })
  const first = { ...plugin(1), ui: '/plugin-1.js?instance=first' }
  const second = { ...first, ui: '/plugin-1.js?instance=second' }
  await registry.synchronize([first])
  await registry.synchronize([second])
  assert.deepEqual(loaded, [first.ui, second.ui])
  assert.deepEqual(disposed, [first.ui])
  assert.equal(registry.getSnapshot()[0].render({ bridge: {} as DesktopBridge }), second.ui)
  await registry.dispose()
  assert.deepEqual(disposed, [first.ui, second.ui])
})

test('被Host隔离的failed插件不会运行UI入口', async () => {
  let loads = 0
  const registry = new UiPluginRegistry({} as DesktopBridge, async () => {
    loads++
    throw new Error('不应加载')
  })
  await registry.synchronize([
    { id: 'third-party', version: '1.0.0', generation: 1, enabled: true, status: 'failed', ui: '/isolated.js' },
  ])
  assert.equal(loads, 0)
  assert.equal(registry.getSnapshot().length, 0)
  await registry.dispose()
})

test('消息和工具贡献绑定真实插件与代次，图标地址传入 UI 上下文', async () => {
  let iconUrl: string | undefined
  const registry = new UiPluginRegistry({} as DesktopBridge, async () => ({
    activate(context) {
      iconUrl = context.iconUrl
      context.contribute({ id: 'example:tool', slot: 'tool-card', match: { toolName: 'review' }, render: () => null })
      context.contribute({
        id: 'example:message',
        slot: 'message',
        match: { customType: 'review' },
        render: () => null,
      })
    },
  }))
  await registry.synchronize([{ ...plugin(1), iconUrl: '/assets/icon.svg' }])
  assert.equal(iconUrl, '/assets/icon.svg')
  assert.deepEqual(
    registry.getSnapshot().map((entry) => entry.match?.ownerId),
    ['example', 'example'],
  )
  assert.deepEqual(
    registry.getSnapshot().map((entry) => entry.generation),
    [1, 1],
  )
  await registry.dispose()
})

test('拒绝未指定工具或消息类型的贡献以及伪造其他插件来源', async () => {
  for (const contribution of [
    { id: 'example:tool', slot: 'tool-card' as const, render: () => null },
    { id: 'example:message', slot: 'message' as const, render: () => null },
    {
      id: 'example:tool',
      slot: 'tool-card' as const,
      match: { ownerId: 'other', toolName: 'review' },
      render: () => null,
    },
  ]) {
    const registry = new UiPluginRegistry({} as DesktopBridge, async () => ({
      activate(context) {
        context.contribute(contribution)
      },
    }))
    await registry.synchronize([plugin(1)])
    assert.equal(registry.getSnapshot().length, 0)
    assert.match(registry.errors().example, /match|来源/)
    await registry.dispose()
  }
})
