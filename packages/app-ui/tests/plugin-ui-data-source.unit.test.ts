import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import type { HostApi } from '@pi-meme/contracts/app-host'
import type { PiMessage } from '@pi-meme/contracts/pi'
import { ChatStream } from '@pi-meme/chat/ui/model/chat-stream'
import { emptyChat } from '@pi-meme/chat/ui/model/state'
import { PluginUiDataSource } from '../src/plugins/plugin-ui-data-source'

const target = { hostId: 'host', session: { hostId: 'host', sessionId: 'session' } }
function live(text: string): PiMessage {
  return { role: 'assistant', timestamp: 1, content: [{ type: 'text', text }] } as PiMessage
}

test('running selector不跟token刷新，live索引稳定，正文按需读且没有thinking/base64', () => {
  const source = new PluginUiDataSource({} as HostApi)
  source.setEnvironment({ target, session: { status: 'ready', running: true, agentPlugins: [] } })
  const stream = new ChatStream({ ...emptyChat, running: true, live: live('开始') as never })
  source.attach(stream)
  const running = source.reactive.select((state) => state.session?.running)
  let changed = 0
  const stop = running.subscribe(() => changed++)
  const first = source.reactive.getSnapshot().messages[0]
  const body = source.reactive.body(first.id)
  assert.equal(body.getSnapshot()?.text, '开始')
  for (let index = 0; index < 100; index++)
    stream.update({ ...stream.getSnapshot(), live: live(`片段${index}`) as never })
  assert.equal(changed, 0)
  assert.equal(source.reactive.getSnapshot().messages[0], first)
  assert.equal(body.getSnapshot()?.text, '片段99')
  stream.update({ ...stream.getSnapshot(), running: false, live: null })
  assert.equal(changed, 1)
  stop()
  source.dispose()
})

test('公开环境与消息投影不可误改，且不会冻结业务源对象', () => {
  const source = new PluginUiDataSource({} as HostApi)
  const environment = {
    target: structuredClone(target),
    session: { status: 'ready', running: false, agentPlugins: ['example'] },
  }
  const message: PiMessage = {
    role: 'custom',
    customType: 'notice',
    content: '内容',
    timestamp: 1,
    display: true,
    source: { ownerId: 'example', generation: 1 },
    details: { list: [1] },
    sourceEntry: { id: 'one', type: 'custom_message', revision: 'one' },
  }
  source.setEnvironment(environment)
  const stream = new ChatStream({ ...emptyChat, messages: [message] })
  source.attach(stream)
  const snapshot = source.reactive.getSnapshot()
  const metadata = snapshot.messages[0]
  assert.throws(() => {
    snapshot.target.session!.sessionId = '污染目标'
  }, TypeError)
  assert.throws(() => {
    metadata.source!.ownerId = '污染来源'
  }, TypeError)
  assert.throws(() => {
    metadata.ref!.session.sessionId = '污染引用'
  }, TypeError)
  const body = source.reactive.body(metadata.id).getSnapshot()!
  assert.ok(Object.isFrozen(body.data))
  stream.update({ ...emptyChat, messages: [structuredClone(message)] })
  assert.equal(source.reactive.body(metadata.id).getSnapshot(), body)
  assert.equal(environment.target.session.sessionId, 'session')
  assert.equal(message.source!.ownerId, 'example')
  assert.equal(Object.isFrozen(environment.target), false)
  assert.equal(Object.isFrozen(message.source), false)
  source.dispose()
})

test('分页并发共享请求，同分支响应结构共享但不绕过Host游标校验', async () => {
  let calls = 0
  let branchRevision = 'one'
  let stale = false
  const host = {
    sessions: {
      async messages() {
        calls++
        if (stale) throw new Error('stale-cursor')
        return { messages: [], totalMessages: 0, branchRevision, leafId: 'leaf' }
      },
    },
  } as unknown as HostApi
  const source = new PluginUiDataSource(host)
  const input = { cursor: 'cursor', limit: 10 }
  const [first, shared] = await Promise.all([
    source.messages.page(target.session, input),
    source.messages.page(target.session, input),
  ])
  assert.equal(calls, 1)
  assert.equal(first, shared)
  assert.equal(await source.messages.page(target.session, input), first)
  assert.equal(calls, 2)
  branchRevision = 'two'
  assert.notEqual(await source.messages.page(target.session, input), first)
  stale = true
  await assert.rejects(source.messages.page(target.session, input), /stale-cursor/)
  source.dispose()
})

test('live正文通知合并到动画帧，终态立即发布', () => {
  let frame: FrameRequestCallback | undefined
  const schedule = vi.fn((callback: FrameRequestCallback) => {
    frame = callback
    return 1
  })
  vi.stubGlobal('requestAnimationFrame', schedule)
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  try {
    const source = new PluginUiDataSource({} as HostApi)
    source.setEnvironment({ target, session: { status: 'ready', running: true, agentPlugins: [] } })
    const stream = new ChatStream({ ...emptyChat, running: true, live: live('开始') as never })
    source.attach(stream)
    frame?.(0)
    const body = source.reactive.body(source.reactive.getSnapshot().messages[0].id)
    let changed = 0
    body.subscribe(() => changed++)
    schedule.mockClear()
    for (let index = 0; index < 100; index++)
      stream.update({ ...stream.getSnapshot(), live: live(`片段${index}`) as never })
    assert.equal(schedule.mock.calls.length, 1)
    assert.equal(changed, 0)
    frame?.(1)
    assert.equal(changed, 1)
    assert.equal(body.getSnapshot()?.text, '片段99')
    stream.update({ ...stream.getSnapshot(), live: null, running: false })
    assert.equal(changed, 2)
    source.dispose()
  } finally {
    vi.unstubAllGlobals()
  }
})

test('持久消息携带来源代次和JSON数据，summary没有消息ref', () => {
  const source = new PluginUiDataSource({} as HostApi)
  source.setEnvironment({ target, session: { status: 'ready', running: false, agentPlugins: [] } })
  const message: PiMessage = {
    role: 'custom',
    customType: 'result',
    content: '结果',
    details: { items: 2, image: { type: 'image', data: '不分发', mimeType: 'image/png' } },
    display: true,
    timestamp: 1,
    source: { ownerId: 'review', generation: 3 },
    sourceEntry: { id: 'native', type: 'custom_message', revision: 'edited' },
  }
  source.attach(
    new ChatStream({
      ...emptyChat,
      messages: [message, { role: 'compactionSummary', summary: '摘要', timestamp: 2 } as PiMessage],
    }),
  )
  const state = source.reactive.getSnapshot()
  assert.equal(state.messages.length, 1)
  assert.equal(state.messages[0].ref?.entryId, 'native')
  assert.equal(state.messages[0].source?.generation, 3)
  const body = source.reactive.body(state.messages[0].id).getSnapshot()
  assert.equal(body?.text, '结果')
  assert.equal(JSON.stringify(body).includes('不分发'), false)
  source.dispose()
})
