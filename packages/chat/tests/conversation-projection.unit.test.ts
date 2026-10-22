import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { AgentMailboxMessage, AgentSummary } from '@pi-meme/contracts/collaboration'
import type { PiMessage } from '@pi-meme/contracts/pi'
import { projectMainConversation } from '../src/ui/model/conversation-projection'
import { groupConversationTurns } from '../src/ui/model/conversation-turns'
import { groupAgentActivities, projectAgentConversation } from '../src/ui/model/agent-collaboration'
import type { ChatState, TurnChunk } from '../src/ui/model/types'
import { applyEvent, emptyChat } from '../src/ui/model/state'
import { assistantMessage, userMessage } from '../../../tests/fixtures/messages.mjs'

const result: AgentMailboxMessage = {
  id: 'mailbox-id',
  fromAgentId: 'agent-private-id',
  toAgentId: 'root-private-id',
  runId: 'run-one',
  rootTaskId: 'root-task',
  epoch: 1,
  kind: 'result',
  name: '审查',
  status: 'completed',
  text: '私有完整子报告',
  completedAt: new Date(2000).toISOString(),
  createdAt: new Date(2100).toISOString(),
}
const report: PiMessage = {
  role: 'custom',
  customType: 'pi-meme-collaboration',
  content: '私有完整子报告',
  display: false,
  details: { ...result, messageId: result.id },
  timestamp: 2200,
}
const control: PiMessage = {
  role: 'custom',
  customType: 'pi-meme-collaboration-control',
  content: '自动协作续跑正文',
  display: false,
  details: { kind: 'continuation' },
  timestamp: 2300,
}

test('主投影按完成阶段插入一次短行，mailbox与原生报告重放不重复且不修改正式消息', () => {
  const state = {
    ...emptyChat,
    messages: [userMessage('开始', 1000), assistantMessage('前阶段', 1500), report, control, userMessage('追问', 3000)],
    agentMessages: [result, { ...result, id: '重复交付-id' }],
  }
  const original = structuredClone(state)
  const view = projectMainConversation(state)
  const turns = groupConversationTurns(view.messages, view.live, view.tools, false, {}, view.agentStatuses)
  assert.deepEqual(
    turns.map((turn) => turn.type),
    ['user', 'assistant_turn', 'agent_status', 'user'],
  )
  assert.deepEqual(
    view.agentStatuses.map(({ agents, status, timestamp }) => ({ name: agents[0].name, status, timestamp })),
    [{ name: '审查', status: '已完成', timestamp: 2000 }],
  )
  assert.doesNotMatch(JSON.stringify(turns), /私有完整子报告|自动协作续跑正文/)
  assert.equal(view.agentStatuses[0].agents[0].agentId, result.fromAgentId)
  assert.deepEqual(state, original)
})

test('各run分别保留真实终态，运行中和普通消息不会被标为完成', () => {
  const view = projectMainConversation({
    ...emptyChat,
    agentMessages: [
      result,
      { ...result, id: 'fail', runId: 'run-two', status: 'failed' },
      { ...result, id: 'abort', runId: 'run-three', status: 'interrupted' },
      { ...result, id: 'running', runId: 'run-four', status: 'running' },
      { ...result, id: 'plain', kind: 'message' },
    ],
  })
  assert.deepEqual(
    view.agentStatuses.map((entry) => entry.status),
    ['已完成', '失败', '已中断'],
  )
})

test('分叉带入的已结束子代理不在主对话再合成一条状态', () => {
  const historical: PiMessage = {
    role: 'custom',
    customType: 'pi-meme-collaboration',
    content: '完成',
    display: false,
    timestamp: 1800,
    details: {
      fromAgentId: 'old-writer',
      kind: 'result',
      messageId: 'result:old',
      name: 'writer',
      status: 'completed',
      startedAt: new Date(1200).toISOString(),
      completedAt: new Date(1700).toISOString(),
      runId: 'run-1',
    },
  }
  const imported: AgentSummary = {
    agentId: 'new-writer',
    rootAgentId: 'root',
    parentAgentId: 'root',
    name: 'writer',
    taskPath: '/root/writer',
    depth: 1,
    rootSessionKey: 'fork',
    sessionKey: 'agent:new-writer',
    rootTaskId: 'task',
    epoch: 1,
    executionGeneration: 1,
    runId: 'run-1',
    importedRunId: 'run-1',
    status: 'completed',
    cwd: '/tmp',
    accessMode: 'workspace-write',
    mode: 'default',
    updatedAt: new Date(1700).toISOString(),
    runStartedAt: new Date(1200).toISOString(),
    runCompletedAt: new Date(1700).toISOString(),
  }
  const view = projectMainConversation({
    ...emptyChat,
    messages: [userMessage('写文章', 1000), historical],
    agents: [imported],
  })
  assert.deepEqual(
    view.agentStatuses.map((entry) => [entry.phase, entry.agents.map((agent) => agent.agentId)]),
    [
      ['started', ['old-writer']],
      ['finished', ['old-writer']],
    ],
  )
})

test('隐藏主协作工具参数与结果，保留普通工具和用户引用文本', () => {
  const quoted = userMessage('子 Agent 返回结果，请检查并继续当前任务：用户自己引用这段文字', 1000)
  const spawn = assistantMessage(
    [
      { type: 'toolCall', id: 'spawn', name: 'spawn_agent', arguments: { message: '私有任务正文' } },
      { type: 'toolCall', id: 'read', name: 'read', arguments: { path: '公开文件' } },
    ],
    1500,
  )
  const state = {
    ...emptyChat,
    messages: [quoted, spawn],
    tools: {
      spawn: { id: 'spawn', name: 'spawn_agent', args: { message: '私有任务正文' }, status: 'success' as const },
      read: { id: 'read', name: 'read', args: { path: '公开文件' }, status: 'success' as const },
    },
  }
  const view = projectMainConversation(state)
  const turns = groupConversationTurns(view.messages, view.live, view.tools, false)
  assert.doesNotMatch(JSON.stringify(turns), /私有任务正文|spawn_agent/)
  assert.match(JSON.stringify(turns), /公开文件|用户自己引用/)
  assert.equal(state.messages[1], spawn)
  assert.ok(state.tools.spawn)
})

test('内部续跑事件不会变成用户轮次，child仍保留完整显示消息且隐藏control', () => {
  let chat = applyEvent(emptyChat, { type: 'message_end', message: userMessage('实际任务', 1000) })
  chat = applyEvent(chat, { type: 'message_end', message: control })
  chat = applyEvent(chat, { type: 'message_end', message: { ...report, display: true } })
  const main = projectMainConversation(chat)
  const mainTurns = groupConversationTurns(main.messages, main.live, main.tools, false, {}, main.agentStatuses)
  assert.deepEqual(
    mainTurns.filter((turn) => turn.type === 'user').map((turn) => turn.message),
    [chat.messages[0]],
  )
  const child = groupConversationTurns(chat.messages, chat.live, chat.tools, false)
  assert.doesNotMatch(JSON.stringify(child), /自动协作续跑正文/)
  assert.match(JSON.stringify(child), /私有完整子报告/)
})

test('隐藏协作toolCall不改变后续流式思考的contentIndex完成状态', () => {
  const chat = {
    ...emptyChat,
    running: true,
    live: assistantMessage([
      { type: 'toolCall', id: 'spawn', name: 'spawn_agent', arguments: { message: '任务正文' } },
      { type: 'thinking', thinking: '后续思考' },
    ]),
    stream: { arguments: {}, completed: { 0: true } },
  }
  const view = projectMainConversation(chat)
  const turns = groupConversationTurns(view.messages, view.live, view.tools, true, chat.stream.completed)
  assert.equal(turns[0].type, 'assistant_turn')
  if (turns[0].type !== 'assistant_turn') return
  assert.equal(turns[0].activities[0].type, 'thinking')
  assert.equal(turns[0].activities[0].status, 'running')
})

const apiAgent: AgentSummary = {
  agentId: 'api-private-id',
  rootAgentId: 'root-private-id',
  parentAgentId: 'root-private-id',
  name: 'api_impl',
  taskPath: '/root/api_impl',
  depth: 1,
  rootSessionKey: 'main',
  sessionKey: 'api-session',
  rootTaskId: 'task',
  epoch: 1,
  executionGeneration: 1,
  runId: 'api-run',
  runStartedAt: new Date(1000).toISOString(),
  cwd: '/tmp/project',
  accessMode: 'workspace-write',
  mode: 'default',
  status: 'running',
  updatedAt: new Date(1000).toISOString(),
}
const uiAgent: AgentSummary = { ...apiAgent, agentId: 'ui-private-id', name: 'ui_impl', taskPath: '/root/ui_impl' }
function collaborationCall(
  id: string,
  name: string,
  args: Extract<Extract<PiMessage, { role: 'assistant' }>['content'][number], { type: 'toolCall' }>['arguments'],
  timestamp = 1100,
) {
  return assistantMessage([{ type: 'toolCall', id, name, arguments: args }], timestamp)
}
function collaborationResult(
  id: string,
  toolName: string,
  details: unknown,
  timestamp = 1200,
  isError = false,
): PiMessage {
  return {
    role: 'toolResult',
    toolCallId: id,
    toolName,
    details: JSON.parse(JSON.stringify(details)),
    content: [{ type: 'text', text: JSON.stringify(details) }],
    timestamp,
    isError,
  }
}
function agentChat(messages: PiMessage[], overrides: Partial<ChatState> = {}): ChatState {
  return { ...emptyChat, running: true, agents: [apiAgent, uiAgent], messages, ...overrides }
}
function assistantTurns(chat: ChatState, agent = apiAgent) {
  return projectAgentConversation(chat, agent).filter(
    (turn): turn is Extract<TurnChunk, { type: 'assistant_turn' }> => turn.type === 'assistant_turn',
  )
}

test('子详情按工具位置保留多轮协作，内部通知不切分计时且投影不修改源数据', () => {
  const chat = agentChat(
    [
      collaborationCall('read', 'read', { path: 'api.ts' }),
      collaborationCall('send', 'send_message', { target: '/root/ui_impl', message: '私有反馈正文' }, 1300),
      collaborationResult('send', 'send_message', { messageId: 'sent-private', delivered: false }, 1400),
      collaborationCall('verify', 'bash', { command: 'tsc --noEmit' }, 1500),
      collaborationCall('wait', 'wait_agent', { targets: ['ui-private-id'] }, 1600),
      { ...report, display: true, timestamp: 1700 },
      collaborationResult(
        'wait',
        'wait_agent',
        { messages: [{ fromAgentId: uiAgent.agentId }], timedOut: false },
        1800,
      ),
      collaborationCall('send-root', 'send_message', { target: 'root-private-id', message: '结果正文' }, 1900),
      collaborationResult('send-root', 'send_message', { delivered: false }, 2000),
      assistantMessage('任务报告', 2100),
    ],
    { running: false },
  )
  const original = structuredClone(chat)
  const turns = assistantTurns(chat, {
    ...apiAgent,
    status: 'completed',
    runCompletedAt: new Date(2200).toISOString(),
    report: '任务报告',
  })
  assert.equal(turns.length, 1)
  assert.deepEqual(
    turns[0].collaboration?.map((item) => item.text),
    ['已向 UI impl 反馈', '已收到 UI impl 的反馈', '已向主代理反馈', '已向主代理反馈'],
  )
  assert.equal(turns[0].hideAgentOperations, true)
  const segments = groupAgentActivities(
    turns[0].activities,
    turns[0].finalText,
    turns[0].collaboration,
    turns[0].hideAgentOperations,
  )
  assert.deepEqual(
    segments.map((segment) => segment.type),
    ['activity', 'collaboration', 'activity', 'collaboration', 'collaboration', 'collaboration', 'text'],
  )
  assert.deepEqual(
    segments.flatMap((segment) =>
      segment.type === 'activity'
        ? segment.items.flatMap((item) => (item.type === 'thinking' || item.type === 'narration' ? [] : [item.name]))
        : [],
    ),
    ['read', 'bash'],
  )
  assert.equal(JSON.stringify(segments).includes('send_message'), false)
  assert.equal(JSON.stringify(segments).includes('wait_agent'), false)
  assert.equal(turns[0].finalText, '任务报告')
  assert.equal(
    turns[0].activities.some(
      (item) => item.type !== 'thinking' && item.type !== 'narration' && item.name === 'send_message',
    ),
    true,
  )
  assert.deepEqual(chat, original)
  assert.doesNotMatch(JSON.stringify(turns[0].collaboration), /私有反馈正文|结果正文|sent-private|\/root\//)
})

test('子代理黑盒去掉嵌套协作工具，普通工具和协作状态留在原来的位置', () => {
  const secret = '不能出现在详情里的反馈正文'
  const segments = groupAgentActivities(
    [
      { id: 'read', name: 'read', args: { path: 'a.ts' }, status: 'success' },
      {
        id: 'code',
        name: 'codemode',
        status: 'success',
        args: { code: 'await tools.send_message()' },
        children: [
          { id: 'nested-send', name: 'send_message', status: 'success', args: { target: 'root', message: secret } },
          {
            id: 'nested-code',
            name: 'bash',
            status: 'success',
            children: [{ id: 'nested-wait', name: 'wait_agent', status: 'success', args: { targets: ['root'] } }],
          },
        ],
      },
      { id: 'list', name: 'list_agents', status: 'success', result: secret },
      { id: 'models', name: 'list_agent_models', status: 'success' },
      { id: 'finish', name: 'finish_agent', status: 'success', args: { report: secret } },
    ],
    '结论',
    [
      { id: 'sent', afterActivityId: 'code', kind: 'feedback', status: 'success', text: '已向主代理反馈' },
      { id: 'done', afterActivityId: 'finish', kind: 'feedback', status: 'success', text: '已向主代理反馈' },
    ],
    true,
  )
  assert.deepEqual(
    segments.map((segment) => segment.type),
    ['activity', 'collaboration', 'collaboration', 'text'],
  )
  const code = segments[0]?.type === 'activity' ? segments[0].items[1] : undefined
  assert.equal(code?.type === 'thinking' || code?.type === 'narration' ? '' : code?.name, 'codemode')
  assert.deepEqual(
    code && code.type !== 'thinking' && code.type !== 'narration'
      ? code.children?.map((child) => child.name)
      : undefined,
    ['bash'],
  )
  assert.equal(
    code && code.type !== 'thinking' && code.type !== 'narration' ? code.children?.[0]?.children : undefined,
    undefined,
  )
  assert.equal(JSON.stringify(segments).includes(secret), false)
  assert.equal(JSON.stringify(segments).includes('list_agents'), false)
  assert.equal(JSON.stringify(segments).includes('finish_agent'), false)
  const untouched = groupAgentActivities(
    [{ id: 'send', name: 'send_message', status: 'success', args: { message: secret } }],
    '',
    [],
    false,
  )
  assert.equal(JSON.stringify(untouched).includes(secret), true)
})

test('等待收到部分反馈只显示实际发送方，超时和对方结束不误报收到反馈', () => {
  const call = collaborationCall('wait', 'wait_agent', { targets: ['/root/ui_impl', 'missing-private-id'] })
  const text = (details: unknown) =>
    assistantTurns(agentChat([call, collaborationResult('wait', 'wait_agent', details)]))[0].collaboration![0].text
  assert.equal(text({ messages: [{ fromAgentId: uiAgent.agentId }], timedOut: false }), '已收到 UI impl 的反馈')
  assert.equal(text({ messages: [], notifiedBy: [uiAgent.agentId], timedOut: false }), '已收到 UI impl 的反馈')
  assert.equal(text({ messages: [], timedOut: true }), '尚未收到 UI impl、其他代理 的反馈')
  assert.equal(
    text({ messages: [], agents: [{ ...uiAgent, status: 'failed' }], timedOut: false }),
    'UI impl 已结束，等待结束',
  )
  assert.equal(text({ messages: [] }), '已结束等待 UI impl、其他代理 的反馈')
})

test('连续超时等待合并并保持原行身份，普通工具、反馈或新的用户轮次会分段', () => {
  const first = [
    collaborationCall('wait-one', 'wait_agent', { targets: ['/root/ui_impl'] }),
    collaborationResult('wait-one', 'wait_agent', { messages: [], timedOut: true }),
  ]
  const next = collaborationCall('wait-two', 'wait_agent', { targets: [uiAgent.agentId] }, 1500)
  const merged = assistantTurns(agentChat([...first, next]))[0].collaboration!
  assert.equal(merged.length, 1)
  assert.equal(merged[0].id, 'wait-one')
  assert.equal(merged[0].afterActivityId, 'wait-two')
  assert.equal(merged[0].text, '正在等待 UI impl 的反馈…')
  for (const barrier of [
    collaborationCall('read', 'read', { path: 'a.ts' }, 1300),
    collaborationCall('send', 'send_message', { target: uiAgent.agentId }, 1300),
    userMessage('继续下一轮', 1300),
  ]) {
    const rows = assistantTurns(agentChat([...first, barrier, next])).flatMap((turn) => turn.collaboration ?? [])
    assert.equal(rows.filter((row) => row.kind === 'wait').length, 2)
  }
  const received = collaborationResult('wait-one', 'wait_agent', { messages: [{ fromAgentId: uiAgent.agentId }] })
  assert.equal(assistantTurns(agentChat([first[0], received, next]))[0].collaboration!.length, 2)
  const unknown = agentChat([
    collaborationCall('unknown-one', 'wait_agent', { targets: ['unknown-one'] }),
    collaborationResult('unknown-one', 'wait_agent', { timedOut: true }),
    collaborationCall('unknown-two', 'wait_agent', { targets: ['unknown-two'] }, 1500),
  ])
  assert.equal(assistantTurns(unknown)[0].collaboration!.length, 2)
})

test('暂停、中断、旧轮次和失去结果的历史等待不会继续动画，未知目标不显示技术标识', () => {
  const chat = agentChat([collaborationCall('wait', 'wait_agent', { targets: ['unknown-private-id'] })])
  const row = (state: ChatState, agent: AgentSummary) => assistantTurns(state, agent)[0].collaboration![0]
  assert.equal(row(chat, apiAgent).status, 'running')
  assert.equal(row(chat, { ...apiAgent, isPaused: true }).text, '已暂停等待其他代理的反馈…')
  assert.equal(row(chat, { ...apiAgent, isPaused: true }).status, 'inactive')
  assert.equal(
    row({ ...chat, running: false }, { ...apiAgent, status: 'interrupted' }).text,
    '等待其他代理的反馈已中断',
  )
  assert.equal(row(chat, { ...apiAgent, runStartedAt: new Date(3000).toISOString() }).status, 'inactive')
  const failed = agentChat([
    collaborationCall('send', 'send_message', { target: '/root/does_not_exist' }),
    collaborationResult('send', 'send_message', {}, 1200, true),
  ])
  assert.equal(assistantTurns(failed)[0].collaboration![0].text, '向其他代理反馈失败')
  assert.equal(assistantTurns(failed)[0].collaboration![0].status, 'error')
})

test('自动回报只匹配已确认完成的当前报告，跟进任务和无完成依据的历史不补造', () => {
  const chat = agentChat(
    [assistantMessage('旧报告', 1500), userMessage('下一轮', 3000), assistantMessage('新报告', 3500)],
    { running: false },
  )
  const completed = {
    ...apiAgent,
    status: 'completed' as const,
    runStartedAt: new Date(3000).toISOString(),
    runCompletedAt: new Date(4000).toISOString(),
    report: '新报告',
  }
  const turns = assistantTurns(chat, completed)
  assert.equal(turns[0].collaboration, undefined)
  assert.equal(turns[1].collaboration![0].text, '已向主代理反馈')
  assert.equal(assistantTurns(chat, { ...completed, report: '不存在的报告' })[1].collaboration, undefined)
  assert.equal(assistantTurns(chat, { ...completed, status: 'running' })[1].collaboration, undefined)
  assert.equal(assistantTurns(chat, { ...completed, runStartedAt: undefined })[1].collaboration, undefined)
  const nested = { ...completed, rootAgentId: 'ancestor-root', parentAgentId: uiAgent.agentId }
  assert.equal(assistantTurns(chat, nested)[1].collaboration![0].text, '已向 UI impl 反馈')
})

test('等待工具没有指定targets时展示已知协作对象，身份来源兼容工具历史', () => {
  const child = { ...uiAgent, taskPath: `${apiAgent.taskPath}/ui_impl`, parentAgentId: apiAgent.agentId }
  const chat = agentChat(
    [collaborationResult('spawn', 'spawn_agent', child), collaborationCall('wait', 'wait_agent', {})],
    { agents: [] },
  )
  const original = structuredClone(chat)
  assert.equal(assistantTurns(chat)[0].collaboration![0].text, '正在等待 UI impl 的反馈…')
  assert.deepEqual(chat, original)
})

test('同级短名与完整路径使用相同名称，祖先显示主代理，完成工具不出现在主聊天', () => {
  const root = { ...apiAgent, agentId: apiAgent.rootAgentId, taskPath: '/root', name: 'root', depth: 0 }
  const chat = agentChat(
    [
      collaborationCall('peer', 'send_message', { target: 'ui_impl', message: '准备联调' }),
      collaborationResult('peer', 'send_message', { delivered: false }),
      collaborationCall('root', 'wait_agent', { targets: ['/root'] }, 1400),
    ],
    { agents: [root, apiAgent, uiAgent] },
  )
  assert.deepEqual(
    assistantTurns(chat)[0].collaboration!.map((row) => row.text),
    ['已向 UI impl 反馈', '正在等待主代理的反馈…'],
  )
  const finish = agentChat([
    collaborationCall('finish', 'finish_agent', { report: '私有完成报告' }),
    collaborationResult('finish', 'finish_agent', { accepted: true }),
  ])
  assert.doesNotMatch(JSON.stringify(projectMainConversation(finish)), /finish_agent|私有完成报告/)
})

test('明确完成结果关联原完成工具，最终回复文案变化也保留常显反馈状态', () => {
  const chat = agentChat(
    [
      collaborationCall('finish', 'finish_agent', { report: '完整验收报告' }, 1500),
      collaborationResult('finish', 'finish_agent', { accepted: true }, 1600),
      assistantMessage('任务已完成。', 1700),
    ],
    { running: false },
  )
  const completed = {
    ...apiAgent,
    status: 'completed' as const,
    runCompletedAt: new Date(1800).toISOString(),
    report: '完整验收报告',
  }
  const row = assistantTurns(chat, completed)[0].collaboration![0]
  assert.equal(row.text, '已向主代理反馈')
  assert.equal(row.afterActivityId, 'finish')
  assert.equal(assistantTurns(chat, { ...completed, status: 'waiting_children' })[0].collaboration, undefined)
})
