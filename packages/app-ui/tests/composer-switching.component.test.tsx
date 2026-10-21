import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { DesktopBridge, DesktopEvent, SessionSelectionResult, Snapshot } from '@pi-meme/contracts/desktop'
import { thinkingLevels, type PiModel, type PiSlashCommand, type ThinkingLevel } from '@pi-meme/contracts/pi'
import { skillMarker } from '@pi-meme/contracts/skills'
import { ModelPickerPopover } from '@pi-meme/models/ui/model-picker-popover'
import { useAppSession } from '../src/session/use-app-session'
import { invokeSkillInNewSession } from '../src/settings/invoke-skill'
import { assistantMessage, toolResult, userMessage } from '../../../tests/fixtures/messages.mjs'

afterEach(cleanup)

test.each([true, false])('模型 reasoning=%s 时均可选择关闭到最大的全部思考档位', (reasoning) => {
  const model = { provider: 'custom', id: 'custom-model', name: '自定义模型', reasoning }
  const onSelectThinkingLevel = vi.fn()
  const props = {
    models: [model],
    currentModel: model,
    disabled: false,
    onSelectModel: vi.fn(),
    onSelectThinkingLevel,
  }
  const { rerender } = render(<ModelPickerPopover {...props} thinkingLevel="off" />)
  fireEvent.click(screen.getByRole('button', { name: '选择模型与思考强度' }))
  const slider = screen.getByRole('slider', { name: '思考强度滑块' })
  expect(slider.getAttribute('aria-valuemax')).toBe(String(thinkingLevels.length - 1))
  for (let index = 1; index < thinkingLevels.length; index++) {
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    expect(onSelectThinkingLevel).toHaveBeenLastCalledWith(thinkingLevels[index])
    rerender(<ModelPickerPopover {...props} thinkingLevel={thinkingLevels[index]} />)
  }
  fireEvent.keyDown(screen.getByRole('slider'), { key: 'Home' })
  expect(onSelectThinkingLevel).toHaveBeenLastCalledWith('off')
})

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
    fireEvent.click(screen.getByRole('button', { name: '切换模型' }))
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

function contextStats(tokens: number): NonNullable<Snapshot['stats']> {
  return {
    sessionFile: undefined,
    sessionId: 'main',
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 2,
    tokens: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, total: tokens },
    cost: 0,
    contextUsage: { tokens, contextWindow: 100000, percent: tokens / 1000 },
  }
}

const assistantEnd: DesktopEvent = {
  generation: 1,
  sessionKey: 'main',
  event: { type: 'message_end', message: assistantMessage('继续执行工具', 1, { stopReason: 'toolUse' }) },
}

test('上下文统计在模型回复结束后单独刷新，不等待工具或整次运行结束', async () => {
  let emit!: (event: DesktopEvent) => void
  const stats = contextStats(12000)
  const getSessionStats = vi.fn().mockResolvedValue(stats)
  const getSnapshot = vi.fn<DesktopBridge['getSnapshot']>()
  const { result, snapshot } = setup({
    getSessionStats,
    getSnapshot,
    onEvent: (callback) => {
      emit = callback
      return () => {}
    },
  })
  getSnapshot.mockResolvedValue(snapshot)
  await waitFor(() => expect(result.current.loading).toBe(false))
  const snapshotReads = getSnapshot.mock.calls.length
  act(() => {
    emit({ ...assistantEnd, sessionKey: 'background' })
    emit({ ...assistantEnd, generation: 0 })
    emit({ ...assistantEnd, event: { type: 'message_end', message: userMessage('用户消息', 2) } })
    emit({ ...assistantEnd, event: { type: 'message_end', message: toolResult('tool', '工具结果', 3) } })
    emit({ ...assistantEnd, event: { type: 'agent_start' } })
  })
  expect(getSessionStats).not.toHaveBeenCalled()

  await act(async () => emit(assistantEnd))
  expect(result.current.sessionStats).toEqual(stats)
  expect(result.current.chatStream.getSnapshot().running).toBe(true)
  expect(getSessionStats).toHaveBeenCalledTimes(1)
  expect(getSnapshot).toHaveBeenCalledTimes(snapshotReads)

  getSessionStats.mockRejectedValueOnce(new Error('统计读取失败'))
  await act(async () => emit(assistantEnd))
  expect(result.current.sessionStats).toEqual(stats)
})

test.each(['reply', 'snapshot', 'session'] as const)(
  '上下文统计迟到结果不覆盖新回复、快照或会话：%s',
  async (replacement) => {
    let emit!: (event: DesktopEvent) => void
    const pending = deferred<NonNullable<Snapshot['stats']>>()
    const latest = contextStats(24000)
    const getSessionStats = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(latest)
    const { result, snapshot } = setup({
      getSessionStats,
      onEvent: (callback) => {
        emit = callback
        return () => {}
      },
      switchSession: async () => ({
        cancelled: false,
        snapshot: {
          ...snapshot,
          connection: { ...snapshot.connection, generation: 2, sessionKey: 'second' },
          stats: latest,
        },
      }),
    })
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => emit(assistantEnd))
    expect(getSessionStats).toHaveBeenCalledTimes(1)
    await act(async () => {
      if (replacement === 'reply') emit(assistantEnd)
      else if (replacement === 'snapshot') {
        snapshot.stats = latest
        await result.current.refreshSnapshot()
      } else await result.current.switchSession('second')
    })
    expect(result.current.sessionStats).toEqual(latest)
    await act(async () => pending.resolve(contextStats(12000)))
    expect(result.current.sessionStats).toEqual(latest)
  },
)

test.each([
  ['plugin-creator', '帮我创建一个插件'],
  ['skill-creator', undefined],
])('创建向导 %s 在新会话预填技能，并保留原会话草稿', async (name, prompt) => {
  let active = 'main'
  const command: PiSlashCommand = {
    name: `skill:${name}`,
    source: 'skill',
    resourceId: name,
    resourceRevision: 'new-revision',
    sourceInfo: { path: `/skills/${name}/SKILL.md`, source: 'builtin', scope: 'user', origin: 'top-level' },
  }
  const getCommands = async () => (active === 'created' ? [command] : [])
  const { result, snapshot } = setup({
    getCommands,
    newSession: async () => {
      active = 'created'
      return {
        cancelled: false,
        snapshot: {
          ...snapshot,
          connection: { ...snapshot.connection, generation: 2, sessionKey: active },
        },
      }
    },
    switchSession: async () => {
      active = 'main'
      return { cancelled: false, snapshot }
    },
    readSessionHistory: async () => ({ messages: [], cwd: '/tmp/first', created: '' }),
  })
  await waitFor(() => expect(result.current.loading).toBe(false))
  act(() => result.current.setDraft('保留原会话的内容'))

  await act(async () => {
    expect(await invokeSkillInNewSession(result.current, getCommands, name!, prompt)).toBe(true)
  })
  expect(result.current.connection.sessionKey).toBe('created')
  expect(result.current.selectedSkills).toEqual([command])
  expect(result.current.draft).toBe(prompt ? `${skillMarker} ${prompt}` : `${skillMarker} `)

  await act(async () => {
    await result.current.switchSession('main')
  })
  expect(result.current.draft).toBe('保留原会话的内容')
  expect(result.current.selectedSkills).toEqual([])
})

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

test('切换会话时不提前清空统计与思考档位，也不再读取历史预览', async () => {
  const selection = deferred<SessionSelectionResult>()
  const readSessionHistory = vi.fn()
  const stats = { tokens: { input: 3, output: 4, total: 7 } } as Snapshot['stats']
  const { result, snapshot } = setup({
    switchSession: () => selection.promise,
    readSessionHistory,
  })
  snapshot.stats = stats
  await act(async () => {
    await result.current.refreshSnapshot()
  })
  expect(result.current.sessionStats).toEqual(stats)
  expect(result.current.thinkingLevels).toEqual(['off', 'low', 'medium', 'high'])

  let selecting!: Promise<boolean>
  act(() => {
    selecting = result.current.switchSession('/tmp/second.jsonl')
  })
  expect(result.current.switching).toBe(true)
  // 切换期间输入保持只读，但统计和思考档位不应先被清空。
  expect(result.current.inputDisabled).toBe(true)
  expect(result.current.sessionStats).toEqual(stats)
  expect(result.current.thinkingLevels).toEqual(['off', 'low', 'medium', 'high'])
  // 不再先读取历史预览，避免提交两次对话。
  expect(readSessionHistory).not.toHaveBeenCalled()

  await act(async () => {
    selection.resolve({
      cancelled: false,
      snapshot: {
        ...snapshot,
        connection: { ...snapshot.connection, generation: 2, sessionKey: 'second' },
        stats: { tokens: { input: 5, output: 7, total: 12 } } as Snapshot['stats'],
      },
    })
    await selecting
  })
  expect(result.current.switching).toBe(false)
  expect(result.current.sessionStats).toEqual({ tokens: { input: 5, output: 7, total: 12 } })
  expect(result.current.inputDisabled).toBe(false)
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

test('外部连接切换会话时清空旧对话与草稿，不把内容带到新会话', async () => {
  let notifyConnection: ((value: Snapshot['connection']) => void) | undefined
  const { result, snapshot } = setup({
    onConnection: (callback) => {
      notifyConnection = callback
      return () => {}
    },
  })
  snapshot.messages = [{ role: 'user', content: '旧会话内容', timestamp: 1 }]
  await waitFor(() => expect(result.current.chat.messages).toHaveLength(1))
  act(() => result.current.setDraft('旧会话草稿'))

  act(() => {
    notifyConnection?.({ ...snapshot.connection, generation: 2, sessionKey: 'external', cwd: '/tmp/external' })
  })

  expect(result.current.connection.sessionKey).toBe('external')
  expect(result.current.chat.messages).toEqual([])
  expect(result.current.draft).toBe('')
})

test('正在编辑历史消息时新建会话，默认取消编辑并恢复原草稿', async () => {
  const newSessionResult: SessionSelectionResult = {
    cancelled: false,
    snapshot: {
      connection: { status: 'idle', cwd: '/work', sessionKey: 'new-key', generation: 2 },
      state: {
        model: { provider: 'fake', id: 'fake', name: 'Fake' },
        thinkingLevel: 'off',
        mode: 'default',
        isStreaming: false,
        isCompacting: false,
        steeringMode: 'one-at-a-time',
        followUpMode: 'all',
        pendingMessageCount: 0,
      },
      messages: [],
      models: [],
      thinkingLevels: ['off'],
    },
  }
  const { result } = setup({
    newSession: vi.fn().mockResolvedValue(newSessionResult),
  })
  await waitFor(() => expect(result.current.loading).toBe(false))
  act(() => result.current.setDraft('编辑前的初始草稿'))
  act(() => {
    result.current.editMessage({
      role: 'user',
      timestamp: 12345,
      content: '正在编辑的历史消息',
    })
  })
  expect(result.current.editing).toBe(true)
  expect(result.current.draft).toBe('正在编辑的历史消息')

  await act(async () => {
    await result.current.newSession()
  })

  expect(result.current.editing).toBe(false)
  expect(result.current.connection.sessionKey).toBe('new-key')
})

test('正在编辑历史消息时在指定项目中新建会话，默认取消编辑并选择该项目', async () => {
  const newSessionResult: SessionSelectionResult = {
    cancelled: false,
    snapshot: {
      connection: { status: 'idle', cwd: '/work/other', sessionKey: 'project-key', generation: 2 },
      state: {
        model: { provider: 'fake', id: 'fake', name: 'Fake' },
        thinkingLevel: 'off',
        mode: 'default',
        isStreaming: false,
        isCompacting: false,
        steeringMode: 'one-at-a-time',
        followUpMode: 'all',
        pendingMessageCount: 0,
      },
      messages: [],
      models: [],
      thinkingLevels: ['off'],
    },
  }
  const selectWorkspace = vi.fn().mockResolvedValue(newSessionResult)
  const { result } = setup({
    selectWorkspace,
  })
  await waitFor(() => expect(result.current.loading).toBe(false))
  act(() => {
    result.current.editMessage({
      role: 'user',
      timestamp: 999,
      content: '待取消的编辑',
    })
  })
  expect(result.current.editing).toBe(true)

  await act(async () => {
    await result.current.newSessionInProject('/work/other')
  })

  expect(result.current.editing).toBe(false)
  expect(selectWorkspace).toHaveBeenCalledWith({ kind: 'project', cwd: '/work/other' })
  expect(result.current.connection.sessionKey).toBe('project-key')
})
