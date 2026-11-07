import { createHash } from 'node:crypto'
import type { AppSession, SessionRef } from '@pi-meme/contracts/app-host'
import type { AuthorizationContext } from '@pi-meme/contracts/authorization'
import type { ScheduleRun } from '@pi-meme/contracts/schedules'
import type { ScheduleService } from '@pi-meme/schedules/server/service'
import type { HostAuthorization } from './authorization'

export function scheduleAuthorization(options: {
  hostId: string
  authorization: HostAuthorization
  schedules: ScheduleService
  readSession: (ref: SessionRef) => AppSession
}): Parameters<ScheduleService['setAuthorizationHooks']>[0] {
  const { hostId, authorization, schedules } = options
  return {
    admit: async ({ task, run, session: target, signal, taskRevision }) => {
      const principalId = `service:schedule:${run.runId}`
      const current = (): AuthorizationContext => {
        const live = target ? options.readSession({ hostId, sessionId: target.sessionId }) : undefined
        const accessMode = live?.configuration.accessMode ?? task.configuration.accessMode
        const taskMode = task.configuration.mode === 'plan' || live?.configuration.mode === 'plan' ? 'plan' : 'default'
        const policyRevision = createHash('sha256')
          .update(
            JSON.stringify([
              taskRevision,
              accessMode,
              taskMode,
              live?.configuration.agentPlugins ?? task.configuration.agentPlugins,
            ]),
          )
          .digest('hex')
        return {
          principal: { id: principalId, kind: 'service' },
          scope: { hostId, projectId: (live?.project ?? task.project)?.projectId, sessionId: live?.sessionId },
          taskMode,
          accessMode,
          policyRevision,
          capabilities: [],
        }
      }
      const context = current()
      const release = authorization.register(principalId, current)
      let started: Awaited<ReturnType<typeof authorization.authority.start>>
      try {
        signal.throwIfAborted()
        schedules.assertRunAuthorization(run.runId, taskRevision)
        started = await authorization.authority.start({
          context,
          operation: {
            id: 'schedule.admit',
            summary: task.name,
            effects: [{ kind: 'process.read', resource: `schedule:${task.taskId}:${run.runId}`, boundary: 'host' }],
          },
          input: { taskId: task.taskId, runId: run.runId, taskRevision },
          idempotencyKey: `schedule:${run.runId}:admit`,
        })
      } catch (cause) {
        await release()
        throw cause
      }
      const cancel = () => {
        void authorization.authority.cancel(started.lease.id).catch(() => {})
      }
      signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted) cancel()
      return {
        revision: started.lease.id,
        signal: started.signal,
        assertCurrent: () => {
          signal.throwIfAborted()
          started.signal.throwIfAborted()
          schedules.assertRunAuthorization(run.runId, taskRevision)
          if (current().policyRevision !== context.policyRevision)
            throw new Error('policy-revoked: 定时任务的当前会话权限已变化')
          const lease = authorization.authority.snapshot().leases.find((item) => item.id === started.lease.id)
          if (lease?.status !== 'running') throw new Error('policy-revoked: 定时任务准入租约已失效')
        },
        complete: async (status: ScheduleRun['status'], error?: string) => {
          signal.removeEventListener('abort', cancel)
          try {
            await authorization.authority.complete(started.lease.id, {
              status: status === 'completed' ? 'succeeded' : 'outcome-unknown',
              reason: error,
            })
          } finally {
            await release()
          }
        },
      }
    },
    assertMutationCurrent: ({ method, authorizationRevision }) => {
      if (method === 'sessions.stop') return
      authorization.currentSignal()?.throwIfAborted()
      const lease = authorization.authority.snapshot().leases.find((item) => item.id === authorizationRevision)
      if (lease?.status !== 'running') throw new Error('policy-revoked: 定时提交已失去当前准入租约')
    },
  }
}
