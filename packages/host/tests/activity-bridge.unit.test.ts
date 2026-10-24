import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { AgentSummary } from '@pi-meme/contracts/collaboration'
import type { ServiceActivity } from '@pi-meme/contracts/service-activity'
import type { RuntimeSdkSession } from '@pi-meme/pi-runtime/session-pool'
import { createActivityBridge } from '../src/activity-bridge'
import { createWorkspaceHandlers, type WorkspaceHandlerContext } from '@pi-meme/workspace/server/handlers'

const ref = { hostId: 'host', sessionId: 'root-session' }
const session = {} as RuntimeSdkSession
function fixture() {
  let actor = {
    agentId: 'child',
    rootAgentId: 'root',
    rootSessionKey: 'runtime-root',
    rootTaskId: 'root-task',
    sessionKey: 'runtime-child',
    name: 'backend',
    cwd: '/project',
    depth: 1,
    mode: 'default',
    accessMode: 'workspace-write',
    status: 'running',
    runId: 'run',
    executionGeneration: 1,
    epoch: 1,
  } as AgentSummary
  const activities = [
    { ...ref, serviceId: 'own', sourceAgentId: 'child' },
    { ...ref, serviceId: 'other', sourceAgentId: 'sibling' },
  ] as ServiceActivity[]
  const calls: unknown[][] = []
  const bridge = createActivityBridge({
    activities: {
      list: (target) => {
        calls.push(['list', target])
        return { activities, revision: 2 }
      },
      logs: (target, id) => {
        calls.push(['logs', target, id])
        return { output: 'tail', sequence: 1, truncated: false }
      },
      stop: async (target, id, reason) => {
        calls.push(['stop', target, id, reason])
        return activities.find((a) => a.serviceId === id)!
      },
      start: async (caller, input) => {
        calls.push(['start', caller, input])
        return activities[0]
      },
      assertIdle: () => {},
    },
    caller: () => actor,
    sessionForRuntime: async (key) => {
      calls.push(['resolve', key])
      return ref
    },
    assertAvailable: () => {},
    agentDir: '/host/pi',
  })
  return {
    bridge,
    calls,
    setActor: (next: Partial<AgentSummary>) => {
      actor = { ...actor, ...next }
    },
  }
}

test('子 Agent 只能列出和操作自己的服务，根 Agent 可管理全部', async () => {
  const f = fixture()
  const signal = new AbortController().signal
  const list = await f.bridge.dispatch(session, { action: 'list' }, signal)
  assert.ok('activities' in list)
  assert.deepEqual(
    list.activities.map((a) => a.serviceId),
    ['own'],
  )
  await assert.rejects(f.bridge.dispatch(session, { action: 'stop', serviceId: 'other' }, signal), /不属于当前 Agent/)
  assert.equal(f.calls.filter(([method]) => method === 'stop').length, 0)
  await f.bridge.dispatch(session, { action: 'logs', serviceId: 'own' }, signal)
  f.setActor({ depth: 0, agentId: 'root' })
  await f.bridge.dispatch(session, { action: 'stop', serviceId: 'other' }, signal)
  assert.deepEqual(f.calls.at(-1), ['stop', ref, 'other', 'Agent 停止'])
})

test('服务启动归属、工作目录、权限取可信调用者，plan 与取消拒绝执行', async () => {
  const f = fixture()
  const signal = new AbortController().signal
  await f.bridge.dispatch(
    session,
    { action: 'start', name: 'Web', command: 'pnpm start:web', requestId: 'tool-1' },
    signal,
  )
  const call = f.calls.find(([method]) => method === 'start')!
  assert.deepEqual(call[1], {
    session: ref,
    cwd: '/project',
    agentDir: '/host/pi',
    accessMode: 'workspace-write',
    sourceAgentId: 'child',
    sourceRun: { agentId: 'child', rootTaskId: 'root-task', epoch: 1, runId: 'run' },
    sourceName: 'backend',
  })
  f.setActor({ mode: 'plan' })
  await assert.rejects(f.bridge.dispatch(session, { action: 'list' }, signal), /规划模式/)
  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(f.bridge.dispatch(session, { action: 'list' }, cancelled.signal), /已取消/)
})

test('等待正式会话绑定期间执行代次变化会拒绝，不泄漏启动门闩', async () => {
  const f = fixture()
  const starting = f.bridge.dispatch(
    session,
    { action: 'start', name: 'Web', command: 'serve', requestId: 'late' },
    new AbortController().signal,
  )
  assert.throws(() => f.bridge.assertIdle('/project'), /正在启动/)
  f.setActor({ executionGeneration: 2 })
  await assert.rejects(starting, /过期执行/)
  assert.equal(
    f.calls.some(([method]) => method === 'start'),
    false,
  )
  f.bridge.assertIdle('/project')
})

test('删除前服务停止失败会中止会话文件删除', async () => {
  let removed = false
  let checked = false
  const context = {
    pi: {},
    mutations: {
      deleteSessions: async (_paths: string[], _cwd: string | undefined, remove: () => Promise<unknown>) => {
        await remove()
        removed = true
      },
    },
    sessions: { getSessionsDirectory: async () => '/sessions' },
    getPinnedPaths: () => [],
    getRuntimeSessions: () => [{ id: 'runtime:target', path: 'runtime:target' }],
    beforeDelete: async (paths: string[]) => {
      assert.deepEqual(paths, ['runtime:target'])
      checked = true
      throw new Error('服务退出失败')
    },
  } as unknown as WorkspaceHandlerContext
  const handlers = createWorkspaceHandlers(context)
  await assert.rejects(handlers['session:delete']('runtime:target'), /服务退出失败/)
  assert.equal(checked, true)
  assert.equal(removed, false)
})
