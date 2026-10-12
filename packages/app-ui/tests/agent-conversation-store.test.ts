import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentSummary } from '@pi-meme/contracts/collaboration'
import type { DesktopEvent, Snapshot } from '@pi-meme/contracts/desktop'
import { groupConversationTurns } from '@pi-meme/chat/ui/model/conversation-turns'
import { assistantMessage } from '../../../tests/fixtures/messages.mjs'
import { AgentConversationStore } from '../src/agent-conversation-store'

const agent: AgentSummary = {
  agentId: 'child',
  rootAgentId: 'root',
  parentAgentId: 'root',
  rootSessionKey: 'main',
  sessionKey: 'child-session',
  name: '检查',
  taskPath: '/root/check',
  depth: 1,
  rootTaskId: 'task',
  epoch: 1,
  executionGeneration: 1,
  status: 'running',
  cwd: '/tmp/project',
  accessMode: 'workspace-write',
  mode: 'default',
  updatedAt: '2026-10-10T00:00:00Z',
}
const message = (text: string, timestamp: number) => ({ role: 'user' as const, content: text, timestamp })
function snapshot(sequence: number, text: string, generation = 1): Snapshot {
  return {
    agent: { ...agent, executionGeneration: generation },
    connection: { generation: 1, sessionKey: agent.sessionKey, cwd: agent.cwd, status: 'ready' },
    state: {
      mode: 'default',
      isStreaming: true,
      isCompacting: false,
      steeringMode: 'one-at-a-time',
      followUpMode: 'all',
      pendingMessageCount: 0,
    },
    messages: [message(text, sequence)],
    models: [],
    eventSequence: sequence,
  }
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5))

test('子流缺口读取独立快照，重放其后的buffer，不切主会话或修改草稿', async () => {
  let emit: (event: DesktopEvent) => void = () => {}
  let resolveRead: (snapshot: Snapshot) => void = () => {}
  let reads = 0
  const store = new AgentConversationStore(
    {
      getAgentSnapshot: async (id) => {
        assert.equal(id, 'child')
        reads++
        if (reads === 1) return snapshot(1, '初始')
        return new Promise((resolve) => {
          resolveRead = resolve
        })
      },
      onEvent: (callback) => {
        emit = callback
        return () => {}
      },
      onConnection: () => () => {},
    },
    'child',
  )
  await store.start()
  const event = (sequence: number, text: string, generation = 1): DesktopEvent => ({
    generation: 1,
    agentId: 'child',
    sessionKey: agent.sessionKey,
    executionGeneration: generation,
    sequence,
    event: { type: 'message_end', message: message(text, sequence) },
  })
  emit(event(4, '缺口事件'))
  emit(event(5, '读取期间事件'))
  resolveRead(snapshot(4, '包含缺口的快照'))
  await tick()
  assert.deepEqual(
    store.getSnapshot().chat.messages.map((entry) => ('content' in entry ? entry.content : undefined)),
    ['包含缺口的快照', '读取期间事件'],
  )
  emit(event(6, '旧执行事件', 0))
  assert.equal(store.getSnapshot().chat.messages.length, 2)
  emit({
    generation: 1,
    sessionKey: 'main',
    event: { type: 'agents_update', agents: [{ ...agent, status: 'completed', report: '完成' }] },
  })
  assert.equal(store.getSnapshot().agent?.status, 'completed')
  store.close()
})
test('连接恢复刷新子快照，关闭后的迟到响应不重新发布', async () => {
  let connection: (value: Snapshot['connection']) => void = () => {}
  let reads = 0
  const store = new AgentConversationStore(
    {
      getAgentSnapshot: async () => snapshot(++reads, `快照${reads}`),
      onEvent: () => () => {},
      onConnection: (callback) => {
        connection = callback
        return () => {}
      },
    },
    'child',
  )
  await store.start()
  connection(snapshot(1, '').connection)
  await tick()
  assert.equal(
    store.getSnapshot().chat.messages.map((entry) => ('content' in entry ? entry.content : undefined))[0],
    '快照2',
  )
  store.close()
})

test('协作消息快照与实时事件按消息 ID 去重，时间戳不同仍只显示一次', async () => {
  let reads = 0
  let resolveRead: (snapshot: Snapshot) => void = () => {}
  const collaborationMessage = (id: string, timestamp: number): Snapshot['messages'][number] => ({
    role: 'custom',
    customType: 'pi-meme-collaboration',
    content: '[来自 root] 检查任务进度',
    display: true,
    details: { messageId: id, kind: 'message' },
    timestamp,
  })
  const initial = { ...snapshot(1, ''), messages: [] }
  const store = new AgentConversationStore(
    {
      getAgentSnapshot: async () => {
        if (++reads === 1) return initial
        return new Promise((resolve) => {
          resolveRead = resolve
        })
      },
      onEvent: () => () => {},
      onConnection: () => () => {},
    },
    'child',
  )
  await store.start()
  const refreshing = store.refresh()
  const event = (sequence: number, id: string, timestamp: number): DesktopEvent => ({
    generation: 1,
    sessionKey: agent.sessionKey,
    agentId: agent.agentId,
    executionGeneration: 1,
    sequence,
    event: { type: 'message_end', message: collaborationMessage(id, timestamp) },
  })
  store.receive(event(2, 'mailbox-1', 1000))
  resolveRead({ ...initial, messages: [collaborationMessage('mailbox-1', 2000)] })
  await refreshing
  assert.equal(store.getSnapshot().chat.messages.length, 1)
  store.receive(event(3, 'mailbox-2', 1000))
  assert.equal(store.getSnapshot().chat.messages.length, 2)
  store.close()
})

test('新执行代次恢复后忽略旧代次的高序号事件', async () => {
  let emit: (event: DesktopEvent) => void = () => {}
  let reads = 0
  const store = new AgentConversationStore(
    {
      getAgentSnapshot: async () => (++reads === 1 ? snapshot(8, '旧执行') : snapshot(2, '新执行', 2)),
      onEvent: (callback) => {
        emit = callback
        return () => {}
      },
      onConnection: () => () => {},
    },
    'child',
  )
  await store.start()
  const event = (sequence: number, generation: number, text: string): DesktopEvent => ({
    generation: 1,
    sessionKey: agent.sessionKey,
    agentId: agent.agentId,
    executionGeneration: generation,
    sequence,
    event: { type: 'message_end', message: message(text, sequence) },
  })
  emit(event(2, 2, '新执行触发恢复'))
  await tick()
  emit(event(99, 1, '旧执行迟到'))
  emit(event(3, 2, '新执行后续'))
  assert.equal(reads, 2)
  assert.equal(store.getSnapshot().agent?.executionGeneration, 2)
  assert.deepEqual(
    store.getSnapshot().chat.messages.map((entry) => ('content' in entry ? entry.content : undefined)),
    ['新执行', '新执行后续'],
  )
  store.close()
})

test('独立详情原样使用Host已裁继承前缀的快照，自身提示与followup完整，不触碰父输入目标', async () => {
  const parentPrompt = message('父用户创建3个代理并完成整个任务', 1)
  const ownPrompt = message('审查当前模块', 2)
  const ownFollowup = message('继续检查类型，并引用父用户创建3个代理并完成整个任务', 4)
  const ownDetail = assistantMessage('自身完整审查细节与工具结论', 5)
  const childSnapshot = {
    ...snapshot(5, ''),
    messages: [ownPrompt, assistantMessage('第一轮完整结论', 3), ownFollowup, ownDetail],
  }
  const parent = {
    sessionKey: 'main',
    draft: '保留父草稿',
    editing: { timestamp: parentPrompt.timestamp, draft: '保留父编辑内容' },
  }
  const before = structuredClone(parent)
  const calls: string[] = []
  const bridge = {
    getAgentSnapshot: async (id: string) => {
      calls.push(`agent:${id}`)
      return childSnapshot
    },
    getSnapshot: async () => {
      throw new Error('子详情不应请求父快照')
    },
    getConnection: async () => {
      throw new Error('子详情不应改变父选择')
    },
    prompt: async () => {
      throw new Error('只读详情不应发送消息')
    },
    onEvent: () => () => {},
    onConnection: () => () => {},
  }
  const store = new AgentConversationStore(bridge, 'child')
  await store.start()
  const chat = store.getSnapshot().chat
  assert.deepEqual(chat.messages, childSnapshot.messages)
  assert.ok(!chat.messages.some((entry) => entry.timestamp === parentPrompt.timestamp))
  const turns = groupConversationTurns(chat.messages, chat.live, chat.tools, false)
  assert.deepEqual(
    turns.filter((turn) => turn.type === 'user').map((turn) => turn.message),
    [ownPrompt, ownFollowup],
  )
  assert.match(JSON.stringify(turns), /第一轮完整结论|自身完整审查细节与工具结论/)
  assert.deepEqual(parent, before)
  assert.deepEqual(calls, ['agent:child'])
  store.close()
})

test('子代理独立快照恢复暂停计时，恢复事件继续使用同一运行时段', async () => {
  const pausedSnapshot = snapshot(1, '暂停任务')
  pausedSnapshot.state = {
    ...pausedSnapshot.state,
    isPaused: true,
    pauseRevision: 1,
    pauseIntervals: [{ startedAt: 4000 }],
    runIntervals: [{ startedAt: 1000 }],
  }
  const store = new AgentConversationStore(
    { getAgentSnapshot: async () => pausedSnapshot, onEvent: () => () => {}, onConnection: () => () => {} },
    'child',
  )
  await store.start()
  assert.equal(store.getSnapshot().chat.paused, true)
  assert.deepEqual(store.getSnapshot().chat.pauseIntervals, [{ startedAt: 4000 }])
  store.receive({
    generation: 1,
    sessionKey: agent.sessionKey,
    agentId: agent.agentId,
    executionGeneration: 1,
    sequence: 2,
    event: {
      type: 'pause_update',
      revision: 2,
      isPaused: false,
      queuePaused: false,
      pauseIntervals: [{ startedAt: 4000, endedAt: 9000 }],
    },
  })
  assert.equal(store.getSnapshot().chat.paused, false)
  assert.deepEqual(store.getSnapshot().chat.pauseIntervals, [{ startedAt: 4000, endedAt: 9000 }])
  assert.deepEqual(store.getSnapshot().chat.runIntervals, [{ startedAt: 1000 }])
  store.close()
})
