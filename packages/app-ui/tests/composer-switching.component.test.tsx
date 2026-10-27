import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { DesktopBridge, DesktopEvent, SessionSelectionResult, Snapshot } from '@pi-meme/contracts/desktop'
import type { PiModel, PiSlashCommand, ThinkingLevel } from '@pi-meme/contracts/pi'
import { skillMarker } from '@pi-meme/contracts/skills'
import { ComposerToolbar } from '@pi-meme/chat/ui/composer/composer-toolbar'
import { TooltipProvider } from '@pi-meme/ui/components/ui/tooltip'
import { ModelPickerPopover } from '@pi-meme/models/ui/model-picker-popover'
import { ModelConfigForm } from '@pi-meme/models/ui/model-config/model-config-form'
import type { SaveModelProvider } from '@pi-meme/contracts/model-config'
import { useAppSession } from '../src/session/use-app-session'
import { invokeSkillInNewSession } from '../src/settings/invoke-skill'
import { WorkspaceContent } from '../src/layout/workspace-content'
import { emptyChat } from '@pi-meme/chat/ui/model/state'
import { assistantMessage, toolResult, userMessage } from '../../../tests/fixtures/messages.mjs'

afterEach(cleanup)

test('切换等待立即隔离旧内容，完成或失败后恢复交互且不重建输入框', () => {
  const workspace = (sessionKey: string, switching: boolean) => (
    <WorkspaceContent
      chat={{ ...emptyChat, messages: [userMessage(sessionKey, 1)] }}
      connection={{ generation: 1, sessionKey, cwd: '/project', status: 'idle' }}
      ready
      hasConnected
      switching={switching}
      composer={<textarea aria-label="会话草稿" defaultValue="未发送的内容" />}
      conversation={<button type="button">{sessionKey} 正文操作</button>}
      canEditMessages={false}
      onEditMessage={() => {}}
      onForkReply={() => {}}
      onCopyError={() => {}}
      onSettings={() => {}}
      notice={null}
    >
      {null}
    </WorkspaceContent>
  )
  const view = render(workspace('旧会话', false))
  const composer = screen.getByRole('textbox', { name: '会话草稿' })
  const oldContent = screen.getByRole('button', { name: '旧会话 正文操作' })
  view.rerender(workspace('旧会话', true))
  expect(screen.getByRole('status').textContent).toContain('正在打开会话')
  expect(oldContent.isConnected).toBe(true)
  expect(oldContent.closest('[inert]')).not.toBeNull()
  expect(screen.queryByRole('button', { name: '旧会话 正文操作' })).toBeNull()
  expect(screen.getByRole('textbox', { name: '会话草稿' })).toBe(composer)

  view.rerender(workspace('新会话', false))
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.getByRole('button', { name: '新会话 正文操作' }).closest('[inert]')).toBeNull()
  expect(screen.getByRole('textbox', { name: '会话草稿' })).toBe(composer)

  view.rerender(workspace('新会话', true))
  view.rerender(workspace('新会话', false))
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.getByRole('button', { name: '新会话 正文操作' }).closest('[inert]')).toBeNull()
  expect((composer as HTMLTextAreaElement).value).toBe('未发送的内容')
})

test.each([
  { reasoning: true, levels: ['off', 'minimal', 'low', 'medium', 'high'] as ThinkingLevel[] },
  { reasoning: false, levels: ['off'] as ThinkingLevel[] },
  { reasoning: true, levels: ['low', 'high', 'max'] as ThinkingLevel[] },
])('模型选择器只提供 SDK 返回的档位 $levels', ({ reasoning, levels }) => {
  const model = { provider: 'custom', id: 'custom-model', name: '自定义模型', reasoning, thinkingLevels: levels }
  const onSelectThinkingLevel = vi.fn()
  const props = {
    models: [model],
    currentModel: { provider: model.provider, id: model.id },
    disabled: false,
    onSelectModel: vi.fn(),
    onSelectThinkingLevel,
  }
  const { rerender } = render(<ModelPickerPopover {...props} thinkingLevel={levels[0]} />)
  fireEvent.click(screen.getByRole('button', { name: '选择模型与思考强度' }))
  const slider = screen.getByRole('slider', { name: '思考强度滑块' })
  expect(slider.getAttribute('aria-valuemax')).toBe(String(levels.length - 1))
  for (let index = 1; index < levels.length; index++) {
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    expect(onSelectThinkingLevel).toHaveBeenLastCalledWith(levels[index])
    rerender(<ModelPickerPopover {...props} thinkingLevel={levels[index]} />)
  }
  fireEvent.click(screen.getByRole('button', { name: '重置思考强度' }))
  expect(onSelectThinkingLevel).toHaveBeenLastCalledWith(
    levels.includes('medium') ? 'medium' : reasoning ? 'high' : 'off',
  )
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

test('模型列表按供应商分组展示，支持区分同名模型并正确触发选择', () => {
  const models = [
    { provider: 'fake', id: 'common-id', name: '同名模型' },
    { provider: 'custom', id: 'common-id', name: '同名模型' },
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
  fireEvent.click(screen.getByRole('button', { name: '选择模型与思考强度' }))
  fireEvent.click(screen.getByRole('button', { name: '切换模型' }))

  expect(screen.getByText('Fake')).toBeDefined()
  expect(screen.getByText('Custom')).toBeDefined()

  const sameNameButtons = screen.getAllByRole('button', { name: '同名模型' })
  expect(sameNameButtons).toHaveLength(2)

  fireEvent.click(sameNameButtons[1])
  expect(onSelectModel).toHaveBeenCalledWith(models[1])
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

function setup(overrides: Partial<DesktopBridge> = {}, chatEnabled = false) {
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
  const hook = renderHook(() => useAppSession(bridge, { chatEnabled, workspaceEnabled: false }))
  return { ...hook, snapshot }
}

test('SSH 恢复到空闲连接时清除暂停错误', async () => {
  let emit!: Parameters<DesktopBridge['onConnection']>[0]
  const { result, snapshot } = setup({
    onConnection: (callback) => {
      emit = callback
      return () => {}
    },
  })
  await waitFor(() => expect(result.current.loading).toBe(false))
  act(() => emit({ ...snapshot.connection, status: 'disconnected', error: '连接已暂停' }))
  expect(result.current.error).toBe('连接已暂停')
  await act(async () => emit(snapshot.connection))
  expect(result.current.connection.status).toBe('idle')
  expect(result.current.error).toBe('')
})

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

test('冷会话切模型后立即读取原生记录', async () => {
  const selected = { provider: 'fake', id: 'second', name: '模型 Beta' }
  let savedSnapshot!: Snapshot
  const { result, snapshot } = setup({
    setModel: async () => {
      savedSnapshot.state.model = selected
      savedSnapshot.sessionEntries!.entries.push({
        id: 'change',
        parentId: 'reply',
        type: 'model_change',
        timestamp: '2026-10-24T10:00:02.000Z',
        model: { provider: 'fake', id: 'second' },
      })
      savedSnapshot.sessionEntries!.leafId = 'change'
      return selected
    },
    getAvailableThinkingLevels: async () => ['off', 'medium'],
  })
  savedSnapshot = snapshot
  const startedAt = Date.parse('2026-10-24T10:00:00.000Z')
  snapshot.messages = [
    { ...userMessage('提问', startedAt), sourceEntry: { id: 'user', type: 'message', revision: 'user' } },
    { ...assistantMessage('回复', startedAt + 1000), sourceEntry: { id: 'reply', type: 'message', revision: 'reply' } },
  ]
  snapshot.sessionEntries = {
    leafId: 'reply',
    entries: [
      {
        id: 'initial',
        parentId: null,
        type: 'model_change',
        timestamp: '2026-10-24T09:59:59.000Z',
        model: { provider: 'fake', id: 'first' },
      },
      { id: 'user', parentId: 'initial', type: 'message', role: 'user', timestamp: '2026-10-24T10:00:00.000Z' },
      { id: 'reply', parentId: 'user', type: 'message', role: 'assistant', timestamp: '2026-10-24T10:00:01.000Z' },
    ],
  }
  await waitFor(() => expect(result.current.loading).toBe(false))
  await act(async () => result.current.refreshSnapshot())
  await act(async () => result.current.selectModel(selected))
  expect(result.current.chat.sessionEntries?.entries.at(-1)?.model).toEqual({ provider: 'fake', id: 'second' })
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

test('同目标会话的重复选择只读取一次，切换中返回原会话不会被当成无操作', async () => {
  const pending = deferred<SessionSelectionResult>()
  const switchSession = vi.fn<DesktopBridge['switchSession']>().mockReturnValueOnce(pending.promise)
  const { result, snapshot } = setup({ switchSession })
  await waitFor(() => expect(result.current.loading).toBe(false))
  switchSession.mockResolvedValue({ cancelled: false, snapshot })
  act(() => result.current.setDraft('原会话草稿'))
  let first!: Promise<boolean>
  let duplicate!: Promise<boolean>
  act(() => {
    first = result.current.switchSession('/second.jsonl')
    duplicate = result.current.switchSession('/second.jsonl')
  })
  expect(switchSession).toHaveBeenCalledTimes(1)
  await act(async () => {
    await result.current.switchSession('main')
  })
  expect(switchSession).toHaveBeenCalledTimes(2)
  expect(result.current.connection.sessionKey).toBe('main')
  expect(result.current.draft).toBe('原会话草稿')
  await act(async () => {
    pending.resolve({
      cancelled: false,
      snapshot: { ...snapshot, connection: { ...snapshot.connection, sessionKey: 'second', generation: 2 } },
    })
    expect(await first).toBe(false)
    expect(await duplicate).toBe(false)
  })
  expect(result.current.connection.sessionKey).toBe('main')
  expect(result.current.draft).toBe('原会话草稿')
  await act(async () => {
    expect(await result.current.switchSession('main')).toBe(true)
  })
  expect(switchSession).toHaveBeenCalledTimes(2)
})

test.each([false, true])('重复新建只创建一次，旧创建结果不覆盖后来选择（指定项目=%s）', async (inProject) => {
  const pending = deferred<SessionSelectionResult>()
  const newSession = vi.fn<DesktopBridge['newSession']>().mockReturnValue(pending.promise)
  const selectWorkspace = vi.fn<DesktopBridge['selectWorkspace']>().mockReturnValue(pending.promise)
  const { result, snapshot } = setup({
    newSession,
    selectWorkspace,
    switchSession: async () => ({
      cancelled: false,
      snapshot: { ...snapshot, connection: { ...snapshot.connection, sessionKey: 'chosen', generation: 3 } },
    }),
  })
  await waitFor(() => expect(result.current.loading).toBe(false))
  act(() => result.current.setDraft('不转移到空会话的草稿'))
  let first!: Promise<boolean>
  let duplicate!: Promise<boolean>
  act(() => {
    first = inProject ? result.current.newSessionInProject('/tmp/second') : result.current.newSession()
    duplicate = inProject ? result.current.newSessionInProject('/tmp/second') : result.current.newSession()
  })
  expect(inProject ? selectWorkspace : newSession).toHaveBeenCalledTimes(1)
  await act(async () => {
    await result.current.switchSession('chosen')
  })
  await act(async () => {
    pending.resolve({
      cancelled: false,
      snapshot: { ...snapshot, connection: { ...snapshot.connection, sessionKey: 'created', generation: 2 } },
    })
    expect(await first).toBe(false)
    expect(await duplicate).toBe(false)
  })
  expect(result.current.connection.sessionKey).toBe('chosen')
  expect(result.current.draft).toBe('')
  expect(result.current.error).toBe('')
})

test('切回看过的会话立即展示缓存，Host确认前保持发送禁用', async () => {
  const opening = deferred<SessionSelectionResult>()
  const switchSession = vi.fn<DesktopBridge['switchSession']>()
  const { result, snapshot } = setup({ switchSession })
  await waitFor(() => expect(result.current.loading).toBe(false))
  const second: Snapshot = {
    ...snapshot,
    connection: { ...snapshot.connection, generation: 2, sessionKey: 'second', sessionFile: '/tmp/second.jsonl' },
    messages: [userMessage('第二个会话', 2)],
  }
  switchSession.mockResolvedValueOnce({ cancelled: false, snapshot: second })
  await act(async () => {
    await result.current.switchSession('/tmp/second.jsonl')
  })
  act(() => result.current.setDraft('第二个会话草稿'))
  switchSession.mockResolvedValueOnce({ cancelled: false, snapshot })
  await act(async () => {
    await result.current.switchSession('main')
  })
  switchSession.mockReturnValueOnce(opening.promise)
  let pending!: Promise<boolean>
  act(() => {
    pending = result.current.switchSession('/tmp/second.jsonl')
  })
  expect(result.current.connection.sessionKey).toBe('second')
  expect(result.current.chat.messages).toEqual(second.messages)
  expect(result.current.draft).toBe('第二个会话草稿')
  expect(result.current.contentLoading).toBe(false)
  expect(result.current.inputDisabled).toBe(true)
  expect(result.current.canSubmitComposer()).toBe(false)
  await act(async () => {
    opening.resolve({ cancelled: false, snapshot: second })
    expect(await pending).toBe(true)
  })
  expect(result.current.inputDisabled).toBe(false)
})

test('历史草稿中的模型已移除时使用会话回退配置并保留草稿', async () => {
  const switchSession = vi.fn<DesktopBridge['switchSession']>()
  const prompt = vi.fn().mockResolvedValue(undefined)
  const { result, snapshot } = setup({ switchSession, prompt })
  const fallback = { provider: 'fake', id: 'first', name: '模型 Alpha', reasoning: true }
  const removed = { provider: 'removed', id: 'old', name: '旧模型', reasoning: true }
  snapshot.state = { ...snapshot.state, model: fallback, thinkingLevel: 'low', isStreaming: true }
  snapshot.models = [fallback, removed]
  await waitFor(() => expect(result.current.loading).toBe(false))
  act(() => {
    result.current.setDraft('保留的历史草稿')
    void result.current.selectModel(removed)
    result.current.selectThinkingLevel('high')
  })
  expect(result.current.selectedConfiguration).toEqual({ model: removed, thinkingLevel: 'high' })

  switchSession.mockResolvedValueOnce({
    cancelled: false,
    snapshot: {
      ...snapshot,
      connection: { ...snapshot.connection, generation: 2, sessionKey: 'second' },
      state: { ...snapshot.state, isStreaming: false },
      models: [fallback],
    },
  })
  await act(async () => result.current.switchSession('second'))
  switchSession.mockResolvedValueOnce({
    cancelled: false,
    snapshot: {
      ...snapshot,
      connection: { ...snapshot.connection, generation: 3 },
      state: { ...snapshot.state, isStreaming: false },
      models: [fallback],
    },
  })
  await act(async () => result.current.switchSession('main'))
  expect(result.current.draft).toBe('保留的历史草稿')
  expect(result.current.selectedConfiguration).toEqual({ model: fallback, thinkingLevel: 'low' })
  await act(async () => result.current.send())
  expect(prompt).toHaveBeenCalledWith('main', '保留的历史草稿', [], [], {
    mode: 'default',
    model: fallback,
    thinkingLevel: 'low',
  })
})

test('没有可用模型时保留历史草稿并禁止发送', async () => {
  const switchSession = vi.fn<DesktopBridge['switchSession']>()
  const prompt = vi.fn().mockResolvedValue(undefined)
  const { result, snapshot } = setup({ switchSession, prompt })
  const removed = { provider: 'removed', id: 'old', reasoning: true }
  snapshot.state = { ...snapshot.state, model: removed, isStreaming: true }
  snapshot.models = [removed]
  await waitFor(() => expect(result.current.loading).toBe(false))
  act(() => {
    result.current.setDraft('等待配置模型')
    void result.current.selectModel(removed)
  })
  switchSession.mockResolvedValueOnce({
    cancelled: false,
    snapshot: {
      ...snapshot,
      connection: { ...snapshot.connection, generation: 2, sessionKey: 'second' },
      state: { ...snapshot.state, isStreaming: false },
    },
  })
  await act(async () => result.current.switchSession('second'))
  switchSession.mockResolvedValueOnce({
    cancelled: false,
    snapshot: {
      ...snapshot,
      connection: { ...snapshot.connection, generation: 3 },
      state: { ...snapshot.state, isStreaming: false, modelSelectionRequired: true },
      models: [],
    },
  })
  await act(async () => result.current.switchSession('main'))
  expect(result.current.draft).toBe('等待配置模型')
  expect(result.current.inputDisabled).toBe(true)
  expect(result.current.canSubmitComposer()).toBe(false)
  expect(prompt).not.toHaveBeenCalled()
})

test('新建立即显示空白草稿，创建期间输入在确认后保留且原草稿独立', async () => {
  const opening = deferred<SessionSelectionResult>()
  const { result, snapshot } = setup({
    newSession: () => opening.promise,
    switchSession: async () => ({ cancelled: false, snapshot }),
  })
  snapshot.messages = [userMessage('原会话正文', 1)]
  await waitFor(() => expect(result.current.loading).toBe(false))
  act(() => result.current.setDraft('原会话草稿'))
  let pending!: Promise<boolean>
  act(() => {
    pending = result.current.newSession()
  })
  expect(result.current.connection.sessionKey).toBeUndefined()
  expect(result.current.chat.messages).toEqual([])
  expect(result.current.draft).toBe('')
  expect(result.current.contentLoading).toBe(false)
  expect(result.current.draftEditable).toBe(true)
  expect(result.current.canSubmitComposer()).toBe(false)
  act(() => result.current.setDraft('创建过程中输入'))
  await act(async () => {
    opening.resolve({
      cancelled: false,
      snapshot: { ...snapshot, messages: [], connection: { ...snapshot.connection, generation: 2, sessionKey: 'new' } },
    })
    expect(await pending).toBe(true)
  })
  expect(result.current.draft).toBe('创建过程中输入')
  await act(async () => {
    await result.current.switchSession('main')
  })
  expect(result.current.draft).toBe('原会话草稿')
})

test('新建失败保留可编辑草稿，禁止向原会话发送并支持重试', async () => {
  const opening = deferred<SessionSelectionResult>()
  const newSession = vi.fn<DesktopBridge['newSession']>().mockReturnValueOnce(opening.promise)
  const prompt = vi.fn()
  const { result, snapshot } = setup({ newSession, prompt })
  await waitFor(() => expect(result.current.loading).toBe(false))
  let pending!: Promise<boolean>
  act(() => {
    pending = result.current.newSession()
  })
  act(() => result.current.setDraft('失败也保留这段文字'))
  await act(async () => {
    opening.reject(new Error('Host 暂时不可用'))
    expect(await pending).toBe(false)
  })
  expect(result.current.draft).toBe('失败也保留这段文字')
  expect(result.current.draftEditable).toBe(true)
  expect(result.current.inputDisabled).toBe(true)
  expect(result.current.error).toContain('Host 暂时不可用')
  await act(async () => {
    await result.current.send()
  })
  expect(prompt).not.toHaveBeenCalled()
  newSession.mockResolvedValueOnce({
    cancelled: false,
    snapshot: { ...snapshot, connection: { ...snapshot.connection, generation: 2, sessionKey: 'retry' } },
  })
  await act(async () => {
    expect(await result.current.newSession()).toBe(true)
  })
  expect(result.current.connection.sessionKey).toBe('retry')
  expect(result.current.draft).toBe('失败也保留这段文字')
})

test('离开待创建会话后再次新建使用独立请求和草稿，旧确认不影响新输入', async () => {
  const first = deferred<SessionSelectionResult>()
  const second = deferred<SessionSelectionResult>()
  const newSession = vi
    .fn<DesktopBridge['newSession']>()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
  const switchSession = vi.fn<DesktopBridge['switchSession']>()
  const { result, snapshot } = setup({ newSession, switchSession })
  await waitFor(() => expect(result.current.loading).toBe(false))
  let earlier!: Promise<boolean>
  act(() => {
    earlier = result.current.newSession()
  })
  act(() => result.current.setDraft('第一次新建输入'))
  switchSession.mockResolvedValueOnce({
    cancelled: false,
    snapshot: { ...snapshot, connection: { ...snapshot.connection, sessionKey: 'chosen', generation: 3 } },
  })
  await act(async () => {
    await result.current.switchSession('chosen')
  })
  let latest!: Promise<boolean>
  act(() => {
    latest = result.current.newSession()
  })
  expect(newSession).toHaveBeenCalledTimes(2)
  expect(result.current.draft).toBe('')
  act(() => result.current.setDraft('第二次新建输入'))
  await act(async () => {
    first.resolve({
      cancelled: false,
      snapshot: { ...snapshot, connection: { ...snapshot.connection, sessionKey: 'earlier', generation: 2 } },
    })
    expect(await earlier).toBe(false)
  })
  expect(result.current.draft).toBe('第二次新建输入')
  await act(async () => {
    second.resolve({
      cancelled: false,
      snapshot: { ...snapshot, connection: { ...snapshot.connection, sessionKey: 'latest', generation: 4 } },
    })
    expect(await latest).toBe(true)
  })
  expect(result.current.connection.sessionKey).toBe('latest')
  expect(result.current.draft).toBe('第二次新建输入')
})

test('失败的新草稿切换项目只转移当前输入，原会话草稿保留', async () => {
  const opening = deferred<SessionSelectionResult>()
  const selectWorkspace = vi.fn<DesktopBridge['selectWorkspace']>()
  const switchSession = vi.fn<DesktopBridge['switchSession']>()
  const { result, snapshot } = setup({
    newSession: () => opening.promise,
    selectWorkspace,
    switchSession,
    setSessionMode: async () => {},
  })
  await waitFor(() => expect(result.current.loading).toBe(false))
  act(() => result.current.setDraft('原会话草稿'))
  let pending!: Promise<boolean>
  act(() => {
    pending = result.current.newSession()
  })
  act(() => result.current.setDraft('失败的新草稿'))
  await act(async () => {
    opening.reject(new Error('创建失败'))
    await pending
  })
  selectWorkspace.mockResolvedValueOnce({
    cancelled: false,
    snapshot: {
      ...snapshot,
      connection: { ...snapshot.connection, cwd: '/another-project', sessionKey: 'another', generation: 2 },
    },
  })
  await act(async () => {
    expect(await result.current.selectWorkspace({ kind: 'project', cwd: '/another-project' })).toBe(true)
  })
  expect(result.current.draft).toBe('失败的新草稿')
  switchSession.mockResolvedValueOnce({ cancelled: false, snapshot })
  await act(async () => {
    await result.current.switchSession('main')
  })
  expect(result.current.draft).toBe('原会话草稿')
})

test('正文快照先于慢命令读取完成，命令返回后再更新', async () => {
  const commands = deferred<PiSlashCommand[]>()
  const { result } = setup({ getCommands: () => commands.promise }, true)
  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(result.current.connection.sessionKey).toBe('main')
  expect(result.current.commands).toEqual([])
  await act(async () => commands.resolve([{ name: 'test', source: 'builtin' } as PiSlashCommand]))
  expect(result.current.commands[0]?.name).toBe('test')
})

test('加载更早记录按ID合并，刷新保留展开范围，切换后丢弃迟到分页', async () => {
  const older = deferred<Awaited<ReturnType<DesktopBridge['readSessionHistory']>>>()
  const readSessionHistory = vi.fn<DesktopBridge['readSessionHistory']>().mockReturnValueOnce(older.promise)
  const getSnapshot = vi.fn<DesktopBridge['getSnapshot']>()
  const switchSession = vi.fn<DesktopBridge['switchSession']>()
  const { result, snapshot } = setup({ readSessionHistory, getSnapshot, switchSession })
  const message = (id: string) => ({
    ...userMessage(id, 1),
    sourceEntry: { id, type: 'message' as const, revision: id },
  })
  snapshot.messages = [message('recent')]
  snapshot.messagePage = { before: 'recent' }
  getSnapshot.mockResolvedValue(snapshot)
  await waitFor(() => expect(result.current.loading).toBe(false))
  let pending!: Promise<boolean>
  act(() => {
    pending = result.current.loadOlderMessages()
  })
  expect(readSessionHistory).toHaveBeenCalledWith('main', { limit: 60, before: 'recent' })
  await act(async () => {
    older.resolve({ cwd: snapshot.connection.cwd, created: '', messages: [message('older')] })
    expect(await pending).toBe(true)
  })
  expect(result.current.chat.messages.map((value) => value.sourceEntry?.id)).toEqual(['older', 'recent'])
  snapshot.messages = result.current.chat.messages
  snapshot.messagePage = { before: 'older' }
  await act(async () => {
    await result.current.refreshSnapshot()
  })
  expect(getSnapshot).toHaveBeenLastCalledWith({ limit: 60, from: 'older' })
  const late = deferred<Awaited<ReturnType<DesktopBridge['readSessionHistory']>>>()
  readSessionHistory.mockReturnValueOnce(late.promise)
  act(() => {
    pending = result.current.loadOlderMessages()
  })
  const next = {
    ...snapshot,
    connection: { ...snapshot.connection, sessionKey: 'second', generation: 2 },
    messages: [],
  }
  switchSession.mockResolvedValueOnce({ cancelled: false, snapshot: next })
  await act(async () => {
    await result.current.switchSession('second')
  })
  await act(async () => {
    late.resolve({ cwd: snapshot.connection.cwd, created: '', messages: [message('earliest')] })
    expect(await pending).toBe(false)
  })
  expect(result.current.connection.sessionKey).toBe('second')
  expect(result.current.chat.messages).toEqual([])
})

test('旧导航失败不覆盖新选择，不恢复或发送旧草稿', async () => {
  const old = deferred<SessionSelectionResult>()
  const switchSession = vi.fn<DesktopBridge['switchSession']>().mockReturnValueOnce(old.promise)
  const { result, snapshot } = setup({ switchSession })
  await waitFor(() => expect(result.current.loading).toBe(false))
  switchSession.mockResolvedValue({
    cancelled: false,
    snapshot: { ...snapshot, connection: { ...snapshot.connection, sessionKey: 'chosen', generation: 2 } },
  })
  const attachment = { id: 'draft-image', type: 'image' as const, mimeType: 'image/png', data: 'cG5n' }
  act(() => {
    result.current.setDraft('原会话草稿')
    result.current.setAttachments([attachment])
  })
  let selecting!: Promise<boolean>
  act(() => {
    selecting = result.current.switchSession('old')
  })
  await act(async () => {
    await result.current.switchSession('chosen')
  })
  await act(async () => {
    old.reject(new Error('旧会话读取失败'))
    expect(await selecting).toBe(false)
  })
  expect(result.current.connection.sessionKey).toBe('chosen')
  expect(result.current.draft).toBe('')
  expect(result.current.error).toBe('')
  expect(result.current.attachments).toEqual([])
  expect(switchSession).toHaveBeenCalledTimes(2)
  switchSession.mockResolvedValue({ cancelled: false, snapshot })
  await act(async () => {
    await result.current.switchSession('main')
  })
  expect(result.current.draft).toBe('原会话草稿')
  expect(result.current.attachments).toEqual([attachment])
})

test('取消编辑期间再选其他会话，以后一次为准并恢复编辑前草稿', async () => {
  const newSession = vi.fn()
  const switchSession = vi.fn<DesktopBridge['switchSession']>()
  const { result, snapshot } = setup({ newSession, switchSession })
  await waitFor(() => expect(result.current.loading).toBe(false))
  switchSession.mockResolvedValue({ cancelled: false, snapshot })
  act(() => result.current.setDraft('编辑前草稿'))
  act(() =>
    result.current.editMessage({
      role: 'user',
      content: '正在编辑',
      timestamp: 1,
      sourceEntry: { id: 'original', type: 'message', revision: '1' },
    }),
  )
  let creating!: Promise<boolean>
  let selecting!: Promise<boolean>
  await act(async () => {
    creating = result.current.newSession()
    selecting = result.current.switchSession('main')
    expect(await creating).toBe(false)
    expect(await selecting).toBe(true)
  })
  expect(newSession).not.toHaveBeenCalled()
  expect(switchSession).toHaveBeenCalledOnce()
  expect(result.current.editing).toBe(false)
  expect(result.current.draft).toBe('编辑前草稿')
})

test('直接选择历史会话会取消编辑，返回后恢复编辑前草稿而不是历史编辑内容', async () => {
  const switchSession = vi.fn<DesktopBridge['switchSession']>()
  const { result, snapshot } = setup({ switchSession })
  await waitFor(() => expect(result.current.loading).toBe(false))
  switchSession
    .mockResolvedValueOnce({
      cancelled: false,
      snapshot: { ...snapshot, connection: { ...snapshot.connection, sessionKey: 'second', generation: 2 } },
    })
    .mockResolvedValueOnce({ cancelled: false, snapshot })
  act(() => result.current.setDraft('编辑前草稿'))
  act(() =>
    result.current.editMessage({
      role: 'user',
      content: '正在编辑',
      timestamp: 1,
      sourceEntry: { id: 'original', type: 'message', revision: '1' },
    }),
  )
  await act(async () => {
    await result.current.switchSession('second')
  })
  expect(result.current.editing).toBe(false)
  expect(result.current.draft).toBe('')
  await act(async () => {
    await result.current.switchSession('main')
  })
  expect(result.current.editing).toBe(false)
  expect(result.current.draft).toBe('编辑前草稿')
})

test('权限更新与分叉进行中不能用导航替换写操作', async () => {
  let emit!: (connection: Snapshot['connection']) => void
  const forked = deferred<SessionSelectionResult>()
  const switchSession = vi.fn()
  const newSession = vi.fn()
  const { result, snapshot } = setup({
    onConnection: (callback) => {
      emit = callback
      return () => {}
    },
    forkReply: () => forked.promise,
    switchSession,
    newSession,
  })
  await waitFor(() => expect(result.current.loading).toBe(false))
  act(() => emit({ ...snapshot.connection, accessChanging: true }))
  expect(result.current.navigationDisabledReason).toBeTruthy()
  await act(async () => {
    expect(await result.current.switchSession('second')).toBe(false)
    expect(await result.current.newSession()).toBe(false)
  })
  act(() => emit(snapshot.connection))
  let forking!: Promise<void>
  act(() => {
    forking = result.current.forkReply(1)
  })
  expect(result.current.navigationDisabledReason).toContain('分支')
  await act(async () => {
    expect(await result.current.switchSession('second')).toBe(false)
    expect(await result.current.newSession()).toBe(false)
  })
  expect(switchSession).not.toHaveBeenCalled()
  expect(newSession).not.toHaveBeenCalled()
  await act(async () => {
    forked.resolve({ cancelled: false, snapshot })
    await forking
  })
  expect(result.current.navigationDisabledReason).toBeUndefined()
})

test('历史消息替换正在提交时，导航和新建不能取消编辑或更换目标', async () => {
  const edited = deferred<Awaited<ReturnType<DesktopBridge['editAndPrompt']>>>()
  const switchSession = vi.fn()
  const newSession = vi.fn()
  const { result, snapshot } = setup({ editAndPrompt: () => edited.promise, switchSession, newSession })
  snapshot.messages = [
    { role: 'user', content: '原消息', timestamp: 1, sourceEntry: { id: 'original', type: 'message', revision: '1' } },
  ]
  await waitFor(() => expect(result.current.loading).toBe(false))
  act(() => result.current.editMessage(snapshot.messages[0]))
  let sending!: Promise<void>
  await act(async () => {
    sending = result.current.send()
  })
  expect(result.current.editSubmitting).toBe(true)
  expect(result.current.navigationDisabledReason).toBeTruthy()
  await act(async () => {
    expect(await result.current.switchSession('second')).toBe(false)
    expect(await result.current.newSession()).toBe(false)
  })
  expect(result.current.editing).toBe(true)
  expect(switchSession).not.toHaveBeenCalled()
  expect(newSession).not.toHaveBeenCalled()
  await act(async () => {
    edited.resolve({ recoveredInputs: [] })
    await sending
  })
  expect(result.current.connection.sessionKey).toBe('main')
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
      sourceEntry: { id: 'user-12345', type: 'message', revision: '1' },
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
      sourceEntry: { id: 'user-999', type: 'message', revision: '1' },
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

test('暂停换配置后编辑继承选择，取消编辑不改变运行配置，再发送使用最终选择', async () => {
  const setModel = vi.fn()
  const setThinkingLevel = vi.fn()
  const editAndPrompt = vi.fn<DesktopBridge['editAndPrompt']>().mockResolvedValue({ recoveredInputs: [] })
  const { result, snapshot } = setup({ setModel, setThinkingLevel, editAndPrompt })
  snapshot.state.isStreaming = true
  snapshot.state.isPaused = true
  snapshot.messages = [
    {
      role: 'user',
      content: '原消息',
      timestamp: 100,
      sourceEntry: { id: 'user-entry', type: 'message', revision: '1' },
    },
  ]
  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(result.current.modelPickerDisabled).toBe(false)
  const model = { provider: 'fake', id: 'second' }
  act(() => {
    result.current.setDraft('保留主输入草稿')
    void result.current.selectModel(model)
    result.current.selectThinkingLevel('high')
  })
  act(() => result.current.editMessage(snapshot.messages[0]))
  expect(result.current.selectedConfiguration).toEqual({ model, thinkingLevel: 'high' })
  act(() => result.current.selectThinkingLevel('low'))
  await act(async () => result.current.cancelEdit())
  expect(result.current.selectedConfiguration).toEqual({ model, thinkingLevel: 'high' })
  expect(result.current.draft).toBe('保留主输入草稿')
  expect(setModel).not.toHaveBeenCalled()
  expect(setThinkingLevel).not.toHaveBeenCalled()
  act(() => result.current.editMessage(snapshot.messages[0]))
  act(() => result.current.selectThinkingLevel('max'))
  await act(async () => result.current.send())
  expect(editAndPrompt).toHaveBeenCalledWith('main', 'user-entry', '原消息', [], [], {
    mode: 'default',
    model,
    thinkingLevel: 'max',
  })
  expect(result.current.draft).toBe('保留主输入草稿')
})

test('思考强度保存完成前不发送普通消息', async () => {
  const saved = deferred<void>()
  const prompt = vi.fn().mockResolvedValue(undefined)
  const { result } = setup({ setThinkingLevel: () => saved.promise, prompt })
  await waitFor(() => expect(result.current.loading).toBe(false))
  act(() => {
    result.current.selectThinkingLevel('high')
    result.current.setDraft('等待新强度')
  })
  let sending!: Promise<void>
  await act(async () => {
    sending = result.current.send()
  })
  expect(prompt).not.toHaveBeenCalled()
  await act(async () => {
    saved.resolve()
    await sending
  })
  expect(prompt).toHaveBeenCalledTimes(1)
})

test('停止后按所选配置继续任务，保留主草稿和原消息图片，不覆盖历史', async () => {
  const editAndPrompt = vi.fn<DesktopBridge['editAndPrompt']>().mockResolvedValue({ recoveredInputs: [] })
  const continueStopped = vi.fn<DesktopBridge['continueStopped']>().mockResolvedValue(undefined)
  const resume = vi.fn()
  const { result, snapshot } = setup({ editAndPrompt, continueStopped, resume })
  const image = { type: 'image' as const, mimeType: 'image/png', data: 'cG5n' }
  snapshot.messages = [
    {
      role: 'user',
      content: [{ type: 'text', text: '含图片的原消息' }, image],
      timestamp: 100,
      sourceEntry: { id: 'user-entry', type: 'message', revision: '1' },
    },
  ]
  snapshot.state.stopped = true
  snapshot.state.queuePaused = true
  await waitFor(() => expect(result.current.loading).toBe(false))
  act(() => {
    result.current.setDraft('新的主草稿')
    result.current.selectThinkingLevel('high')
  })
  expect(result.current.configurationChanged).toBe(true)
  await act(async () => result.current.resume())
  expect(continueStopped).toHaveBeenCalledTimes(1)
  expect(continueStopped).toHaveBeenCalledWith('main', { model: snapshot.state.model, thinkingLevel: 'high' })
  expect(result.current.editing).toBe(false)
  expect(result.current.chat.messages).toEqual(snapshot.messages)
  expect(result.current.draft).toBe('新的主草稿')
  expect(editAndPrompt).not.toHaveBeenCalled()
  expect(resume).not.toHaveBeenCalled()
})

test('停止后有主草稿时发送新消息，清空草稿后可继续当前任务', () => {
  const onResume = vi.fn()
  const toolbar = (draft: string) => (
    <TooltipProvider>
      <ComposerToolbar
        paused
        stopped
        running={false}
        disabled={false}
        draft={draft}
        hasAttachments={false}
        queueMode="followUp"
        onQueueMode={() => {}}
        onSteeringMode={() => {}}
        onFollowUpMode={() => {}}
        onStop={() => {}}
        model={null}
        access={null}
        contextUsage={null}
        editing={false}
        onResume={onResume}
      />
    </TooltipProvider>
  )
  const view = render(toolbar('保留的主草稿'))
  expect(screen.getByRole('button', { name: '发送消息' }).getAttribute('type')).toBe('submit')
  expect(screen.queryByRole('button', { name: '继续当前任务' })).toBeNull()
  expect(onResume).not.toHaveBeenCalled()
  view.rerender(toolbar(''))
  fireEvent.click(screen.getByRole('button', { name: '继续当前任务' }))
  expect(onResume).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('button', { name: '继续当前任务' }).getAttribute('type')).toBe('button')
})

test('自定义模型默认勾选全部档位，独立保存勾选和已有参数映射', async ({ onTestFinished }) => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  onTestFinished(() => {
    vi.unstubAllGlobals()
  })
  const onSave = vi.fn<(input: SaveModelProvider) => Promise<boolean>>().mockResolvedValue(true)
  render(
    <ModelConfigForm
      provider={{
        id: 'custom',
        name: '自定义',
        baseUrl: 'https://example.com/v1',
        api: 'openai-responses',
        hasApiKey: false,
        models: [{ id: 'first' }, { id: 'second', reasoning: true, thinkingLevelMap: { low: null, max: 'ultra' } }],
      }}
      snapshot={{ path: '/test/models.json', revision: 'revision', providers: [] }}
      busy={false}
      bridge={{ discoverModels: vi.fn() }}
      onSave={onSave}
      onClose={vi.fn()}
    />,
  )
  for (const label of ['关闭', '极小', '低', '中', '高', '极高', '最大']) {
    expect((screen.getByRole('checkbox', { name: `first ${label}` }) as HTMLInputElement).checked).toBe(true)
  }
  expect((screen.getByRole('checkbox', { name: 'second 低' }) as HTMLInputElement).checked).toBe(false)
  expect((screen.getByRole('checkbox', { name: 'second 极高' }) as HTMLInputElement).checked).toBe(false)
  fireEvent.click(screen.getByRole('checkbox', { name: 'first 高' }))
  fireEvent.click(screen.getByRole('button', { name: '保存服务商' }))
  await waitFor(() => expect(onSave).toHaveBeenCalledOnce())
  const models = onSave.mock.calls[0][0].provider.models
  expect(models[0].reasoning).toBe(true)
  expect(models[0].thinkingLevelMap).toEqual({ high: null, xhigh: 'xhigh', max: 'max' })
  expect(models[1].thinkingLevelMap).toEqual({ low: null, xhigh: null, max: 'ultra' })
})

test('思考强度保存后显示服务端实际生效值', async () => {
  const { result, snapshot } = setup({
    setThinkingLevel: async () => {
      snapshot.state.thinkingLevel = 'high'
      snapshot.thinkingLevels = ['off', 'medium', 'high']
    },
  })
  await waitFor(() => expect(result.current.loading).toBe(false))
  act(() => result.current.selectThinkingLevel('max'))
  await waitFor(() => expect(result.current.state?.thinkingLevel).toBe('high'))
  expect(result.current.thinkingLevels).toEqual(['off', 'medium', 'high'])
})
