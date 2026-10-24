import type { AgentAccessMode } from './agent-access'
import type { EventCursor, SessionRef } from './app-host'
import type { AgentRunRef } from './collaboration'

export type ServiceActivityStatus = 'starting' | 'running' | 'stopping' | 'stopped' | 'exited' | 'failed'
export type ServiceActivity = SessionRef & {
  serviceId: string
  name: string
  command: string
  cwd: string
  sourceAgentId?: string
  sourceRun?: AgentRunRef
  sourceName: string
  accessMode: AgentAccessMode
  status: ServiceActivityStatus
  startedAt: string
  endedAt?: string
  exitCode?: number
  signal?: string
  stopReason?: string
  lastError?: string
  urls: string[]
  revision: number
}
export type ServiceActivityList = {
  activities: ServiceActivity[]
  revision: number
  cursor?: EventCursor
}
export type ServiceActivityLogs = {
  output: string
  sequence: number
  truncated: boolean
}
export type ServiceActivityRequest =
  | { action: 'start'; name: string; command: string; cwd?: string; requestId: string }
  | { action: 'list' }
  | { action: 'logs'; serviceId: string }
  | { action: 'stop'; serviceId: string }
export type ServiceActivityResult = ServiceActivity | ServiceActivityList | ServiceActivityLogs

export function isLiveServiceActivity(activity: Pick<ServiceActivity, 'status'>) {
  return activity.status === 'starting' || activity.status === 'running' || activity.status === 'stopping'
}
