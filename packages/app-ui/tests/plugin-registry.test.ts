import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HostApi } from '@pi-meme/contracts/app-host'
import type { UiPanel, UiPanelLocation, UiPluginDescriptor, UiPluginModule, UiTarget } from '@pi-meme/plugin-sdk/ui'
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

function rightPanelLocation(location: UiPanelLocation): 'right' {
  return location
}

test('动态注册、更新和停用按次释放贡献与插件资源', async () => {
  const disposed: string[] = []
  const registry = new UiPluginRegistry({} as HostApi, async (url): Promise<UiPluginModule> => ({
    activate(context) {
      context.contributions.register({ id: 'example:status', slot: 'status', render: () => url })
      return () => {
        disposed.push(url)
      }
    },
  }))
  await registry.synchronize([plugin(1)])
  assert.equal(registry.getSnapshot().length, 1)
  await registry.synchronize([plugin(2)])
  assert.deepEqual(disposed, ['/plugin-1.js'])
  assert.equal(
    registry.getSnapshot()[0].render({ host: {} as HostApi, target: { hostId: 'host' }, snapshot: null }),
    '/plugin-2.js',
  )
  await registry.synchronize([])
  assert.deepEqual(disposed, ['/plugin-1.js', '/plugin-2.js'])
  assert.equal(registry.getSnapshot().length, 0)
  await registry.dispose()
  assert.equal(disposed.length, 2)
})

test('新版本激活失败会保留旧贡献并回收新版本注册的资源', async () => {
  let removed = 0
  const registry = new UiPluginRegistry({} as HostApi, async (url) => ({
    activate(context) {
      const dispose = context.contributions.register({ id: 'example:status', slot: 'status', render: () => url })
      if (url.includes('2')) {
        void dispose()
        removed++
        throw new Error('测试激活失败')
      }
    },
  }))
  await registry.synchronize([plugin(1)])
  await registry.synchronize([plugin(2)])
  assert.equal(
    registry.getSnapshot()[0].render({ host: {} as HostApi, target: { hostId: 'host' }, snapshot: null }),
    '/plugin-1.js',
  )
  assert.equal(removed, 1)
  assert.match(registry.errors().example, /测试激活失败/)
  await registry.dispose()
})

test('不接受越界贡献名称，失败插件没有残留贡献', async () => {
  const registry = new UiPluginRegistry({} as HostApi, async () => ({
    activate(context) {
      context.contributions.register({ id: 'other:status', slot: 'status', render: () => null })
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
  const registry = new UiPluginRegistry({} as HostApi, async (url) => {
    loaded.push(url)
    return {
      activate(context) {
        context.contributions.register({ id: 'example:status', slot: 'status', render: () => url })
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
  assert.equal(
    registry.getSnapshot()[0].render({ host: {} as HostApi, target: { hostId: 'host' }, snapshot: null }),
    second.ui,
  )
  await registry.dispose()
  assert.deepEqual(disposed, [first.ui, second.ui])
})

test('被Host隔离的failed插件不会运行UI入口', async () => {
  let loads = 0
  const registry = new UiPluginRegistry({} as HostApi, async () => {
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
  const registry = new UiPluginRegistry({} as HostApi, async () => ({
    activate(context) {
      iconUrl = context.iconUrl
      context.contributions.register({
        id: 'example:tool',
        slot: 'tool-card',
        match: { toolName: 'review' },
        render: () => null,
      })
      context.contributions.register({
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
    const registry = new UiPluginRegistry({} as HostApi, async () => ({
      activate(context) {
        context.contributions.register(contribution)
      },
    }))
    await registry.synchronize([plugin(1)])
    assert.equal(registry.getSnapshot().length, 0)
    assert.match(registry.errors().example, /match|来源/)
    await registry.dispose()
  }
})

test('右栏面板可注册并打开，卸载后面板和响应订阅一起释放', async () => {
  let changes = 0
  let seenHost: HostApi | undefined
  let leakedBridge = false
  const host = {} as HostApi
  const registry = new UiPluginRegistry(host, async () => ({
    activate(context) {
      seenHost = context.host
      leakedBridge = 'bridge' in context
      context.reactive.subscribe(() => {
        changes++
      })
      const location = rightPanelLocation('right')
      context.panels.register({
        id: 'example:right',
        title: '文件',
        icon: null,
        location,
        scope: 'app',
        render: () => location,
      })
      context.panels.open('example:right')
    },
  }))
  await registry.synchronize([plugin(1)])
  assert.equal(seenHost, host)
  assert.equal(leakedBridge, false)
  assert.equal(registry.getPanels().length, 1)
  assert.equal(registry.getPanelRequest()?.id, 'example:right')
  registry.updateTarget({ target: { hostId: 'host', session: { hostId: 'host', sessionId: 'one' } }, snapshot: null })
  assert.equal(changes, 1)
  assert.equal(registry.getReactiveSnapshot().target.session?.sessionId, 'one')
  await registry.synchronize([])
  assert.equal(registry.getPanels().length, 0)
  registry.updateTarget({ target: { hostId: 'host' }, snapshot: null })
  assert.equal(changes, 1)
  await registry.dispose()
})

test('打开面板捕获所属会话，切换目标不修改旧请求或推进revision', async () => {
  let open!: () => void
  const registry = new UiPluginRegistry({} as HostApi, async () => ({
    activate(context) {
      context.panels.register({
        id: 'example:preview',
        title: '预览',
        icon: null,
        location: 'right',
        scope: 'project',
        render: () => null,
      })
      open = () => context.panels.open('example:preview')
    },
  }))
  const firstTarget: UiTarget = {
    hostId: 'host',
    project: { hostId: 'host', projectId: 'first-project' },
    session: { hostId: 'host', sessionId: 'first-session' },
  }
  const secondTarget: UiTarget = {
    hostId: 'host',
    project: { hostId: 'host', projectId: 'second-project' },
    session: { hostId: 'host', sessionId: 'second-session' },
  }
  registry.updateTarget({ target: firstTarget, snapshot: null })
  await registry.synchronize([plugin(1)])
  open()
  const firstRequest = registry.getPanelRequest()!
  assert.deepEqual(firstRequest, { id: 'example:preview', revision: 1, target: firstTarget })
  firstTarget.session!.sessionId = 'changed-source'
  assert.equal(firstRequest.target.session?.sessionId, 'first-session')
  registry.updateTarget({ target: secondTarget, snapshot: null })
  assert.equal(registry.getPanelRequest(), firstRequest)
  assert.equal(registry.getPanelRequest()!.revision, 1)
  assert.equal(registry.getPanelRequest()!.target.session?.sessionId, 'first-session')
  assert.equal(registry.getPanelRequest()!.target.project?.projectId, 'first-project')
  open()
  assert.deepEqual(registry.getPanelRequest(), { id: 'example:preview', revision: 2, target: secondTarget })
  assert.equal(firstRequest.target.session?.sessionId, 'first-session')
  let changes = 0
  const unsubscribe = registry.subscribe(() => {
    changes++
  })
  const secondRequest = registry.getPanelRequest()
  registry.consumePanelRequest(1)
  assert.equal(registry.getPanelRequest(), secondRequest)
  assert.equal(changes, 0)
  registry.consumePanelRequest(2)
  assert.equal(registry.getPanelRequest(), null)
  assert.equal(changes, 1)
  registry.consumePanelRequest(2)
  assert.equal(changes, 1)
  open()
  assert.deepEqual(registry.getPanelRequest(), { id: 'example:preview', revision: 3, target: secondTarget })
  assert.equal(changes, 2)
  unsubscribe()
  await registry.dispose()
})

test('面板打开必须属于本插件且已经注册，失败更新保留旧面板', async () => {
  const registry = new UiPluginRegistry({} as HostApi, async (url) => ({
    activate(context) {
      context.panels.register({
        id: 'example:files',
        title: '文件',
        icon: null,
        location: 'right',
        scope: 'project',
        render: () => url,
      })
      if (url.includes('2')) context.panels.open('other:files')
    },
  }))
  await registry.synchronize([plugin(1)])
  await registry.synchronize([plugin(2)])
  assert.equal(registry.getPanels()[0].generation, 1)
  assert.match(registry.errors().example, /自身已注册/)
  await registry.dispose()
})

test('禁止面板与聊天贡献重复标识，未知面板位置和范围被拒绝', async () => {
  for (const field of ['id', 'location', 'scope'] as const) {
    const registry = new UiPluginRegistry({} as HostApi, async () => ({
      activate(context) {
        const panel = {
          id: 'example:one',
          title: '文件',
          icon: null,
          location: 'right' as const,
          scope: 'app' as const,
          render: () => null,
        }
        if (field === 'id') {
          context.panels.register(panel)
          context.contributions.register({ id: panel.id, slot: 'status', render: () => null })
        } else context.panels.register({ ...panel, [field]: 'bad' } as typeof panel)
      },
    }))
    await registry.synchronize([plugin(1)])
    assert.equal(registry.getPanels().length, 0)
    assert.match(registry.errors().example, /重复|无效/)
    await registry.dispose()
  }
})

test('插件不能向左栏、工作区或底部注册面板，失败更新保留原右栏面板', async () => {
  for (const location of ['sidebar', 'workspace', 'bottom']) {
    const registry = new UiPluginRegistry({} as HostApi, async (url) => ({
      activate(context) {
        context.panels.register({
          id: 'example:files',
          title: '文件',
          icon: null,
          location: url.includes('2') ? location : 'right',
          scope: 'project',
          render: () => url,
        } as UiPanel)
      },
    }))
    await registry.synchronize([plugin(1)])
    await registry.synchronize([plugin(2)])
    assert.equal(registry.getPanels().length, 1)
    assert.equal(registry.getPanels()[0].location, 'right')
    assert.equal(registry.getPanels()[0].generation, 1)
    assert.match(registry.errors().example, /只能注册到聊天右侧栏/)
    await registry.dispose()
  }
})
