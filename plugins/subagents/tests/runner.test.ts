import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Agent, AgentEvent, AgentMessage, AgentOptions, AgentTool } from '@earendil-works/pi-agent-core'
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import type { SubagentDefinition } from '../src/server/definition'
import { runSubagent, subagentTools, truncateSubagentReport } from '../src/server/runner'

type Listener = Parameters<Agent['subscribe']>[0]
type PromptAction = (agent: FakeAgent) => Promise<void>

class FakeAgent {
  state = { messages: [] as AgentMessage[], errorMessage: undefined } as Agent['state']
  private listeners = new Set<Listener>()
  private abortPrompt?: () => void

  constructor(private readonly promptAction: PromptAction = async () => {}) {}

  subscribe(listener: Listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async prompt() {
    await this.promptAction(this)
  }

  abort() {
    this.abortPrompt?.()
  }

  holdUntilAborted() {
    return new Promise<void>((resolve) => {
      this.abortPrompt = resolve
    })
  }

  emit(event: AgentEvent) {
    const signal = new AbortController().signal
    for (const listener of this.listeners) void listener(event, signal)
  }
}

function assistantMessage(text: string): AgentMessage {
  return { role: 'assistant', content: [{ type: 'text', text }] } as AgentMessage
}

function makeDefinition(overrides: Partial<SubagentDefinition> = {}): SubagentDefinition {
  return {
    id: 'worker',
    description: 'Test worker',
    prompt: 'Do the assigned task.',
    tools: ['read', 'write'],
    maxTurns: 8,
    path: '/tmp/worker.md',
    ...overrides,
  }
}

function makeTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: 'text', text: name }], details: undefined }),
  }
}

function makeContext(tools: AgentTool[] = [makeTool('read'), makeTool('bash')]) {
  const model = { id: 'parent-model', provider: 'test' }
  const calls: string[] = []
  const context = {
    model,
    thinkingLevel: 'low',
    tools,
    modelRegistry: {
      streamSimple: async () => {
        throw new Error('fake agent must not stream')
      },
    },
    executeTool: async (name: string) => {
      calls.push(name)
      return {
        result: { content: [{ type: 'text', text: name }], details: undefined },
        isError: false,
      }
    },
  } as unknown as ExtensionToolContext
  return { context, model, calls }
}

test('子 Agent 工具取定义与父会话工具交集，执行经父会话 executeTool', async () => {
  const { context, calls } = makeContext()
  const tools = subagentTools(context, makeDefinition())
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['read'],
  )
  await tools[0].execute('child-call', {}, undefined, undefined)
  assert.deepEqual(calls, ['read'])
})

test('Runner 继承父模型并返回报告、轮数与工具调用数', async () => {
  const { context, model } = makeContext()
  const fakeAgent = new FakeAgent(async (agent) => {
    agent.emit({ type: 'turn_start' })
    agent.emit({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'read', args: {} })
    agent.state.messages = [assistantMessage('Found the implementation.')]
  })
  let options: AgentOptions | undefined
  const result = await runSubagent(
    makeDefinition(),
    { agent: 'worker', task: 'Find the implementation.' },
    undefined,
    context,
    {
      createAgent: (next) => {
        options = next
        return fakeAgent
      },
    },
  )
  assert.equal(options?.initialState?.model, model)
  assert.equal(options?.initialState?.thinkingLevel, 'low')
  assert.equal(result.details.status, 'completed')
  assert.equal(result.details.turns, 1)
  assert.equal(result.details.toolCalls, 1)
  assert.equal(result.details.report, 'Found the implementation.')
})

test('Runner 将 prompt 异常作为失败结果返回', async () => {
  const { context } = makeContext()
  const result = await runSubagent(
    makeDefinition(),
    { agent: 'worker', task: 'Run and report errors.' },
    undefined,
    context,
    { createAgent: () => new FakeAgent(async () => Promise.reject(new Error('provider failed'))) },
  )
  assert.equal(result.details.status, 'failed')
  assert.match(result.content[0].text, /provider failed/)
})

test('Runner 在定义轮数上限后终止并标记错误', async () => {
  const { context } = makeContext()
  const result = await runSubagent(
    makeDefinition({ maxTurns: 1 }),
    { agent: 'worker', task: 'Continue until the runner stops.' },
    undefined,
    context,
    {
      createAgent: () =>
        new FakeAgent(async (agent) => {
          const held = agent.holdUntilAborted()
          agent.emit({ type: 'turn_start' })
          agent.emit({ type: 'turn_start' })
          await held
        }),
      idleTimeoutMs: 1000,
      durationTimeoutMs: 2000,
    },
  )
  assert.equal(result.details.status, 'turn-limit')
  assert.equal(result.details.turns, 1)
  assert.equal(result.isError, true)
})

test('Runner 分别执行无活动超时、总时限和父任务取消', async () => {
  const { context } = makeContext()
  const waitForAbort = (event?: () => void) =>
    new FakeAgent(async (agent) => {
      const held = agent.holdUntilAborted()
      agent.emit({ type: 'turn_start' })
      event?.()
      await held
    })

  const idle = await runSubagent(
    makeDefinition(),
    { agent: 'worker', task: 'Wait for idle timeout.' },
    undefined,
    context,
    { createAgent: () => waitForAbort(), idleTimeoutMs: 15, durationTimeoutMs: 500 },
  )
  assert.equal(idle.details.status, 'idle-timeout')

  const duration = await runSubagent(
    makeDefinition(),
    { agent: 'worker', task: 'Wait for duration timeout.' },
    undefined,
    context,
    { createAgent: () => waitForAbort(), idleTimeoutMs: 500, durationTimeoutMs: 15 },
  )
  assert.equal(duration.details.status, 'duration-timeout')

  const controller = new AbortController()
  const agent = waitForAbort(() => setTimeout(() => controller.abort(), 10))
  const aborted = await runSubagent(
    makeDefinition(),
    { agent: 'worker', task: 'Wait for parent cancellation.' },
    controller.signal,
    context,
    { createAgent: () => agent, idleTimeoutMs: 500, durationTimeoutMs: 1000 },
  )
  assert.equal(aborted.details.status, 'aborted')
})

test('子 Agent 报告截断到 12000 字符以内', () => {
  const report = truncateSubagentReport('x'.repeat(12_100))
  assert.equal(report.length <= 12_000, true)
  assert.equal(report.endsWith('[报告已截断]'), true)
})
