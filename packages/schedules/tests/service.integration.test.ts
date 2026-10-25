import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import type { AppSession, HostApi, HostControlEvent, SubmissionReceipt } from '@pi-meme/contracts/app-host'
import type { ScheduledTaskInput, ScheduleRun } from '@pi-meme/contracts/schedules'
import { ScheduleService } from '../src/server/service'

const fixtures: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of fixtures.splice(0)) await dispose()
})
const terminal = (runs: ScheduleRun[]) => runs[0] && !['starting', 'running'].includes(runs[0].status)
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-schedules-'))
  let now = Date.parse('2026-10-25T00:00:00Z')
  const sessions = new Map<string, AppSession>()
  const receipts = new Map<string, SubmissionReceipt>()
  let listener: ((event: HostControlEvent) => void) | undefined
  const publish = vi.fn(async () => {})
  const create = vi.fn(async (input: { configuration: AppSession['configuration'] }) => {
    const ref = { hostId: 'host', sessionId: `session-${sessions.size}` }
    const session: AppSession = {
      ...ref,
      configuration: input.configuration,
      cwd: directory,
      status: 'idle',
      createdAt: new Date(now).toISOString(),
    }
    sessions.set(ref.sessionId, session)
    return session
  })
  const submit = vi.fn(async (ref: { sessionId: string }) => {
    const receipt: SubmissionReceipt = {
      operationId: `op-${receipts.size}`,
      submissionId: `sub-${receipts.size}`,
      session: { hostId: 'host', sessionId: ref.sessionId },
      delivery: 'start',
      status: 'running',
    }
    receipts.set(receipt.operationId, receipt)
    return receipt
  })
  const api = {
    projects: { get: vi.fn(async () => ({})) },
    sessions: {
      create,
      submit,
      configure: vi.fn(async () => {}),
      get: vi.fn(async (ref: { sessionId: string }) => {
        const session = sessions.get(ref.sessionId)
        if (!session) throw new Error('会话不存在')
        return session
      }),
      receipt: vi.fn(async (id: string) => receipts.get(id)!),
      stop: vi.fn(async () => {}),
    },
    events: {
      subscribe: async (_filter: unknown, callback: typeof listener) => {
        listener = callback
        return () => {
          listener = undefined
        }
      },
    },
  } as unknown as HostApi
  let service = new ScheduleService({ directory, hostId: 'host', now: () => now })
  await service.init()
  await service.start(api, publish)
  const input: ScheduledTaskInput = {
    name: '每日回顾',
    prompt: '回顾项目',
    rule: { kind: 'interval', every: 1, unit: 'minutes', anchor: new Date(now).toISOString(), timeZone: 'UTC' },
    newSessionEachRun: true,
    configuration: {
      model: { provider: 'fake', id: 'first' },
      thinkingLevel: 'medium',
      accessMode: 'full-access',
      agentPlugins: [],
    },
    notification: 'all',
  }
  fixtures.push(async () => {
    await service.dispose()
    await rm(directory, { recursive: true, force: true })
  })
  return {
    get service() {
      return service
    },
    input,
    sessions,
    create,
    submit,
    api,
    publish,
    advance(ms: number) {
      now += ms
    },
    async settled(task: { hostId: string; taskId: string }, status: SubmissionReceipt['status'] = 'completed') {
      await vi.waitUntil(async () => Boolean((await service.runs(task))[0]?.operationId))
      const run = (await service.runs(task)).find((item) => ['running', 'starting'].includes(item.status))!
      const receipt = receipts.get(run.operationId!)!
      receipt.status = status
      listener?.({ type: 'submission', value: receipt } as HostControlEvent)
      await vi.waitUntil(async () => Boolean(terminal(await service.runs(task))))
    },
    async restart() {
      await service.dispose()
      for (const receipt of receipts.values()) if (receipt.status === 'running') receipt.status = 'interrupted'
      service = new ScheduleService({ directory, hostId: 'host', now: () => now })
      await service.init()
      await service.start(api, publish)
    },
  }
}

test('创建不执行，到期运行，重复触发只提交一次，手动运行不改变周期', async () => {
  const f = await fixture()
  const task = await f.service.create(f.input)
  expect(f.submit).not.toHaveBeenCalled()
  f.advance(60000)
  await f.service.tick()
  await vi.waitUntil(() => f.submit.mock.calls.length === 1)
  await Promise.all([f.service.runNow(task), f.service.runNow(task)])
  expect(f.submit).toHaveBeenCalledTimes(1)
  await f.settled(task)
  const next = (await f.service.get(task)).nextRunAt
  await f.service.runNow(task)
  await f.settled(task)
  expect((await f.service.get(task)).nextRunAt).toBe(next)
  expect(f.create).toHaveBeenCalledTimes(2)
  const source = {
    taskId: task.taskId,
    name: task.name,
    status: 'active',
    nextRunAt: next,
    timeZone: f.input.rule.timeZone,
  }
  expect(await f.service.sessionTasks()).toEqual(
    new Map([
      ['session-0', source],
      ['session-1', source],
    ]),
  )
})
test('持续会话复用聊天，聊天占用跳过，删除聊天后暂停并允许重建', async () => {
  const f = await fixture()
  const task = await f.service.create({ ...f.input, newSessionEachRun: false })
  await f.service.runNow(task)
  await f.settled(task)
  await f.service.runNow(task)
  await f.settled(task)
  expect(f.create).toHaveBeenCalledTimes(1)
  const session = [...f.sessions.values()][0]
  session.status = 'running'
  await f.service.runNow(task)
  await vi.waitUntil(async () => (await f.service.runs(task))[0]?.status === 'skipped')
  expect(f.submit).toHaveBeenCalledTimes(2)
  f.sessions.clear()
  await f.service.runNow(task)
  await vi.waitUntil(async () => (await f.service.get(task)).status === 'paused')
  expect((await f.service.get(task)).error).toContain('已删除')
  await f.service.resetSession(task)
  await f.service.resume(task)
  expect((await f.service.get(task)).status).toBe('active')
})
test('离线错过合并记录，暂停不补跑，重启不会再次提交', async () => {
  const f = await fixture()
  const task = await f.service.create(f.input)
  f.advance(600000)
  await f.restart()
  const skipped = (await f.service.runs(task))[0]
  expect(skipped.status).toBe('skipped')
  expect(skipped.missedCount).toBe(10)
  expect(f.submit).not.toHaveBeenCalled()
  await f.service.pause(task)
  f.advance(600000)
  await f.service.tick()
  expect(await f.service.runs(task)).toHaveLength(1)
  await f.service.resume(task)
  expect((await f.service.get(task)).nextRunAt).toBe('2026-10-25T00:21:00.000Z')
  await f.service.runNow(task)
  await vi.waitUntil(() => f.submit.mock.calls.length === 1)
  await f.restart()
  expect((await f.service.runs(task))[0].status).toBe('interrupted')
  expect(f.submit).toHaveBeenCalledTimes(1)
})
test('执行中到期跳过不丢失运行状态，停止后可以删除且保留聊天', async () => {
  const f = await fixture()
  const task = await f.service.create(f.input)
  await f.service.runNow(task)
  await vi.waitUntil(() => f.submit.mock.calls.length === 1)
  f.advance(60000)
  await f.service.tick()
  expect((await f.service.get(task)).lastRun?.status).toBe('skipped')
  expect((await f.service.get(task)).activeRun?.status).toBe('running')
  await expect(f.service.delete(task)).rejects.toThrow('先停止')
  await f.service.stopRun(task)
  expect(f.api.sessions.stop).toHaveBeenCalledTimes(1)
  await f.service.delete(task)
  expect(await f.service.list()).toEqual([])
  expect(f.sessions.size).toBe(1)
})
test('未读持久化且标记已读只作用于指定运行，通知关闭不产生未读', async () => {
  const f = await fixture()
  const task = await f.service.create(f.input)
  await f.service.runNow(task)
  await f.settled(task)
  const first = (await f.service.runs(task))[0]
  await f.service.runNow(task)
  await f.settled(task)
  await f.service.markRead(task, first.runId)
  await f.restart()
  expect((await f.service.get(task)).unreadCount).toBe(1)
  await f.service.update(task, { ...f.input, notification: 'off' })
  await f.service.runNow(task)
  await f.settled(task, 'failed')
  expect((await f.service.runs(task))[0].unread).toBe(false)
})
test('拒绝跨 Host 和更换执行项目，过期单次任务结束后仍可手动运行', async () => {
  const f = await fixture()
  const task = await f.service.create({
    ...f.input,
    rule: { kind: 'once', at: '2026-10-25T00:01:00Z', timeZone: 'UTC' },
  })
  await expect(f.service.get({ ...task, hostId: 'other' })).rejects.toThrow('身份不匹配')
  await expect(f.service.update(task, { ...f.input, project: { hostId: 'host', projectId: 'other' } })).rejects.toThrow(
    '不能更改',
  )
  f.advance(120000)
  await f.service.tick()
  expect((await f.service.get(task)).status).toBe('completed')
  await f.service.runNow(task)
  await f.settled(task)
  expect(f.submit).toHaveBeenCalledTimes(1)
})

test('停止失败时保留活跃状态，允许用户重试且不并发提交', async () => {
  const f = await fixture()
  const task = await f.service.create(f.input)
  await f.service.runNow(task)
  await vi.waitUntil(async () => Boolean((await f.service.get(task)).activeRun?.operationId))
  vi.mocked(f.api.sessions.stop).mockRejectedValueOnce(new Error('停止暂时失败'))
  await expect(f.service.stopRun(task)).rejects.toThrow('停止暂时失败')
  expect((await f.service.get(task)).activeRun).toBeTruthy()
  await f.service.runNow(task)
  expect(f.submit).toHaveBeenCalledTimes(1)
  await f.service.stopRun(task)
  expect((await f.service.get(task)).activeRun).toBeUndefined()
  expect((await f.service.runs(task))[0].status).toBe('cancelled')
})

test('单次任务运行结束后归入已结束，仅失败通知不会提示成功结果', async () => {
  const f = await fixture()
  const task = await f.service.create({
    ...f.input,
    notification: 'failures',
    rule: { kind: 'once', at: '2026-10-25T00:01:00Z', timeZone: 'UTC' },
  })
  f.advance(60000)
  await f.service.tick()
  await vi.waitUntil(() => f.submit.mock.calls.length === 1)
  expect((await f.service.get(task)).status).toBe('active')
  await f.settled(task)
  expect((await f.service.get(task)).status).toBe('completed')
  expect((await f.service.get(task)).unreadCount).toBe(0)
})
