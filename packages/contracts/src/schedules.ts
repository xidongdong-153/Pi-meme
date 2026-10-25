import type { MutationOptions, ProjectRef, SessionConfiguration, SessionRef } from './app-host'

export type ScheduleRule =
  | { kind: 'once'; at: string; timeZone: string }
  | { kind: 'daily' | 'weekdays' | 'weekly'; time: string; timeZone: string; weekdays?: number[] }
  | { kind: 'interval'; every: number; unit: 'minutes' | 'hours'; anchor: string; timeZone: string }
export type ScheduledTaskRef = { hostId: string; taskId: string }
export type ScheduleConfiguration = SessionConfiguration & {
  model: NonNullable<SessionConfiguration['model']>
  thinkingLevel: NonNullable<SessionConfiguration['thinkingLevel']>
  accessMode: NonNullable<SessionConfiguration['accessMode']>
  agentPlugins: string[]
}
export type ScheduledTaskInput = {
  name: string
  prompt: string
  project?: ProjectRef
  rule: ScheduleRule
  newSessionEachRun: boolean
  configuration: ScheduleConfiguration
  notification: 'all' | 'failures' | 'off'
}
export type ScheduledTask = ScheduledTaskRef &
  ScheduledTaskInput & {
    status: 'active' | 'paused' | 'completed'
    createdAt: string
    updatedAt: string
    nextRunAt?: string
    session?: SessionRef
    error?: string
    unreadCount: number
    lastRun?: ScheduleRun
    activeRun?: ScheduleRun
    latestUnreadRun?: ScheduleRun
  }
export type ScheduleRun = {
  runId: string
  taskId: string
  trigger: 'scheduled' | 'manual'
  scheduledAt: string
  startedAt: string
  finishedAt?: string
  status: 'starting' | 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled' | 'skipped'
  prompt: string
  project?: ProjectRef
  newSessionEachRun: boolean
  configuration: ScheduleConfiguration
  session?: SessionRef
  operationId?: string
  error?: string
  missedCount?: number
  unread: boolean
  needsInput?: boolean
  stopRequested?: boolean
}
export type SchedulesApi = {
  list: () => Promise<ScheduledTask[]>
  get: (ref: ScheduledTaskRef) => Promise<ScheduledTask>
  create: (input: ScheduledTaskInput, options: MutationOptions) => Promise<ScheduledTask>
  update: (ref: ScheduledTaskRef, input: ScheduledTaskInput, options: MutationOptions) => Promise<ScheduledTask>
  pause: (ref: ScheduledTaskRef, options: MutationOptions) => Promise<ScheduledTask>
  resume: (ref: ScheduledTaskRef, options: MutationOptions) => Promise<ScheduledTask>
  delete: (ref: ScheduledTaskRef, options: MutationOptions) => Promise<void>
  runNow: (ref: ScheduledTaskRef, options: MutationOptions) => Promise<ScheduleRun>
  stopRun: (ref: ScheduledTaskRef, options: MutationOptions) => Promise<void>
  runs: (ref: ScheduledTaskRef, input?: { offset?: number; limit?: number }) => Promise<ScheduleRun[]>
  markRead: (ref: ScheduledTaskRef, runId: string, options: MutationOptions) => Promise<void>
  resetSession: (ref: ScheduledTaskRef, options: MutationOptions) => Promise<ScheduledTask>
}
