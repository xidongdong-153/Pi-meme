import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { ChatBridge, Snapshot } from '@pi-meme/contracts/desktop'
import type { Goal, GoalInput } from '@pi-meme/contracts/goal'
import { builtinCommands } from '@pi-meme/contracts/pi'
import { useChatSession } from '../src/ui/use-chat-session'
import { useCommandCompletion } from '../src/ui/composer/use-command-completion'

afterEach(cleanup)
const goal: Goal = {
  goalId: 'goal',
  session: { hostId: 'host', sessionId: 'session' },
  revision: 1,
  objective: '目标',
  status: 'active',
  tokensUsed: 0,
  elapsedMs: 0,
  usageIncomplete: false,
  evidence: [],
  turns: 0,
  createdAt: '2026-10-18',
  updatedAt: '2026-10-18',
}
function fixture(fail = false) {
  const startGoal = vi.fn(async (_key: string, _input: GoalInput) => {
    if (fail) throw new Error('创建失败')
    return { goal, receipt: { operationId: 'operation' } }
  })
  const prompt = vi.fn(async () => {})
  const clearGoal = vi.fn(async () => {})
  const clearQueue = vi.fn(async () => ({ steering: [], followUp: [] }))
  const refresh = vi.fn(async () => {})
  const control = { generation: 1, sessionKey: 'session' }
  const errors: string[] = []
  const result = renderHook(() =>
    useChatSession({
      bridge: {
        startGoal,
        prompt,
        clearGoal,
        clearQueue,
        setSessionMode: async () => {},
        cancelQueueEdit: async () => {},
      } as unknown as ChatBridge,
      commands: builtinCommands,
      refresh,
      canSend: () => true,
      isSwitching: () => false,
      awaitPendingSwitch: async () => {},
      currentGeneration: () => control.generation,
      currentSessionKey: () => control.sessionKey,
      onError: (message) => {
        errors.push(message)
      },
    }),
  ).result
  act(() => {
    result.current.loadSnapshot(
      {
        goalsSupported: true,
        connection: { generation: 1, cwd: '/tmp', sessionKey: 'session', status: 'ready' },
        state: {
          mode: 'default',
          isStreaming: false,
          isCompacting: false,
          steeringMode: 'all',
          followUpMode: 'all',
          pendingMessageCount: 0,
        },
        models: [],
        messages: [],
      } as Snapshot,
      null,
    )
  })
  return { result, startGoal, prompt, errors, clearGoal, clearQueue, refresh, control }
}

test('清除目标期间连接代次递增，成功后仍立即移除当前目标和控制条', async () => {
  const { result, clearGoal, refresh, control } = fixture()
  act(() => {
    result.current.restoreChat({ ...result.current.chat, goal })
    result.current.setGoalOpen(true)
  })
  clearGoal.mockImplementationOnce(async () => {
    control.generation += 1
  })
  await act(async () => result.current.goalAction('clear'))
  assert.equal(result.current.chat.goal, undefined)
  assert.equal(result.current.goalOpen, false)
  assert.equal(refresh.mock.calls.length, 1)
})

test.each(['切换会话', '替换目标'])('清除目标的迟到响应不会影响%s后的目标和队列', async (change) => {
  const { result, clearGoal, clearQueue, refresh, control } = fixture()
  const replacement = { ...goal, goalId: 'replacement' }
  act(() => result.current.restoreChat({ ...result.current.chat, goal }))
  clearGoal.mockImplementationOnce(async () => {
    if (change === '切换会话') control.sessionKey = 'other-session'
    result.current.restoreChat({ ...result.current.chat, goal: replacement })
  })
  await act(async () => result.current.goalAction('clear'))
  assert.equal(result.current.chat.goal, replacement)
  assert.equal(clearQueue.mock.calls.length, 0)
  assert.equal(refresh.mock.calls.length, 0)
})

test('目标已清除后队列恢复失败，仍移除目标控制条', async () => {
  const { result, clearQueue } = fixture()
  act(() => {
    result.current.restoreChat({ ...result.current.chat, goal })
    result.current.setGoalOpen(true)
  })
  clearQueue.mockRejectedValueOnce(new Error('队列恢复失败'))
  await act(async () => assert.rejects(result.current.goalAction('clear'), /队列恢复失败/))
  assert.equal(result.current.chat.goal, undefined)
  assert.equal(result.current.goalOpen, false)
})

test('已有用户消息设为目标保留未发送草稿，提交来源引用', async () => {
  const { result, startGoal } = fixture()
  act(() => result.current.setDraft('尚未发送的补充内容'))
  await act(async () =>
    result.current.setMessageGoal({
      role: 'user',
      content: [{ type: 'text', text: '持续完成这个任务' }],
      timestamp: 10,
    }),
  )
  assert.equal(result.current.draft, '尚未发送的补充内容')
  assert.deepEqual(startGoal.mock.calls[0]?.[1], { objective: '持续完成这个任务', sourceMessageTimestamp: 10 })
})

test('从菜单打开目标设置保留当前正文和图片', () => {
  const { result, startGoal } = fixture()
  const image = { id: 'image', type: 'image' as const, data: 'aW1hZ2U=', mimeType: 'image/png' }
  act(() => {
    result.current.setDraft('已经写好的任务')
    result.current.setAttachments([image])
  })
  act(() => result.current.activateGoal('/goal'))
  assert.equal(result.current.draft, '已经写好的任务')
  assert.equal(result.current.goalOpen, false)
  assert.deepEqual(result.current.attachments, [image])
  assert.ok(result.current.goalDraft)
  assert.equal(startGoal.mock.calls.length, 0)
})

test('英文和中文目标补全只激活输入标记，不插入普通命令或发送消息', () => {
  for (const draft of ['/go', '/目', '/目标模']) {
    const selected: string[] = []
    const changed: string[] = []
    const { result } = renderHook(() =>
      useCommandCompletion({
        draft,
        commands: builtinCommands,
        onGoalCommand: (text) => selected.push(text),
        onDraft: (text) => changed.push(text),
        selectedSkills: [],
        onSkills: () => {},
        focusVersion: 0,
        hasQueue: false,
        onClearQueue: () => {},
      }),
    )
    assert.equal(result.current.matches.length, 1)
    act(() => {
      result.current.completeItem(result.current.matches[0])
    })
    assert.deepEqual(selected, ['/goal '])
    assert.deepEqual(changed, [])
  }
})

test('纯目标命令不创建目标；激活后正文走目标提交', async () => {
  const { result, startGoal, prompt } = fixture()
  act(() => {
    result.current.setDraft('/goal')
  })
  await act(async () => {
    await result.current.send()
  })
  assert.ok(result.current.goalDraft)
  assert.equal(startGoal.mock.calls.length, 0)
  assert.equal(prompt.mock.calls.length, 0)
  act(() => {
    result.current.setDraft('完成目标')
  })
  await act(async () => {
    await result.current.send()
  })
  assert.deepEqual((startGoal.mock.calls as unknown as Array<[string, { objective: string }]>)[0].slice(0, 2), [
    'session',
    { objective: '完成目标', images: [], skills: [] },
  ])
  assert.equal(result.current.goalDraft, undefined)
  assert.equal(prompt.mock.calls.length, 0)
})

test('创建失败保留目标草稿与附件；Plan 取消创建标记', async () => {
  const { result, startGoal, errors } = fixture(true)
  const image = { id: 'image', type: 'image' as const, data: 'aW1hZ2U=', mimeType: 'image/png' }
  act(() => {
    result.current.activateGoal('/goal 完整目标')
    result.current.setAttachments([image])
  })
  await act(async () => {
    await result.current.send()
  })
  assert.equal(startGoal.mock.calls.length, 1)
  assert.ok(errors.some((error) => error.includes('创建失败')))
  assert.equal(result.current.draft, '完整目标')
  assert.deepEqual(result.current.attachments, [image])
  assert.equal(result.current.goalDraft, true)
  act(() => {
    result.current.activatePlan('/plan 检查方案')
  })
  assert.equal(result.current.goalDraft, undefined)
  assert.equal(result.current.mode, 'plan')
})

test('目标创建设置随会话草稿捕获和恢复，普通文本不会自动开启 Goal', async () => {
  const { result, startGoal, prompt } = fixture()
  act(() => {
    result.current.activateGoal('/goal 持久草稿')
  })
  const saved = result.current.captureComposer()
  act(() => {
    result.current.clearComposer()
  })
  assert.equal(result.current.goalDraft, undefined)
  act(() => {
    result.current.restoreComposer(saved)
  })
  assert.equal(result.current.captureComposer().goalDraft, true)
  act(() => {
    result.current.setGoalDraft(undefined)
    result.current.setDraft('普通任务')
  })
  await act(async () => {
    await result.current.send()
  })
  assert.equal(startGoal.mock.calls.length, 0)
  assert.equal(prompt.mock.calls.length, 1)
})
