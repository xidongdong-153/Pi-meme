import { resolveAgentTarget, type AgentSummary } from '@pi-meme/contracts/collaboration'
import { formatAgentName } from '@pi-meme/ui/lib/agent-name'
import { formatDetailValue } from './tool-details'
import type { ActivityItem } from './types'

export type AgentOperationItem = Exclude<ActivityItem, { type: 'thinking' | 'narration' }> & {
  name: keyof typeof operationLabels
}
export type AgentOperationTarget = Pick<AgentSummary, 'name' | 'avatar'> & { agentId?: string }

const operationLabels = {
  spawn_agent: { action: '创建子代理', running: '正在创建子代理…', complete: '已创建 1 个子代理' },
  send_message: { action: '发送消息', running: '正在向子代理发送消息…', complete: '已向 1 个子代理发送消息' },
  followup_task: { action: '继续子代理任务', running: '正在恢复子代理…', complete: '已恢复 1 个子代理' },
  interrupt_agent: { action: '关闭子代理', running: '正在关闭子代理…', complete: '已关闭 1 个子代理' },
} as const

export function isAgentInteraction(item: ActivityItem): item is AgentOperationItem {
  return item.type !== 'thinking' && item.type !== 'narration' && Object.hasOwn(operationLabels, item.name ?? '')
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

export function agentOperation(
  item: AgentOperationItem,
  agents: readonly AgentSummary[],
  caller: AgentSummary | undefined,
  isLive: boolean,
  isPaused: boolean,
) {
  const labels = operationLabels[item.name as keyof typeof operationLabels]
  const args = object(item.args)
  const result = object(item.result)
  const details = object(result.details ?? item.result)
  const returned = object(item.name === 'spawn_agent' ? details : details.agent)
  const target =
    typeof returned.agentId === 'string'
      ? agents.find((agent) => agent.agentId === returned.agentId)
      : typeof args.target === 'string'
        ? resolveAgentTarget([...agents], caller ?? { taskPath: '/root' }, args.target)
        : undefined
  const identity = target ?? returned
  const isRoot = target && !target.parentAgentId
  const name = isRoot
    ? '主代理'
    : formatAgentName(
        typeof identity.name === 'string'
          ? identity.name
          : typeof args.task_name === 'string'
            ? args.task_name
            : '子代理',
      )
  const recipient: AgentOperationTarget = {
    name,
    ...(target?.parentAgentId ? { agentId: target.agentId, avatar: target.avatar } : {}),
  }
  const hasResult = item.result !== undefined && item.result !== null
  const running = isLive && item.status === 'running'
  const status =
    item.status === 'error'
      ? 'error'
      : running && !isPaused
        ? 'running'
        : running || (!hasResult && item.status !== 'success')
          ? 'inactive'
          : 'success'
  const queued = item.name === 'followup_task' && details.queued === true
  const historyOnly = item.name === 'send_message' && details.deliveryState === 'history_only'
  let summary: string = labels.complete
  if (status === 'running') summary = labels.running
  else if (status === 'error') summary = `${labels.action}失败`
  else if (status === 'inactive') summary = `${labels.action}${running ? '已暂停' : '已中断'}`
  else if (!hasResult)
    summary =
      item.name === 'send_message'
        ? '消息操作已完成'
        : item.name === 'followup_task'
          ? '子代理任务已提交'
          : item.name === 'interrupt_agent'
            ? '关闭操作已完成'
            : labels.complete
  else if (queued) summary = '已排队 1 个子代理任务'
  else if (historyOnly) summary = '已保存发往 1 个子代理的消息'
  else if (isRoot && item.name === 'send_message') summary = '已向主代理发送消息'
  const note =
    status === 'inactive'
      ? running
        ? '操作已暂停'
        : '操作未返回结果'
      : !hasResult
        ? '此历史记录未保存执行详情'
        : queued
          ? '等待当前任务结束后继续'
          : historyOnly
            ? '消息仅保存到历史，未送入当前执行'
            : item.name === 'send_message' && details.delivered === false
              ? '消息已保存，等待接收'
              : undefined
  const message = typeof args.message === 'string' ? args.message : undefined
  return {
    summary,
    status,
    recipient,
    message,
    note,
    error: status === 'error' ? formatDetailValue(item.result) || '操作失败，未返回错误详情' : undefined,
  }
}
