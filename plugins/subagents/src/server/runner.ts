import type { Agent, AgentEvent, AgentMessage, AgentOptions, AgentTool } from '@earendil-works/pi-agent-core'
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent'
import type { SubagentDefinition } from './definition'

export const maxSubagentReportCharacters = 12_000
export const defaultSubagentIdleTimeoutMs = 5 * 60 * 1000
export const defaultSubagentDurationTimeoutMs = 10 * 60 * 1000

export type SubagentStatus = 'completed' | 'failed' | 'aborted' | 'turn-limit' | 'idle-timeout' | 'duration-timeout'

export type SubagentTaskParams = { agent: string; task: string; description?: string }
export type SubagentTaskResult = {
  content: [{ type: 'text'; text: string }]
  details: { agent: string; status: SubagentStatus; turns: number; toolCalls: number; report: string }
  isError: boolean
}

export type AgentLike = Pick<Agent, 'subscribe' | 'prompt' | 'abort' | 'state'>
type RunnerOptions = {
  createAgent: (options: AgentOptions) => AgentLike
  idleTimeoutMs?: number
  durationTimeoutMs?: number
}

function finalText(messages: AgentMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'assistant') continue
    const text = message.content
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('\n')
      .trim()
    if (text) return text
  }
  return ''
}

export function truncateSubagentReport(report: string) {
  if (report.length <= maxSubagentReportCharacters) return report
  const marker = '\n\n[报告已截断]'
  return `${report.slice(0, maxSubagentReportCharacters - marker.length)}${marker}`
}

export function subagentTools(context: ExtensionToolContext, definition: SubagentDefinition): AgentTool[] {
  const requested = new Set(definition.tools)
  return context.tools
    .filter((tool) => requested.has(tool.name as SubagentDefinition['tools'][number]))
    .map((tool) => ({
      ...tool,
      execute: async (_toolCallId, params, signal, onUpdate) => {
        const outcome = await context.executeTool(tool.name, params, { signal, onUpdate })
        return { ...outcome.result, isError: outcome.isError }
      },
    }))
}

export async function runSubagent(
  definition: SubagentDefinition,
  params: SubagentTaskParams,
  signal: AbortSignal | undefined,
  context: ExtensionToolContext,
  options: RunnerOptions,
): Promise<SubagentTaskResult> {
  const task = params.task.trim()
  if (!task) throw new Error('子 Agent 任务不能为空')
  if (signal?.aborted)
    return {
      content: [{ type: 'text', text: '子 Agent 任务已取消。' }],
      details: { agent: definition.id, status: 'aborted', turns: 0, toolCalls: 0, report: '' },
      isError: true,
    }
  const model = context.model
  if (!model) throw new Error('当前会话没有可用模型，无法启动子 Agent')

  const tools = subagentTools(context, definition)
  const availableNames = new Set(tools.map((tool) => tool.name))
  const unavailableTools = definition.tools.filter((name) => !availableNames.has(name))
  const systemPrompt = [
    definition.prompt,
    `本任务可用工具：${tools.length ? tools.map((tool) => tool.name).join(', ') : '无'}。`,
    unavailableTools.length ? `当前会话未开放这些定义工具：${unavailableTools.join(', ')}。` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
  const agent = options.createAgent({
    streamFn: (streamModel, transcript, streamOptions) =>
      context.modelRegistry.streamSimple(streamModel, transcript, streamOptions),
    initialState: { systemPrompt, model, thinkingLevel: context.thinkingLevel, tools },
    toolExecution: 'sequential',
  })

  let turns = 0
  let toolCalls = 0
  let termination: Exclude<SubagentStatus, 'completed' | 'failed'> | undefined
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  const terminate = (status: Exclude<SubagentStatus, 'completed' | 'failed'>) => {
    if (termination) return
    termination = status
    agent.abort()
  }
  const idleTimeoutMs = options.idleTimeoutMs ?? defaultSubagentIdleTimeoutMs
  const durationTimeoutMs = options.durationTimeoutMs ?? defaultSubagentDurationTimeoutMs
  const armIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(terminate, idleTimeoutMs, 'idle-timeout')
  }
  const durationTimer = setTimeout(terminate, durationTimeoutMs, 'duration-timeout')
  const unsubscribe = agent.subscribe((event: AgentEvent) => {
    if (!termination) armIdleTimer()
    if (event.type === 'turn_start') {
      turns += 1
      if (turns > definition.maxTurns) terminate('turn-limit')
    }
    if (event.type === 'tool_execution_start') toolCalls += 1
  })
  const abort = () => terminate('aborted')
  signal?.addEventListener('abort', abort, { once: true })
  armIdleTimer()

  try {
    let promptError: string | undefined
    try {
      await agent.prompt(task)
    } catch (cause) {
      promptError = String(cause)
    }
    const report = truncateSubagentReport(finalText(agent.state.messages))
    const errorMessage = agent.state.errorMessage ?? promptError
    const status = termination ?? (errorMessage ? 'failed' : 'completed')
    const notices: Partial<Record<SubagentStatus, string>> = {
      'turn-limit': `子 Agent 达到 ${definition.maxTurns} 轮上限。`,
      'idle-timeout': '子 Agent 因无活动达到 5 分钟上限。',
      'duration-timeout': '子 Agent 达到 10 分钟运行上限。',
      aborted: '子 Agent 任务已取消。',
      failed: `子 Agent 执行失败：${errorMessage ?? '未知错误'}`,
    }
    const text =
      [params.description, notices[status], report].filter(Boolean).join('\n\n') || '子 Agent 未返回文本报告。'
    return {
      content: [{ type: 'text', text }],
      details: { agent: definition.id, status, turns: Math.min(turns, definition.maxTurns), toolCalls, report },
      isError: status !== 'completed',
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
    clearTimeout(durationTimer)
    signal?.removeEventListener('abort', abort)
    unsubscribe()
  }
}
