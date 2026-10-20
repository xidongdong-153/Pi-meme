import path from 'node:path'
import type { ActivityService } from '@pi-meme/activities/server/service'
import type { AgentSummary } from '@pi-meme/contracts/collaboration'
import type { SessionRef } from '@pi-meme/contracts/app-host'
import type { ServiceActivityRequest, ServiceActivityResult } from '@pi-meme/contracts/service-activity'
import type { RuntimeSdkSession } from '@pi-meme/pi-runtime/session-pool'

type Options = {
  activities: Pick<ActivityService, 'start' | 'list' | 'logs' | 'stop' | 'assertIdle'>
  caller: (session: RuntimeSdkSession) => AgentSummary
  sessionForRuntime: (key: string) => Promise<SessionRef>
  assertAvailable: (cwd: string) => void
  agentDir: string
}

/** 服务归属和权限只取真实 Worker；工具不能声明自己的身份。 */
export function createActivityBridge(options: Options) {
  const pendingStarts = new Map<symbol, { cwd: string; rootKey: string; done: Promise<void> }>()
  return {
    async waitForStarts(rootKey: string) {
      await Promise.all(
        [...pendingStarts.values()].filter((entry) => entry.rootKey === rootKey).map((entry) => entry.done),
      )
    },
    assertIdle(cwd?: string) {
      if (
        [...pendingStarts.values()].some((entry) => {
          if (!cwd) return true
          const relative = path.relative(cwd, entry.cwd)
          return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
        })
      )
        throw new Error('项目服务正在启动，请稍后再操作')
      options.activities.assertIdle(cwd)
    },
    async dispatch(
      session: RuntimeSdkSession,
      request: ServiceActivityRequest,
      signal: AbortSignal,
    ): Promise<ServiceActivityResult> {
      if (signal.aborted) throw new Error('活动服务请求已取消')
      const actor = options.caller(session)
      if (actor.mode === 'plan') throw new Error('规划模式不能管理项目服务')
      if (!request || !['start', 'list', 'logs', 'stop'].includes(request.action)) throw new Error('活动服务操作无效')
      const pendingCwd = request.action === 'start' ? path.resolve(actor.cwd, request.cwd ?? '.') : undefined
      const pendingId = Symbol('activity-start')
      let completeStart: (() => void) | undefined
      if (pendingCwd) {
        const done = new Promise<void>((resolve) => {
          completeStart = resolve
        })
        pendingStarts.set(pendingId, { cwd: pendingCwd, rootKey: actor.rootSessionKey, done })
      }
      try {
        const ref = await options.sessionForRuntime(actor.rootSessionKey)
        const current = options.caller(session)
        if (
          signal.aborted ||
          current.mode === 'plan' ||
          current.runId !== actor.runId ||
          current.executionGeneration !== actor.executionGeneration ||
          current.epoch !== actor.epoch
        )
          throw new Error('活动服务请求来自已结束或过期执行')
        options.assertAvailable(current.cwd)
        if (request.action === 'start') {
          options.assertAvailable(pendingCwd!)
          return await options.activities.start(
            {
              session: ref,
              cwd: current.cwd,
              agentDir: options.agentDir,
              accessMode: current.accessMode,
              sourceAgentId: current.depth === 0 ? undefined : current.agentId,
              sourceName: current.depth === 0 ? '主 Agent' : current.name,
            },
            request,
            signal,
          )
        }
        const list = options.activities.list(ref)
        const visible = list.activities.filter(
          (activity) => current.depth === 0 || activity.sourceAgentId === current.agentId,
        )
        if (request.action === 'list') return { ...list, activities: visible }
        if (typeof request.serviceId !== 'string' || !visible.some((item) => item.serviceId === request.serviceId))
          throw new Error('服务不存在或不属于当前 Agent')
        if (request.action === 'logs') {
          const logs = options.activities.logs(ref, request.serviceId)
          const output = Buffer.from(logs.output)
          return output.length > 16 * 1024
            ? { ...logs, output: output.subarray(-16 * 1024).toString('utf8'), truncated: true }
            : logs
        }
        return options.activities.stop(ref, request.serviceId, 'Agent 停止')
      } finally {
        pendingStarts.delete(pendingId)
        completeStart?.()
      }
    },
  }
}
