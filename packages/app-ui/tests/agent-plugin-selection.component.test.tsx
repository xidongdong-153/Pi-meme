import { useState } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { AppSession, HostApi, SessionConfiguration } from '@pi-meme/contracts/app-host'
import type { ResourceCatalog, ResourceItem } from '@pi-meme/contracts/resources'
import type { ResourceClient } from '@pi-meme/client/resource-client'
import type { UiPluginDescriptor } from '@pi-meme/plugin-sdk/ui'
import { useAgentPluginSelection } from '../src/plugins/use-agent-plugin-selection'

afterEach(cleanup)

function session(id: string, agentPlugins: string[] = []): AppSession {
  return {
    hostId: 'host',
    sessionId: id,
    cwd: '/project',
    createdAt: '',
    status: 'idle',
    configuration: { agentPlugins },
  }
}
function plugin(id: string, agent = true): UiPluginDescriptor {
  return {
    id,
    version: '1',
    generation: 1,
    display: { name: `名称 ${id}` },
    enabled: true,
    status: 'active',
    capabilities: { agent, server: false, ui: !agent, resources: false },
  }
}
function resource(id: string, enabled = true): ResourceItem {
  return {
    id: `app:${id}`,
    name: id,
    kind: 'app-plugin',
    owner: { id, type: 'app-package' },
    enabled,
    scope: 'host',
    revision: '1',
    path: '',
    sourcePath: '',
    baseDir: '',
    defaultPolicy: {},
    invocation: 'automatic',
    diagnostics: [],
    editable: false,
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function setup(initial = session('a')) {
  const plugins = [
    plugin('agent'),
    plugin('second'),
    plugin('ui', false),
    plugin('project-off'),
    { ...plugin('disabled'), enabled: false },
    { ...plugin('failed'), status: 'failed' as const },
  ]
  const catalog: ResourceCatalog = {
    generation: 1,
    dataRoot: '/data',
    diagnostics: [],
    items: plugins.map((item) => resource(item.id, item.id !== 'project-off')),
  }
  const resources = { catalog: vi.fn(async () => catalog), onChange: () => () => {} } as unknown as ResourceClient
  const configure = vi.fn(async (ref: { sessionId: string }, configuration: SessionConfiguration) => ({
    ...session(ref.sessionId),
    configuration,
  }))
  const get = vi.fn(async (ref: { sessionId: string }) => session(ref.sessionId, ['agent']))
  const host = { sessions: { configure, get } } as unknown as HostApi
  const onError = vi.fn()
  const onChanged = vi.fn(async () => {})
  const initialProps: { target: AppSession; busy: boolean; resourceClient?: ResourceClient } = {
    target: initial,
    busy: false,
  }
  const rendered = renderHook(
    ({ target, busy, resourceClient }: { target: AppSession; busy: boolean; resourceClient?: ResourceClient }) => {
      const [pluginMentions, onPluginMentions] = useState<string[]>([])
      return useAgentPluginSelection({
        host,
        session: target,
        plugins,
        resources: resourceClient ?? resources,
        cwd: target.cwd,
        pluginMentions,
        onPluginMentions,
        busy,
        onChanged,
        onError,
      })
    },
    { initialProps },
  )
  return { ...rendered, host, configure, get, resources, onError, onChanged }
}

test('只列当前项目可用的 Agent 插件，恢复会话配置且不读取模型', async () => {
  const f = setup(session('a', ['agent']))
  await waitFor(() => expect(f.result.current.loading).toBe(false))
  expect(f.result.current.options.map((item) => item.id)).toEqual(['agent', 'second'])
  expect(f.result.current.selected.map((item) => item.name)).toEqual(['名称 agent'])
  expect(f.result.current.mentions).toEqual([])
  await act(async () => {
    expect(await f.result.current.select('agent')).toBe(true)
  })
  expect(f.result.current.mentions.map((item) => item.id)).toEqual(['agent'])
  expect(f.configure).not.toHaveBeenCalled()
  expect(f.resources.catalog).toHaveBeenCalledWith('/project')
})

test('资源 RPC 客户端重建不清空已保存的插件或本条草稿引用', async () => {
  const target = session('a')
  const f = setup(target)
  await waitFor(() => expect(f.result.current.loading).toBe(false))
  await act(async () => {
    expect(await f.result.current.select('agent')).toBe(true)
  })
  f.rerender({ target, busy: false, resourceClient: { ...f.resources } })
  await waitFor(() => expect(f.result.current.options.map((item) => item.id)).toEqual(['agent', 'second']))
  expect(f.result.current.ids).toEqual(['agent'])
  expect(f.result.current.mentions.map((item) => item.id)).toEqual(['agent'])
})

test('配置成功前保留旧选择，去重并阻止并发写入，成功后刷新命令', async () => {
  const f = setup()
  await waitFor(() => expect(f.result.current.loading).toBe(false))
  const pending = deferred<AppSession>()
  f.configure.mockImplementationOnce(() => pending.promise)
  let saving!: Promise<boolean>
  act(() => {
    saving = f.result.current.change(['agent', 'agent'])
  })
  expect(f.result.current.saving).toBe(true)
  expect(f.result.current.selected).toEqual([])
  await act(async () => {
    expect(await f.result.current.change(['second'])).toBe(false)
  })
  expect(f.configure).toHaveBeenCalledTimes(1)
  expect(f.configure.mock.calls[0]).toEqual([
    { hostId: 'host', sessionId: 'a' },
    { agentPlugins: ['agent'] },
    { idempotencyKey: expect.any(String) },
  ])
  await act(async () => {
    pending.resolve(session('a', ['agent']))
    expect(await saving).toBe(true)
  })
  expect(f.result.current.ids).toEqual(['agent'])
  expect(f.result.current.saving).toBe(false)
  expect(f.onChanged).toHaveBeenCalledTimes(1)
})

test('保存失败保留原选择，运行中拒绝修改，不影响其他会话', async () => {
  const f = setup(session('a', ['agent']))
  await waitFor(() => expect(f.result.current.loading).toBe(false))
  f.configure.mockRejectedValueOnce(new Error('保存失败'))
  await act(async () => {
    expect(await f.result.current.change([])).toBe(false)
  })
  expect(f.result.current.ids).toEqual(['agent'])
  expect(f.result.current.saving).toBe(false)
  expect(f.onError).toHaveBeenCalledWith(expect.stringContaining('保存失败'))
  f.rerender({ target: session('b'), busy: true })
  await waitFor(() => expect(f.result.current.loading).toBe(false))
  await act(async () => {
    expect(await f.result.current.change(['agent'])).toBe(false)
  })
  expect(f.result.current.ids).toEqual([])
  expect(f.configure).toHaveBeenCalledTimes(1)
})

test('迟到保存不污染另一个会话，返回原会话时同步 Host 的实际配置', async () => {
  const a = session('a')
  const f = setup(a)
  await waitFor(() => expect(f.result.current.loading).toBe(false))
  const pending = deferred<AppSession>()
  f.configure.mockImplementationOnce(() => pending.promise)
  let saving!: Promise<boolean>
  act(() => {
    saving = f.result.current.change(['agent'])
  })
  f.rerender({ target: session('b'), busy: false })
  await waitFor(() => expect(f.result.current.loading).toBe(false))
  expect(f.result.current.ids).toEqual([])
  f.rerender({ target: a, busy: false })
  await waitFor(() => expect(f.result.current.loading).toBe(false))
  expect(f.result.current.saving).toBe(true)
  await act(async () => {
    pending.resolve(session('a', ['agent']))
    await saving
  })
  expect(f.result.current.ids).toEqual(['agent'])
  expect(f.result.current.saving).toBe(false)
})
