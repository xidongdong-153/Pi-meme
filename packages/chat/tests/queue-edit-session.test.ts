import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ChatBridge } from '@pi-meme/contracts/desktop'
import type { QueuedInput } from '@pi-meme/contracts/plan'
import { useChatSession } from '../src/ui/use-chat-session'

test('队列编辑的迟到返回只取消旧会话占位，不回填新会话草稿', async () => {
  let currentKey = 'old'
  let generation = 1
  let resolve!: (input: QueuedInput) => void
  const pending = new Promise<QueuedInput>((done) => {
    resolve = done
  })
  const cancelled: string[] = []
  const errors: string[] = []
  let hook!: ReturnType<typeof useChatSession>
  function Capture() {
    hook = useChatSession({
      bridge: {
        beginQueueEdit: () => pending,
        cancelQueueEdit: async (key: string, id: string) => {
          cancelled.push(`${key}:${id}`)
        },
      } as unknown as ChatBridge,
      commands: [],
      canSend: () => true,
      isSwitching: () => false,
      awaitPendingSwitch: async () => {},
      currentGeneration: () => generation,
      currentSessionKey: () => currentKey,
      onError: (message) => errors.push(message),
    })
    return null
  }
  renderToStaticMarkup(createElement(Capture))
  const started = hook.editQueueInput('queued')
  currentKey = 'new'
  generation = 2
  resolve({
    id: 'queued',
    text: '旧会话消息',
    mode: 'plan',
    images: [{ type: 'image', mimeType: 'image/png', data: 'YWJj' }],
  })
  await started
  assert.deepEqual(cancelled, ['old:queued'])
  assert.equal(hook.captureComposer().draft, '')
  assert.deepEqual(hook.captureComposer().attachments, [])
  assert.deepEqual(errors, [])
})

test('编辑开始失败保留草稿，并刷新队列投影', async () => {
  const errors: string[] = []
  let refreshed = 0
  let hook!: ReturnType<typeof useChatSession>
  function Capture() {
    hook = useChatSession({
      bridge: {
        beginQueueEdit: async () => {
          throw new Error('排队消息已被处理')
        },
      } as unknown as ChatBridge,
      refresh: async () => {
        refreshed++
      },
      commands: [],
      canSend: () => true,
      isSwitching: () => false,
      awaitPendingSwitch: async () => {},
      currentGeneration: () => 1,
      currentSessionKey: () => 'current',
      onError: (message) => errors.push(message),
    })
    return null
  }
  renderToStaticMarkup(createElement(Capture))
  await hook.editQueueInput('queued')
  assert.match(errors[0], /排队消息已被处理/)
  assert.equal(refreshed, 1)
  assert.equal(hook.captureComposer().draft, '')
})

test('取消队列编辑失败时保留占位与原草稿，可重试取消并刷新状态', async () => {
  let rejectCancel = true
  let cancelled = 0
  let refreshed = 0
  const errors: string[] = []
  let hook!: ReturnType<typeof useChatSession>
  function Capture() {
    hook = useChatSession({
      bridge: {
        beginQueueEdit: async () => ({ id: 'queued', text: '排队原文', mode: 'default' }),
        cancelQueueEdit: async () => {
          cancelled++
          if (rejectCancel) throw new Error('取消编辑失败')
        },
        setSessionMode: async () => {},
      } as unknown as ChatBridge,
      refresh: async () => {
        refreshed++
      },
      commands: [],
      canSend: () => true,
      isSwitching: () => false,
      awaitPendingSwitch: async () => {},
      currentGeneration: () => 1,
      currentSessionKey: () => 'current',
      onError: (message) => errors.push(message),
    })
    return null
  }
  renderToStaticMarkup(createElement(Capture))
  await hook.editQueueInput('queued')
  await hook.cancelEdit()
  assert.equal(cancelled, 1)
  assert.equal(refreshed, 1)
  assert.ok(errors.some((message) => message.includes('取消编辑失败')))
  rejectCancel = false
  await hook.cancelEdit()
  assert.equal(cancelled, 2, '失败仍保留同一编辑租约，重试实际发送取消')
  await hook.cancelEdit()
  assert.equal(cancelled, 2, '确认取消后退出队列编辑')
})

test('开始编辑等待期间切换模式，取消后恢复返回时最新模式', async () => {
  let resolve!: (input: QueuedInput) => void
  const pending = new Promise<QueuedInput>((done) => {
    resolve = done
  })
  const writtenModes: string[] = []
  let hook!: ReturnType<typeof useChatSession>
  function Capture() {
    hook = useChatSession({
      bridge: {
        beginQueueEdit: () => pending,
        cancelQueueEdit: async () => {},
        setSessionMode: async (_key: string, mode: string) => {
          writtenModes.push(mode)
        },
      } as unknown as ChatBridge,
      commands: [],
      canSend: () => true,
      isSwitching: () => false,
      awaitPendingSwitch: async () => {},
      currentGeneration: () => 1,
      currentSessionKey: () => 'current',
      onError: () => {},
    })
    return null
  }
  renderToStaticMarkup(createElement(Capture))
  const started = hook.editQueueInput('queued')
  hook.changeMode('plan')
  resolve({ id: 'queued', text: '普通消息', mode: 'default' })
  await started
  await hook.cancelEdit()
  await new Promise<void>((done) => setImmediate(done))
  assert.deepEqual(writtenModes, ['plan', 'default', 'plan'])
})
