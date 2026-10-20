import { expect, test, vi } from 'vitest'
import type { HostApi } from '@pi-meme/contracts/app-host'
import { PluginUiConsent } from '../src/plugins/plugin-ui-consent'
import { createPluginActionHost } from '../src/plugins/plugin-action-host'

test('宿主确认只有一项待处理，按插件退役取消且不会批准其他请求', async () => {
  const consent = new PluginUiConsent()
  const pending = consent.request({ pluginId: 'first', title: '发送', description: '当前会话' })
  await expect(consent.request({ pluginId: 'second', title: '覆写', description: '草稿' })).resolves.toBe(false)
  consent.cancel('second')
  expect(consent.getSnapshot()?.pluginId).toBe('first')
  consent.cancel('first')
  await expect(pending).resolves.toBe(false)
  expect(consent.getSnapshot()).toBeNull()
})

test('消息动作的读取不请求写确认，写操作在确认后重新校验来源', async () => {
  const stop = vi.fn(async () => {})
  const snapshot = vi.fn(async () => ({ marker: 'read' }))
  const host = { sessions: { stop, snapshot } } as unknown as HostApi
  const consent = new PluginUiConsent()
  let active = true
  const facade = createPluginActionHost(
    host,
    'example',
    () => {
      if (!active) throw new Error('plugin-retired')
    },
    consent.request,
  )
  const ref = { hostId: 'host', sessionId: 'session' }
  await expect(facade.sessions.snapshot(ref)).resolves.toEqual({ marker: 'read' })
  expect(consent.getSnapshot()).toBeNull()
  const pending = facade.sessions.stop(ref, { idempotencyKey: 'stop-1' })
  expect(stop).not.toHaveBeenCalled()
  expect(consent.getSnapshot()?.description).toContain('sessions.stop')
  active = false
  consent.respond(true)
  await expect(pending).rejects.toThrow('plugin-retired')
  expect(stop).not.toHaveBeenCalled()
})

test('写确认捕获原始目标，等待期间改动参数不能写到另一个会话', async () => {
  const stop = vi.fn(async () => {})
  const host = { sessions: { stop } } as unknown as HostApi
  const consent = new PluginUiConsent()
  const facade = createPluginActionHost(host, 'example', () => {}, consent.request)
  const ref = { hostId: 'host', sessionId: 'original' }
  const pending = facade.sessions.stop(ref, { idempotencyKey: 'stop-2' })
  ref.sessionId = 'changed'
  consent.respond(true)
  await pending
  expect(stop).toHaveBeenCalledWith({ hostId: 'host', sessionId: 'original' }, { idempotencyKey: 'stop-2' })
})

test('正式 Host 读取在退役后不交付迟到结果', async () => {
  let finish!: (value: unknown) => void
  const result = new Promise((resolve) => {
    finish = resolve
  })
  const host = { sessions: { snapshot: () => result } } as unknown as HostApi
  let active = true
  const facade = createPluginActionHost(
    host,
    'example',
    () => {
      if (!active) throw new Error('plugin-retired')
    },
    async () => true,
  )
  const pending = facade.sessions.snapshot({ hostId: 'host', sessionId: 'session' })
  active = false
  finish({ secret: '迟到正文' })
  await expect(pending).rejects.toThrow('plugin-retired')
})

test('正式 Host 事件副本不污染宿主，退役自动释放且不再交付事件', async () => {
  const controller = new AbortController()
  const stop = vi.fn()
  let deliver!: (event: unknown) => void
  const host = {
    events: {
      subscribe: async (_input: unknown, listener: (event: unknown) => void) => {
        deliver = listener
        return stop
      },
    },
  } as unknown as HostApi
  const facade = createPluginActionHost(
    host,
    'example',
    () => {
      if (controller.signal.aborted) throw new Error('plugin-retired')
    },
    async () => true,
    controller.signal,
  )
  const listener = vi.fn((event: { data: { value: string } }) => {
    event.data.value = '插件改动'
  })
  const unsubscribe = await facade.events.subscribe(
    {},
    listener as unknown as Parameters<HostApi['events']['subscribe']>[1],
  )
  const event = { data: { value: '宿主原值' } }
  deliver(event)
  expect(listener).toHaveBeenCalledTimes(1)
  expect(event.data.value).toBe('宿主原值')
  controller.abort()
  deliver(event)
  unsubscribe()
  expect(listener).toHaveBeenCalledTimes(1)
  expect(stop).toHaveBeenCalledTimes(1)
})

test('来源作用域取消会关闭原确认，不会取消后来的请求', async () => {
  const consent = new PluginUiConsent()
  const controller = new AbortController()
  const pending = consent.request({
    pluginId: 'example',
    title: '旧操作',
    description: '旧目标',
    signal: controller.signal,
  })
  controller.abort()
  await expect(pending).resolves.toBe(false)
  expect(consent.getSnapshot()).toBeNull()
  const next = consent.request({ pluginId: 'example', title: '新操作', description: '新目标' })
  controller.abort()
  expect(consent.getSnapshot()?.title).toBe('新操作')
  consent.respond(true)
  await expect(next).resolves.toBe(true)
})

test('离开页面或取消动作时，不执行正在等待确认的正式写操作', async () => {
  const consent = new PluginUiConsent()
  const controller = new AbortController()
  const stop = vi.fn(async () => {})
  const host = { sessions: { stop } } as unknown as HostApi
  const facade = createPluginActionHost(host, 'example', () => {}, consent.request, controller.signal)
  const pending = facade.sessions.stop({ hostId: 'host', sessionId: 'captured' }, { idempotencyKey: 'scoped-stop' })
  expect(consent.getSnapshot()).not.toBeNull()
  controller.abort()
  await expect(pending).rejects.toThrow('cancelled')
  expect(consent.getSnapshot()).toBeNull()
  consent.respond(true)
  expect(stop).not.toHaveBeenCalled()
})
