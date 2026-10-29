import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { ChatBridge } from '@pi-meme/contracts/desktop'
import { useChatSession, type ChatSessionOptions } from '../src/ui/use-chat-session'
import type { ComposerDraftState } from '../src/ui/composer/composer-state'

afterEach(cleanup)
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
function fixture(overrides: Partial<ChatBridge> = {}, options: Partial<ChatSessionOptions> = {}) {
  const bridge = {
    prompt: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    uploadAttachment: vi.fn().mockResolvedValue({ name: 'file.txt', path: '/host/file.txt' }),
    ...overrides,
  } as unknown as ChatBridge
  const hook = renderHook(() =>
    useChatSession({
      bridge,
      commands: [],
      canSend: () => true,
      isSwitching: () => false,
      awaitPendingSwitch: async () => {},
      currentGeneration: () => 1,
      currentSessionKey: () => 'session',
      onError: () => {},
      ...options,
    }),
  )
  return { ...hook, bridge }
}

test('发送前等待期间用户继续输入会取消，迟到候选不能发送或清空新稿', async () => {
  const { result, bridge } = fixture()
  const prepared = deferred<{ composer: ComposerDraftState; records: [] }>()
  let source!: ComposerDraftState
  let signal!: AbortSignal
  act(() => {
    result.current.setDraft('原稿')
    result.current.setSubmissionIntegration({
      blocked: () => undefined,
      prepare: (value, _intent, inputSignal) => {
        source = value
        signal = inputSignal
        return prepared.promise
      },
    })
  })
  let sending!: Promise<boolean>
  act(() => {
    sending = result.current.submitComposer()
  })
  act(() => result.current.setDraft('用户继续输入的新稿'))
  expect(signal.aborted).toBe(true)
  await act(async () => {
    prepared.resolve({ composer: { ...source, draft: '迟到改写' }, records: [] })
    expect(await sending).toBe(false)
  })
  expect(bridge.prompt).not.toHaveBeenCalled()
  expect(result.current.draft).toBe('用户继续输入的新稿')
})

test('原生发送使用候选文本但保留运行中 followUp 语义', async () => {
  const { result, bridge } = fixture()
  act(() => {
    result.current.applyEvent({ type: 'agent_start' })
    result.current.setDraft('原稿')
    result.current.setSubmissionIntegration({
      blocked: () => undefined,
      prepare: async (source) => ({ composer: { ...source, draft: '已授权改写' }, records: [] }),
    })
  })
  await act(async () => {
    expect(await result.current.submitComposer()).toBe(true)
  })
  expect(bridge.prompt).not.toHaveBeenCalled()
  expect(bridge.followUp).toHaveBeenCalledWith('session', '已授权改写', [], [], { mode: 'default' })
  expect(result.current.draft).toBe('')
})

test('计划实施复用发送前处理，保留草稿与附件，阻止重复提交并传递选定模型', async () => {
  const pending = deferred<void>()
  const { result, bridge } = fixture({ prompt: vi.fn(() => pending.promise) })
  act(() => {
    result.current.setDraft('未发送草稿')
    result.current.updateConfiguration({ model: { provider: 'fake', id: 'selected' }, thinkingLevel: 'high' })
    result.current.setSubmissionIntegration({
      blocked: () => undefined,
      prepare: async (source) => ({ composer: { ...source, draft: '已处理的实施要求' }, records: [] }),
    })
  })
  const plan = { intent: 'execute' as const, reference: { id: 'plan', revision: 2 } }
  let sending!: Promise<boolean>
  await act(async () => {
    sending = result.current.submitPlan(plan)
    await Promise.resolve()
  })
  await act(async () => {
    expect(await result.current.submitPlan(plan)).toBe(false)
  })
  expect(bridge.prompt).toHaveBeenCalledExactlyOnceWith('session', '已处理的实施要求', [], [], {
    mode: 'default',
    plan,
    model: { provider: 'fake', id: 'selected' },
    thinkingLevel: 'high',
  })
  expect(result.current.draft).toBe('未发送草稿')
  await act(async () => {
    pending.resolve()
    expect(await sending).toBe(true)
  })
  expect(result.current.draft).toBe('未发送草稿')
})

test('网络失败不把旧技能附件或正文合并进等待期间的新稿', async () => {
  const pending = deferred<void>()
  const { result } = fixture({ prompt: () => pending.promise })
  act(() => result.current.setDraft('发送失败的原稿'))
  let sending!: Promise<boolean>
  await act(async () => {
    sending = result.current.submitComposer()
    await Promise.resolve()
  })
  act(() => result.current.setDraft('等待期间的新稿'))
  await act(async () => {
    pending.reject(new Error('网络断开'))
    expect(await sending).toBe(false)
  })
  expect(result.current.draft).toBe('等待期间的新稿')
  expect(result.current.failedDrafts).toHaveLength(1)
  expect(result.current.failedDrafts[0]?.draft).toBe('发送失败的原稿')
})

test('SDK 与原生共享上传队列，同 tick 上传即阻止直接调用发送', async () => {
  const upload = deferred<{ name: string; path: string }>()
  const { result, bridge } = fixture({ uploadAttachment: () => upload.promise })
  act(() => result.current.setDraft('等附件'))
  let uploading!: Promise<void>
  act(() => {
    uploading = result.current.composerFiles.addFiles([new File(['file'], 'file.txt')])
  })
  await act(async () => {
    expect(await result.current.submitComposer()).toBe(false)
  })
  expect(bridge.prompt).not.toHaveBeenCalled()
  await act(async () => {
    upload.resolve({ name: 'file.txt', path: '/host/file.txt' })
    await uploading
  })
  expect(result.current.attachments).toHaveLength(1)
})

test('计划网络重试沿用原提交标识，失败不覆盖草稿', async () => {
  const submitPlan = vi.fn().mockRejectedValueOnce(new Error('网络断开')).mockResolvedValue(undefined)
  const { result, bridge } = fixture({}, { submitPlan })
  const plan = { intent: 'execute' as const, reference: { id: 'plan', revision: 1 } }
  act(() => result.current.setDraft('仍未发送的草稿'))
  await act(async () => {
    expect(await result.current.submitPlan(plan)).toBe(false)
  })
  expect(result.current.draft).toBe('仍未发送的草稿')
  await act(async () => {
    expect(await result.current.submitPlan(plan)).toBe(true)
  })
  expect(submitPlan).toHaveBeenCalledTimes(2)
  expect(submitPlan.mock.calls[0]).toEqual(submitPlan.mock.calls[1])
  expect(bridge.prompt).not.toHaveBeenCalled()
})

test('草图反馈复用发送守卫并保留主草稿，提交状态为独立快照', async () => {
  const { result, bridge } = fixture()
  const context = { reference: { id: '12345678-1234-1234-1234-123456789012', revision: 1 }, state: { stage: 'ready' } }
  const prepare = vi.fn(async (source: ComposerDraftState) => ({ composer: source, records: [] }))
  act(() => {
    result.current.setDraft('主输入框的未发送文字')
    result.current.setSubmissionIntegration({ blocked: () => undefined, prepare })
  })
  await act(async () => {
    expect(await result.current.submitVisualization('请调整当前草图', context)).toBe(true)
  })
  context.state.stage = 'changed'
  expect(prepare).toHaveBeenCalledOnce()
  expect(bridge.prompt).toHaveBeenCalledWith('session', '请调整当前草图', [], [], {
    mode: 'default',
    visualization: { reference: context.reference, state: { stage: 'ready' } },
  })
  expect(result.current.draft).toBe('主输入框的未发送文字')
})

test('运行中草图反馈排队，失败不覆盖主输入框', async () => {
  const { result, bridge } = fixture({ followUp: vi.fn().mockRejectedValue(new Error('发送失败')) })
  act(() => {
    result.current.applyEvent({ type: 'agent_start' })
    result.current.setDraft('保留主稿')
  })
  await act(async () => {
    expect(
      await result.current.submitVisualization('继续调整草图', {
        reference: { id: '12345678-1234-1234-1234-123456789012', revision: 1 },
        state: {},
      }),
    ).toBe(false)
  })
  expect(bridge.followUp).toHaveBeenCalledOnce()
  expect(bridge.prompt).not.toHaveBeenCalled()
  expect(result.current.draft).toBe('保留主稿')
  expect(result.current.failedDrafts).toEqual([])
})
