import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentMailboxMessage } from '@pi-meme/contracts/collaboration'
import type { PiMessage } from '@pi-meme/contracts/pi'
import { projectMainConversation } from '../src/ui/model/conversation-projection'
import { groupConversationTurns } from '../src/ui/model/conversation-turns'
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
    view.agentStatuses.map(({ name, status, timestamp }) => ({ name, status, timestamp })),
    [{ name: '审查', status: '已完成', timestamp: 2000 }],
  )
  assert.doesNotMatch(JSON.stringify(turns), /私有完整子报告|自动协作续跑正文/)
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
