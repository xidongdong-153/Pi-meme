import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { ChatBridge } from '@pi-meme/contracts/desktop'
import { useChatSession } from '../src/ui/use-chat-session'
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
function fixture(overrides: Partial<ChatBridge> = {}) {
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
