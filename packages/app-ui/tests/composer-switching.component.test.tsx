import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { DesktopBridge, SessionSelectionResult, Snapshot } from '@pi-meme/contracts/desktop'
import type { PiModel, ThinkingLevel } from '@pi-meme/contracts/pi'
import { ModelPickerPopover } from '@pi-meme/models/ui/model-picker-popover'
import { useAppSession } from '../src/session/use-app-session'

afterEach(cleanup)

test('选择模型后直接收起弹框，不再跳回思考面板', () => {
  const models = [
    { provider: 'fake', id: 'first', name: '模型 Alpha' },
    { provider: 'fake', id: 'second', name: '模型 Beta' },
  ]
  const onSelectModel = vi.fn()
  render(
    <ModelPickerPopover
      models={models}
      currentModel={models[0]}
      disabled={false}
      onSelectModel={onSelectModel}
      onSelectThinkingLevel={vi.fn()}
    />,
  )
  const openModels = () => {
    fireEvent.click(screen.getByRole('button', { name: '选择模型与思考强度' }))
    fireEvent.click(screen.getByRole('button', { name: '模型 Alpha' }))
  }
  openModels()
  fireEvent.click(screen.getByRole('button', { name: '模型 Beta' }))
  expect(onSelectModel).toHaveBeenCalledWith(models[1])
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('slider')).toBeNull()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: Error) => void
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, resolve, reject }
}

function setup(overrides: Partial<DesktopBridge> = {}) {
  const snapshot: Snapshot = {
    connection: { generation: 1, sessionKey: 'main', cwd: '/tmp/first', workspaceKind: 'project', status: 'idle' },
    state: {
      mode: 'default',
      model: { provider: 'fake', id: 'first', name: '模型 Alpha' },
      thinkingLevel: 'medium',
      isStreaming: false,
      isCompacting: false,
      steeringMode: 'one-at-a-time',
      followUpMode: 'all',
      pendingMessageCount: 0,
    },
    messages: [],
    models: [],
    thinkingLevels: ['off', 'low', 'medium', 'high'],
  }
  const bridge = {
    getConnection: async () => snapshot.connection,
    getSnapshot: async () => snapshot,
    getCommands: async () => [],
    onConnection: () => () => {},
    onError: () => () => {},
    onEvent: () => () => {},
    ...overrides,
  } as unknown as DesktopBridge
  const hook = renderHook(() => useAppSession(bridge, { chatEnabled: false, workspaceEnabled: false }))
  return { ...hook, snapshot }
}

test('切模型立即更新名称且不禁用输入，发送等待模型和思考档位保存完成', async () => {
  const model = deferred<PiModel>()
  const levels = deferred<ThinkingLevel[]>()
  const prompt = vi.fn().mockResolvedValue(undefined)
  const selected = { provider: 'fake', id: 'second', name: '模型 Beta' }
  const { result } = setup({
    setModel: () => model.promise,
    getAvailableThinkingLevels: () => levels.promise,
    prompt,
  })
  await waitFor(() => expect(result.current.loading).toBe(false))
  act(() => result.current.setDraft('使用新模型发送'))
  let selecting!: Promise<unknown>
  act(() => {
    selecting = result.current.selectModel(selected)
  })
  expect(result.current.state?.model).toEqual(selected)
  expect(result.current.inputDisabled).toBe(false)
  expect(result.current.modelPickerDisabled).toBe(false)
  expect(result.current.accessBusy).toBe(false)
  expect(result.current.workspaceDisabledReason).toBeUndefined()

  let sending!: Promise<void>
  await act(async () => {
    sending = result.current.send()
  })
  expect(prompt).not.toHaveBeenCalled()
  await act(async () => model.resolve(selected))
  expect(prompt).not.toHaveBeenCalled()
  await act(async () => {
    levels.resolve(['off', 'medium', 'high'])
    await selecting
    await sending
  })
  expect(prompt).toHaveBeenCalledTimes(1)
  expect(result.current.thinkingLevels).toEqual(['off', 'medium', 'high'])
})

test('切模型失败恢复原模型并保留草稿，不使用旧模型发送等待中的消息', async () => {
  const model = deferred<PiModel>()
  const prompt = vi.fn().mockResolvedValue(undefined)
  const { result, snapshot } = setup({ setModel: () => model.promise, prompt })
  await waitFor(() => expect(result.current.loading).toBe(false))
  act(() => result.current.setDraft('保留这条消息'))
  act(() => {
    void result.current.selectModel({ provider: 'fake', id: 'second', name: '模型 Beta' })
  })
  let sending!: Promise<void>
  await act(async () => {
    sending = result.current.send()
  })
  await act(async () => {
    model.reject(new Error('模型保存失败'))
    await sending
  })
  expect(result.current.state?.model).toEqual(snapshot.state.model)
  expect(result.current.draft).toBe('保留这条消息')
  expect(result.current.error).toContain('模型保存失败')
  expect(prompt).not.toHaveBeenCalled()
})

test('切模型期间连续发送时，首条消息和排队消息都等待保存', async () => {
  const model = deferred<PiModel>()
  const prompt = vi.fn().mockResolvedValue(undefined)
  const followUp = vi.fn().mockResolvedValue(undefined)
  const selected = { provider: 'fake', id: 'second', name: '模型 Beta' }
  const { result } = setup({
    setModel: () => model.promise,
    getAvailableThinkingLevels: async () => ['off', 'medium'],
    prompt,
    followUp,
  })
  await waitFor(() => expect(result.current.loading).toBe(false))
  act(() => {
    void result.current.selectModel(selected)
  })
  act(() => result.current.setDraft('首条消息'))
  let first!: Promise<void>
  await act(async () => {
    first = result.current.send()
  })
  act(() => result.current.setDraft('排队消息'))
  let second!: Promise<void>
  await act(async () => {
    second = result.current.send()
  })
  expect(prompt).not.toHaveBeenCalled()
  expect(followUp).not.toHaveBeenCalled()
  await act(async () => {
    model.resolve(selected)
    await Promise.all([first, second])
  })
  expect(prompt).toHaveBeenCalledTimes(1)
  expect(followUp).toHaveBeenCalledTimes(1)
})

test('思考强度即时更新且不禁用输入，过期失败不覆盖新选择，当前失败恢复档位', async () => {
  const first = deferred<void>()
  const second = deferred<void>()
  const setThinkingLevel = vi.fn((_key: string, level: ThinkingLevel) =>
    level === 'high' ? first.promise : second.promise,
  )
  const { result, snapshot } = setup({ setThinkingLevel })
  await waitFor(() => expect(result.current.loading).toBe(false))
  act(() => result.current.setDraft('保留草稿'))
  act(() => result.current.selectThinkingLevel('high'))
  expect(result.current.state?.thinkingLevel).toBe('high')
  expect(result.current.inputDisabled).toBe(false)
  expect(result.current.modelPickerDisabled).toBe(false)
  expect(result.current.workspaceDisabledReason).toBeUndefined()
  expect(result.current.draft).toBe('保留草稿')

  act(() => result.current.selectThinkingLevel('low'))
  await act(async () => first.reject(new Error('旧请求失败')))
  expect(result.current.state?.thinkingLevel).toBe('low')
  expect(result.current.error).toBe('')
  await act(async () => second.resolve())
  snapshot.state.thinkingLevel = 'low'

  const failure = deferred<void>()
  setThinkingLevel.mockReturnValue(failure.promise)
  act(() => result.current.selectThinkingLevel('off'))
  await act(async () => failure.reject(new Error('保存失败')))
  expect(result.current.state?.thinkingLevel).toBe('low')
  expect(result.current.error).toContain('保存失败')
})

test('项目切换期间保留多行草稿，完成后将草稿转移到新项目', async () => {
  const selection = deferred<SessionSelectionResult>()
  const { result, snapshot } = setup({ selectWorkspace: () => selection.promise })
  await waitFor(() => expect(result.current.loading).toBe(false))
  const draft = '第一行\n第二行\n第三行'
  act(() => result.current.setDraft(draft))
  let selecting!: Promise<boolean>
  act(() => {
    selecting = result.current.selectWorkspace({ kind: 'project', cwd: '/tmp/second' })
  })
  expect(result.current.switching).toBe(true)
  expect(result.current.draft).toBe(draft)

  await act(async () => {
    selection.resolve({
      cancelled: false,
      snapshot: {
        ...snapshot,
        connection: { ...snapshot.connection, generation: 2, sessionKey: 'second', cwd: '/tmp/second' },
      },
    })
    await selecting
  })
  expect(result.current.connection.cwd).toBe('/tmp/second')
  expect(result.current.draft).toBe(draft)
  expect(result.current.switching).toBe(false)
})
