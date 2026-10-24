import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react'
import { createElement } from 'react'
import type { ChatBridge, Snapshot } from '@pi-meme/contracts/desktop'
import { TooltipProvider } from '@pi-meme/ui/components/ui/tooltip'
import { Composer, type ComposerProps } from '../src/ui/composer/composer'
import { useChatSession, type ChatSessionOptions } from '../src/ui/use-chat-session'
import { applyEvent, emptyChat, restoreSnapshot } from '../src/ui/model/state'
import { assistantMessage, sessionState, toolResult, userMessage } from '../../../tests/fixtures/messages.mjs'

const recovery = { entryId: 'failure-entry', mode: 'default' as const }
const failed = assistantMessage('', 3000, { stopReason: 'error', errorMessage: 'Connection error.' })

function snapshot(): Snapshot {
  return {
    connection: { generation: 1, cwd: '/', status: 'ready', sessionKey: 'current' },
    state: { ...sessionState(), mode: 'default', recovery },
    messages: [userMessage('处理任务', 1000), failed],
    models: [],
  }
}

function deferred() {
  let resolve!: () => void
  let reject!: (cause: Error) => void
  const promise = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function props(overrides: Partial<ComposerProps> = {}): ComposerProps {
  return {
    draft: '',
    onDraft: () => {},
    selectedSkills: [],
    onSkills: () => {},
    attachments: [],
    uploadAttachment: async () => ({ name: 'file', path: '/attachments/file' }),
    onAddImages: () => {},
    onRemoveImage: () => {},
    running: false,
    disabled: false,
    queueMode: 'followUp',
    onQueueMode: () => {},
    onSteeringMode: () => {},
    onFollowUpMode: () => {},
    queues: { steering: [], followUp: [] },
    onSend: () => {},
    onStop: () => {},
    onClearQueue: () => {},
    commands: [],
    widgetsAbove: null,
    widgetsBelow: null,
    statusBadges: null,
    focusVersion: 0,
    onError: () => {},
    model: null,
    access: null,
    contextUsage: null,
    editing: false,
    onCancelEdit: () => {},
    recovery,
    onRecover: () => {},
    ...overrides,
  }
}

function composer(input: ComposerProps) {
  return createElement(TooltipProvider, null, createElement(Composer, input))
}

function session(overrides: Partial<ChatSessionOptions> = {}) {
  const recover = vi.fn(async () => {})
  const refresh = vi.fn(async () => {})
  const onError = vi.fn()
  const options: ChatSessionOptions = {
    bridge: { recover } as unknown as ChatBridge,
    commands: [],
    canSend: () => true,
    isSwitching: () => false,
    awaitPendingSwitch: async () => {},
    currentGeneration: () => 1,
    currentSessionKey: () => 'current',
    onError,
    refresh,
    ...overrides,
  }
  const hook = renderHook(useChatSession, { initialProps: options })
  act(() => hook.result.current.loadSnapshot(snapshot(), null))
  return { ...hook, options, recover, refresh, onError }
}

afterEach(cleanup)

test.each(['active', 'paused', 'blocked', 'usage_limited', 'complete'] as const)(
  '已有 %s 目标时，只有 complete 允许普通失败恢复',
  async (status) => {
    const hook = session()
    act(() =>
      hook.result.current.loadSnapshot(
        {
          ...snapshot(),
          goal: {
            goalId: 'goal',
            revision: 1,
            session: { hostId: 'host', sessionId: 'current' },
            objective: '保留目标控制',
            status,
            tokensUsed: 0,
            elapsedMs: 0,
            usageIncomplete: false,
            evidence: [],
            turns: 0,
            createdAt: '2026-10-20',
            updatedAt: '2026-10-20',
          },
        },
        null,
      ),
    )
    await act(async () => hook.result.current.recover())
    assert.equal(hook.recover.mock.calls.length, status === 'complete' ? 1 : 0)
    assert.equal(hook.refresh.mock.calls.length, status === 'complete' ? 1 : 0)
    assert.equal(hook.result.current.recovering, false)
  },
)

test('最新失败只在空输入发送位显示恢复，空 Enter 和表单提交均不恢复', () => {
  const onRecover = vi.fn()
  const onSend = vi.fn()
  const view = render(composer(props({ onRecover, onSend })))
  const button = view.getByRole('button', { name: '恢复当前任务' }) as HTMLButtonElement
  assert.equal(button.type, 'button')
  assert.equal(button.title, '恢复当前任务')
  assert.equal(button.disabled, false)
  assert.ok(button.querySelector('.lucide-rotate-ccw'))
  fireEvent.keyDown(view.getByRole('combobox', { name: '消息' }), { key: 'Enter', code: 'Enter' })
  fireEvent.submit(view.getByRole('form', { name: '消息输入' }))
  assert.equal(onRecover.mock.calls.length, 0)
  assert.equal(onSend.mock.calls.length, 0)
  fireEvent.click(button)
  assert.equal(onRecover.mock.calls.length, 1)
  assert.equal(onSend.mock.calls.length, 0)
})

test('草稿和附件仍正常发送，历史和队列编辑态不提供恢复', () => {
  const onRecover = vi.fn()
  const onSend = vi.fn()
  const view = render(composer(props({ draft: '新的草稿', onRecover, onSend })))
  assert.equal(view.queryByRole('button', { name: '恢复当前任务' }), null)
  fireEvent.click(view.getByRole('button', { name: '发送消息' }))
  assert.equal(onSend.mock.calls.length, 1)
  view.rerender(
    composer(
      props({
        attachments: [{ id: 'file', type: 'file', name: 'notes.txt', path: '/attachments/notes.txt' }],
        onRecover,
        onSend,
      }),
    ),
  )
  assert.equal(view.queryByRole('button', { name: '恢复当前任务' }), null)
  fireEvent.click(view.getByRole('button', { name: '发送消息' }))
  assert.equal(onSend.mock.calls.length, 2)
  for (const overrides of [{ editing: true }, { editingQueue: true }, { running: true }, { paused: true }]) {
    view.rerender(composer(props(overrides)))
    assert.equal(view.queryByRole('button', { name: '恢复当前任务' }), null)
  }
  view.rerender(composer(props({ recovery: undefined })))
  assert.equal(view.queryByRole('button', { name: '恢复当前任务' }), null)
  assert.equal((view.getByRole('button', { name: '发送消息' }) as HTMLButtonElement).disabled, true)
  assert.equal(onRecover.mock.calls.length, 0)
})

test('恢复等待显示 spinner 并禁止重复点击，新草稿不会误发送，运行后恢复停止按钮', () => {
  const onRecover = vi.fn()
  const onSend = vi.fn()
  const view = render(composer(props({ recovering: true, onRecover })))
  const button = view.getByRole('button', { name: '恢复当前任务' }) as HTMLButtonElement
  assert.equal(button.disabled, true)
  assert.ok(button.querySelector('.animate-spin'))
  fireEvent.click(button)
  assert.equal(onRecover.mock.calls.length, 0)
  view.rerender(composer(props({ recovering: true, draft: '等待期间的新草稿', onSend })))
  assert.equal((view.getByRole('button', { name: '发送消息' }) as HTMLButtonElement).disabled, true)
  fireEvent.submit(view.getByRole('form', { name: '消息输入' }))
  assert.equal(onSend.mock.calls.length, 0)
  view.rerender(composer(props({ running: true, recovery: undefined })))
  assert.equal(view.queryByRole('button', { name: '恢复当前任务' }), null)
  assert.equal((view.getByRole('button', { name: '停止当前任务' }) as HTMLButtonElement).disabled, false)
})

test('恢复请求同步防重，成功刷新快照且保留等待期间输入的草稿和附件', async () => {
  const pending = deferred()
  const recover = vi.fn(() => pending.promise)
  const prompt = vi.fn(async () => {})
  const hook = session({ bridge: { recover, prompt } as unknown as ChatBridge })
  let started!: Promise<void>
  act(() => {
    started = hook.result.current.recover()
    void hook.result.current.recover()
  })
  assert.equal(recover.mock.calls.length, 1)
  assert.deepEqual(recover.mock.calls[0], ['current', 'failure-entry'])
  assert.equal(hook.result.current.recovering, true)
  const attachments = [{ id: 'file', type: 'file' as const, name: 'draft.txt', path: '/attachments/draft.txt' }]
  act(() => {
    hook.result.current.setDraft('恢复时新写的草稿')
    hook.result.current.setAttachments(attachments)
  })
  await act(async () => hook.result.current.send())
  assert.equal(prompt.mock.calls.length, 0, '恢复仍等待时不发送新草稿')
  await act(async () => {
    pending.resolve()
    await started
  })
  assert.equal(hook.refresh.mock.calls.length, 1)
  assert.equal(hook.result.current.recovering, false)
  assert.equal(hook.result.current.draft, '恢复时新写的草稿')
  assert.deepEqual(hook.result.current.attachments, attachments)
})

test('恢复失败保留错误和草稿，再次恢复仍可请求', async () => {
  const pending = deferred()
  const recover = vi.fn(() => pending.promise)
  const hook = session({ bridge: { recover } as unknown as ChatBridge })
  let started!: Promise<void>
  act(() => {
    started = hook.result.current.recover()
  })
  act(() => hook.result.current.setDraft('保留草稿'))
  await act(async () => {
    pending.reject(new Error('网络仍不可用'))
    await started
  })
  assert.equal(hook.result.current.recovering, false)
  assert.equal(hook.result.current.draft, '保留草稿')
  assert.equal(hook.result.current.chat.recovery?.entryId, recovery.entryId)
  assert.ok(hook.onError.mock.calls.some(([message]) => String(message).includes('网络仍不可用')))
  assert.equal(hook.refresh.mock.calls.length, 1)
  await act(async () => hook.result.current.recover())
  assert.equal(recover.mock.calls.length, 1, '有草稿时不允许恢复')
  act(() => hook.result.current.setDraft(''))
  await act(async () => hook.result.current.recover())
  assert.equal(recover.mock.calls.length, 2)
})

test('恢复迟到返回不刷新或改写新会话，旧请求结束不清除新会话 pending', async () => {
  let key = 'current'
  let generation = 1
  const first = deferred()
  const second = deferred()
  const recover = vi
    .fn()
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise)
  const hook = session({
    bridge: { recover } as unknown as ChatBridge,
    currentSessionKey: () => key,
    currentGeneration: () => generation,
  })
  let oldRequest!: Promise<void>
  act(() => {
    oldRequest = hook.result.current.recover()
  })
  key = 'other'
  generation = 2
  hook.rerender(hook.options)
  assert.equal(hook.result.current.recovering, false)
  let newRequest!: Promise<void>
  act(() => {
    newRequest = hook.result.current.recover()
  })
  await act(async () => {
    first.reject(new Error('旧会话恢复失败'))
    await oldRequest
  })
  assert.equal(hook.refresh.mock.calls.length, 0)
  assert.equal(hook.result.current.recovering, true)
  assert.ok(hook.onError.mock.calls.every(([message]) => !message))
  await act(async () => {
    second.resolve()
    await newRequest
  })
  assert.equal(hook.refresh.mock.calls.length, 1)
  assert.equal(hook.result.current.recovering, false)
})

test('恢复事件仅清除指定失败消息，保留旧错误、正文和工具结果；快照及结算恢复入口一致', () => {
  const previous = assistantMessage('', 500, { stopReason: 'error', errorMessage: '旧错误' })
  const completed = assistantMessage('已经检查', 2000)
  const tool = toolResult('read-file', '已保存的文件内容', 2500)
  const source: Snapshot = {
    ...snapshot(),
    messages: [previous, userMessage('处理任务', 1000), completed, tool, failed],
    sessionEntries: {
      leafId: recovery.entryId,
      entries: [
        {
          id: 'completed',
          parentId: null,
          timestamp: new Date(2000).toISOString(),
          type: 'message',
          role: 'assistant',
          messageTimestamp: 2000,
        },
        {
          id: recovery.entryId,
          parentId: 'completed',
          timestamp: new Date(3000).toISOString(),
          type: 'message',
          role: 'assistant',
          messageTimestamp: 3000,
        },
      ],
    },
  }
  const restored = restoreSnapshot(source, null)
  assert.deepEqual(restored.recovery, recovery)
  const recovering = applyEvent(restored, { type: 'recovery_start', removedMessageTimestamps: [2000, 2500, 3000] })
  assert.deepEqual(recovering.messages, source.messages.slice(0, -1))
  assert.equal(recovering.recovery, undefined)
  assert.equal(recovering.live, null)
  assert.equal(recovering.retry, undefined)
  assert.equal(recovering.tools['read-file'].status, 'success')
  assert.equal(recovering.sessionEntries?.leafId, recovery.entryId)
  assert.equal(recovering.sessionEntries?.entries[0].display, undefined)
  assert.deepEqual(recovering.sessionEntries?.entries[1], { ...source.sessionEntries!.entries[1], display: false })
  const running = applyEvent(restored, { type: 'agent_start' })
  assert.equal(running.running, true)
  assert.equal(running.recovery, undefined)
  const settled = applyEvent(running, { type: 'agent_settled', recovery })
  assert.equal(settled.running, false)
  assert.deepEqual(settled.recovery, recovery)
  assert.equal(applyEvent(settled, { type: 'agent_settled' }).recovery, undefined)
  const replayed = restoreSnapshot(source, [
    { generation: 1, sessionKey: 'current', event: { type: 'recovery_start', removedMessageTimestamps: [3000] } },
    { generation: 1, sessionKey: 'current', event: { type: 'agent_start' } },
  ])
  assert.deepEqual(replayed.messages, source.messages.slice(0, -1))
  assert.equal(replayed.running, true)
  assert.equal(replayed.recovery, undefined)
  assert.equal(applyEvent(emptyChat, { type: 'agent_settled', recovery }).recovery, recovery)
})
