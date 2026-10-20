import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentMailboxMessage, AgentSummary } from '@pi-meme/contracts/collaboration'
import { agentAvatarScenes } from '@pi-meme/contracts/collaboration'
import { AgentAvatar } from '@pi-meme/ui/components/agent-avatar'
import type { PiMessage } from '@pi-meme/contracts/pi'
import type { Snapshot } from '@pi-meme/contracts/desktop'
import { Conversation } from '../src/ui/conversation/conversation'
import { AgentStatusRow } from '../src/ui/conversation/agent-status-row'
import { projectMainConversation } from '../src/ui/model/conversation-projection'
import { groupConversationTurns } from '../src/ui/model/conversation-turns'
import { applyEvent, emptyChat, fromSnapshot } from '../src/ui/model/state'
import { assistantMessage, userMessage } from '../../../tests/fixtures/messages.mjs'

const time = (value: number) => new Date(value).toISOString()
function agent(overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    agentId: 'reviewer',
    rootAgentId: 'root',
    parentAgentId: 'root',
    rootSessionKey: 'main',
    sessionKey: 'child',
    name: 'reviewer',
    taskPath: '/root/reviewer',
    depth: 1,
    rootTaskId: 'task',
    epoch: 1,
    executionGeneration: 1,
    runId: 'run-one',
    status: 'running',
    cwd: '/tmp/project',
    accessMode: 'workspace-write',
    mode: 'default',
    runStartedAt: time(1000),
    updatedAt: time(1000),
    ...overrides,
  }
}
function result(overrides: Partial<AgentMailboxMessage> = {}): AgentMailboxMessage {
  return {
    id: 'result-one',
    fromAgentId: 'reviewer',
    toAgentId: 'root',
    rootTaskId: 'task',
    epoch: 1,
    runId: 'run-one',
    kind: 'result',
    name: 'reviewer',
    status: 'completed',
    startedAt: time(1000),
    completedAt: time(2000),
    createdAt: time(2100),
    text: '完整子报告',
    ...overrides,
  }
}
function toolResult(name: string, details: unknown, timestamp = 1500): PiMessage {
  return {
    role: 'toolResult',
    toolCallId: `${name}-${timestamp}`,
    toolName: name,
    content: [{ type: 'text', text: JSON.stringify(details) }],
    details: details as Extract<PiMessage, { role: 'toolResult' }>['details'],
    isError: false,
    timestamp,
  }
}
function turns(messages: PiMessage[], agentMessages: AgentMailboxMessage[]) {
  const view = projectMainConversation({ ...emptyChat, messages, agentMessages })
  return groupConversationTurns(view.messages, view.live, view.tools, false, {}, view.agentStatuses)
}

test('全部场景头像可显式选择并覆盖名称，未识别职责保留原来的头像', () => {
  for (const avatar of agentAvatarScenes) {
    const markup = renderToStaticMarkup(
      createElement(AgentAvatar, {
        seed: 'existing-unclassified-agent',
        name: 'review',
        avatar,
      }),
    )
    assert.match(markup, new RegExp(`src="[^"]*/agents/${avatar}\\.png"`))
  }
  const legacy = renderToStaticMarkup(
    createElement(AgentAvatar, {
      seed: 'existing-unclassified-agent',
      name: 'unclassified',
    }),
  )
  assert.match(legacy, /data-variant="3"/)
  assert.match(legacy, /src="[^"]*\/agents\/code\.png"/)
  for (const [name, scene] of [
    ['frontend_ui', 'frontend'],
    ['backend_api', 'backend'],
    ['db_migration', 'database'],
    ['ci_pipeline', 'devops'],
    ['security_audit', 'security'],
    ['debug_worker', 'debug'],
    ['performance_bench', 'performance'],
    ['refactor_chat', 'refactor'],
    ['browser_e2e', 'browser'],
    ['data_metrics', 'data'],
    ['product_prd', 'product'],
    ['i18n_copy', 'localization'],
  ]) {
    const markup = renderToStaticMarkup(createElement(AgentAvatar, { seed: 'worker', name }))
    assert.match(markup, new RegExp(`src="[^"]*/agents/${scene}\\.png"`))
  }
})

test('实时状态、工具历史和结果重放都使用调度选择的场景头像', () => {
  const mail = result({ avatar: 'security' })
  const report: PiMessage = {
    role: 'custom',
    customType: 'pi-meme-collaboration',
    display: false,
    content: mail.text,
    details: { ...mail, messageId: mail.id },
    timestamp: 2500,
  }
  for (const chat of [
    { ...emptyChat, agents: [agent({ avatar: 'security' })] },
    { ...emptyChat, messages: [toolResult('spawn_agent', agent({ avatar: 'security' }))] },
    { ...emptyChat, agentMessages: [result({ avatar: 'security' })] },
    { ...emptyChat, messages: [report] },
  ]) {
    const view = projectMainConversation(chat)
    assert.ok(view.agentStatuses.length > 0)
    for (const row of view.agentStatuses) {
      assert.equal(row.agents[0].avatar, 'security')
      const markup = renderToStaticMarkup(createElement(AgentStatusRow, { agents: row.agents, status: row.status }))
      assert.match(markup, /src="[^"]*\/agents\/security\.png"/)
    }
  }
})

test('实时状态立即生成开始和完成提示，不等待父任务读取结果，根代理不生成提示', () => {
  const running = agent()
  const root = agent({ agentId: 'root', parentAgentId: undefined, depth: 0 })
  const first = projectMainConversation({ ...emptyChat, agents: [root, running] })
  assert.deepEqual(
    first.agentStatuses.map((entry) => entry.status),
    ['开始工作'],
  )
  const finished = projectMainConversation({
    ...emptyChat,
    agents: [root, { ...running, status: 'completed', runCompletedAt: time(2000) }],
  })
  assert.deepEqual(
    finished.agentStatuses.map((entry) => entry.status),
    ['开始工作', '已完成'],
  )
})

test('实时状态、邮箱与原生记录重复到达时，每轮开始和完成只显示一次', () => {
  const done = agent({ status: 'completed', runCompletedAt: time(2000) })
  const mail = result()
  const messages: PiMessage[] = [
    toolResult('spawn_agent', agent()),
    {
      role: 'custom',
      customType: 'pi-meme-collaboration',
      display: false,
      content: mail.text,
      details: { ...mail, messageId: mail.id },
      timestamp: 2500,
    },
  ]
  const view = projectMainConversation({ ...emptyChat, agents: [done], agentMessages: [mail, mail], messages })
  assert.deepEqual(
    view.agentStatuses.map((entry) => entry.status),
    ['开始工作', '已完成'],
  )
  assert.deepEqual(
    view.agentStatuses.map((entry) => entry.timestamp),
    [1000, 2000],
  )
  assert.doesNotMatch(JSON.stringify(view.agentStatuses), /完整子报告/)
})

test('续跑保留每轮提示，内部自动继续沿用开始时间且不重复播报开始', () => {
  const view = projectMainConversation({
    ...emptyChat,
    messages: [toolResult('spawn_agent', agent()), toolResult('followup_task', { agent: agent(), queued: true })],
    agents: [agent({ runId: 'automatic-continuation' })],
  })
  assert.deepEqual(
    view.agentStatuses.map((entry) => entry.status),
    ['开始工作'],
  )
  const second = result({ id: 'result-two', runId: 'run-two', startedAt: time(3000), completedAt: time(4000) })
  const history = turns([], [result(), second])
  assert.deepEqual(
    history.map((entry) => entry.type === 'agent_status' && entry.status),
    ['开始工作', '已完成', '开始工作', '已完成'],
  )
})

test('排队、暂停待启动和失败工具调用不提前生成开始提示', () => {
  const pending = agent({ status: 'starting', isPaused: true })
  const failed = { ...toolResult('spawn_agent', agent()), isError: true }
  const view = projectMainConversation({
    ...emptyChat,
    agents: [pending],
    messages: [
      toolResult('spawn_agent', pending),
      toolResult('followup_task', { agent: pending, queued: true }),
      failed,
    ],
  })
  assert.equal(view.agentStatuses.length, 0)
})

test('旧记录只从已保存的成功工具结果恢复开始时间，不从完成时间推算', () => {
  const old = result({ startedAt: undefined })
  const withoutStart = projectMainConversation({ ...emptyChat, agentMessages: [old] })
  assert.deepEqual(
    withoutStart.agentStatuses.map((entry) => entry.status),
    ['已完成'],
  )
  const restored = projectMainConversation({
    ...emptyChat,
    messages: [toolResult('spawn_agent', agent())],
    agentMessages: [old],
  })
  assert.deepEqual(
    restored.agentStatuses.map((entry) => entry.status),
    ['开始工作', '已完成'],
  )
  const invalid = projectMainConversation({
    ...emptyChat,
    agents: [agent({ runStartedAt: 'invalid' })],
    agentMessages: [result({ startedAt: 'invalid', completedAt: 'invalid', createdAt: 'invalid' })],
  })
  assert.equal(invalid.agentStatuses.length, 0)
})

test('连续完成不限制时间间隔，保留首行key和子代理顺序，不修改输入', () => {
  const one = result({ startedAt: undefined })
  const two = result({
    fromAgentId: 'tester',
    name: 'tester',
    runId: 'test-run',
    startedAt: undefined,
    completedAt: time(20000),
  })
  const first = turns([], [one])
  const combined = turns([], [one, two])
  assert.equal(combined.length, 1)
  assert.equal(combined[0].key, first[0].key)
  assert.equal(combined[0].type, 'agent_status')
  if (combined[0].type !== 'agent_status') return
  assert.deepEqual(
    combined[0].agents.map((entry) => entry.agentId),
    ['reviewer', 'tester'],
  )
  assert.equal(one.fromAgentId, 'reviewer')
})

test('正文、工作过程、用户输入、可见自定义消息和压缩记录阻断完成合并', () => {
  const one = result({ startedAt: undefined })
  const two = result({
    fromAgentId: 'tester',
    name: 'tester',
    runId: 'test-run',
    startedAt: undefined,
    completedAt: time(4000),
  })
  const boundaries: PiMessage[] = [
    assistantMessage('期间的正文', 3000),
    assistantMessage([{ type: 'thinking', thinking: '期间的工作过程' }], 3000),
    userMessage('期间的输入', 3000),
    { role: 'custom', customType: 'visible', display: true, content: '期间的提示', timestamp: 3000 },
    { role: 'compactionSummary', summary: '期间的压缩', tokensBefore: 100, timestamp: 3000 },
  ]
  for (const boundary of boundaries) {
    assert.equal(turns([boundary], [one, two]).filter((entry) => entry.type === 'agent_status').length, 2)
  }
})

test('同一时间完成的多个子代理在重放和快照恢复时保持名称顺序与分组key', () => {
  const one = result({ startedAt: undefined })
  const two = result({
    fromAgentId: 'tester',
    name: 'tester',
    runId: 'test-run',
    startedAt: undefined,
  })
  assert.deepEqual(turns([], [one, two]), turns([], [two, one]))
})

test('开始提示和异常终态阻断合并，同一身份不同轮次的完成分别保留', () => {
  const one = result({ startedAt: undefined })
  const two = result({
    id: 'two',
    fromAgentId: 'tester',
    name: 'tester',
    runId: 'test-run',
    startedAt: time(3000),
    completedAt: time(4000),
  })
  assert.equal(turns([], [one, two]).filter((entry) => entry.type === 'agent_status').length, 3)
  for (const status of ['failed', 'interrupted', 'stopped'] as const) {
    const middle = result({
      id: 'middle',
      fromAgentId: 'middle',
      runId: 'middle-run',
      startedAt: undefined,
      status,
      completedAt: time(3000),
    })
    assert.equal(turns([], [one, middle, { ...two, startedAt: undefined }]).length, 3)
  }
  assert.equal(turns([], [one, { ...one, runId: 'another-run', completedAt: time(4000) }]).length, 2)
})

test('快照恢复和事件重放得到相同提示，切换会话不带入上一会话的阶段', () => {
  const snapshot: Snapshot = {
    connection: { cwd: '/tmp/project', generation: 1, status: 'idle', sessionKey: 'main' },
    state: {
      mode: 'default',
      isStreaming: false,
      isCompacting: false,
      steeringMode: 'all',
      followUpMode: 'one-at-a-time',
      pendingMessageCount: 0,
    },
    messages: [],
    models: [],
    agents: [agent({ status: 'completed', runCompletedAt: time(2000) })],
    agentMessages: [result()],
  }
  const restored = fromSnapshot(snapshot)
  const replayed = applyEvent(applyEvent(restored, { type: 'agents_update', agents: snapshot.agents! }), {
    type: 'agent_mailbox',
    message: result(),
  })
  assert.deepEqual(projectMainConversation(replayed).agentStatuses, projectMainConversation(restored).agentStatuses)
  const other = fromSnapshot({ ...snapshot, agents: [], agentMessages: [], messages: [userMessage('另一会话', 5000)] })
  assert.equal(projectMainConversation(other).agentStatuses.length, 0)
})

test('主聊天用并排头像和一句完成文案显示多个子代理，开始保持独立短行', () => {
  const markup = renderToStaticMarkup(
    createElement(Conversation, {
      chat: {
        ...emptyChat,
        agentMessages: [
          result({ name: 'host_bot' }),
          result({ fromAgentId: 'plugins', name: 'current_plugins', runId: 'plugins-run', completedAt: time(2100) }),
          result({
            fromAgentId: 'references',
            name: 'reference_plugins',
            runId: 'reference-run',
            completedAt: time(2200),
          }),
        ],
      },
      canEditMessages: false,
      onEditMessage: () => {},
      onForkReply: () => {},
      onCopyError: () => {},
    }),
  )
  assert.equal((markup.match(/aria-label="子代理状态"/g) ?? []).length, 4)
  assert.equal((markup.match(/data-agent-avatar=""/g) ?? []).length, 6)
  assert.match(markup, /Host bot、Current plugins 和 Reference plugins/)
  assert.equal((markup.match(/已完成/g) ?? []).length, 1)
  assert.equal((markup.match(/开始工作/g) ?? []).length, 3)
  assert.doesNotMatch(markup, /完整子报告|run-one|plugins-run|reference-run|animate-spin/)
})
