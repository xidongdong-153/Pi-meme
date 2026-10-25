import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test, vi } from 'vitest'
import type { ScheduledTaskInput } from '@pi-meme/contracts/schedules'
import type { PiSessionsSnapshot } from '@pi-meme/contracts/sessions'
import { createHost } from '../src/service'
import { useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'

const key = (idempotencyKey: string) => ({ idempotencyKey })
test('HostApi 持久保存安排、幂等执行并推送结果，执行不改变当前聊天', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'pi-schedule-control-')))
  const fake = await useFakeAgent(root, { reply: '定时任务已完成' })
  let host = await createHost({ dataRoot: fake.dataRoot, credentials: fake.credentials })
  const sessionSnapshot = async () => {
    const response = await host.rpc({
      requestId: crypto.randomUUID(),
      clientId: 'schedule-sidebar',
      method: 'pi:sessions',
      args: [],
    })
    expect(response.error).toBeUndefined()
    return response.result as PiSessionsSnapshot
  }
  try {
    const cwd = path.join(root, 'project')
    await mkdir(cwd)
    const project = await host.app.projects.register({ cwd }, key('project'))
    const input: ScheduledTaskInput = {
      name: '项目回顾',
      prompt: '总结当前项目',
      project,
      rule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' },
      newSessionEachRun: false,
      configuration: {
        model: { provider: 'fake', id: 'first' },
        thinkingLevel: 'medium',
        accessMode: 'full-access',
        agentPlugins: [],
        mode: 'default',
      },
      notification: 'all',
    }
    const selected = host.pi.cwd
    const events: string[] = []
    let off = await host.app.events.subscribe({}, (event) => {
      if (event.type === 'schedule') events.push(event.type)
    })
    expect((await host.app.capabilities()).features).toContain('schedules')
    const [left, right] = await Promise.all([
      host.app.schedules.create(input, key('task')),
      host.app.schedules.create(input, key('task')),
    ])
    expect(left.taskId).toBe(right.taskId)
    expect(fake.provider.requests).toHaveLength(0)
    const [a, b] = await Promise.all([
      host.app.schedules.runNow(left, key('run')),
      host.app.schedules.runNow(left, key('run')),
    ])
    expect(a.runId).toBe(b.runId)
    await vi.waitUntil(async () => (await host.app.schedules.runs(left))[0]?.status === 'completed', { timeout: 12000 })
    const first = (await host.app.schedules.runs(left))[0]
    const firstSession = await host.app.sessions.get(first.session!)
    const snapshot = await sessionSnapshot()
    const scheduledTask = {
      taskId: left.taskId,
      name: input.name,
      status: 'active',
      nextRunAt: left.nextRunAt,
      timeZone: input.rule.timeZone,
    }
    expect(snapshot.recents.find((session) => session.path === firstSession.sessionFile)?.scheduledTask).toEqual(
      scheduledTask,
    )
    const projectSessions = snapshot.projects.flatMap((project) => project.sessions)
    expect(projectSessions.find((session) => session.path === firstSession.sessionFile)?.scheduledTask).toEqual(
      scheduledTask,
    )
    expect(first.session?.hostId).toBe(host.hostId)
    expect(fake.provider.requests).toHaveLength(1)
    expect(host.pi.cwd).toBe(selected)
    expect(events.length).toBeGreaterThan(1)
    await expect(host.app.schedules.get({ ...left, hostId: 'other-host' })).rejects.toThrow('身份不匹配')
    const response = await host.control.dispatch({
      apiVersion: 2,
      hostId: host.hostId,
      clientId: 'test',
      method: 'schedules.pause',
      args: [left],
      idempotencyKey: 'pause',
    })
    expect(response.error).toBeUndefined()
    off()
    await host.dispose()
    host = await createHost({ dataRoot: fake.dataRoot, credentials: fake.credentials })
    expect((await host.app.schedules.get(left)).status).toBe('paused')
    expect((await host.app.schedules.get(left)).unreadCount).toBe(1)
    expect(
      (await sessionSnapshot()).recents.find((session) => session.path === firstSession.sessionFile)?.scheduledTask,
    ).toEqual({ ...scheduledTask, status: 'paused' })
    off = await host.app.events.subscribe({}, () => {})
    await host.app.schedules.runNow(left, key('second-run'))
    await vi.waitUntil(async () => (await host.app.schedules.runs(left))[0]?.status === 'completed', { timeout: 12000 })
    expect((await host.app.schedules.runs(left))[0].session).toEqual(first.session)
    await host.app.schedules.markRead(left, first.runId, key('read'))
    expect((await host.app.schedules.get(left)).unreadCount).toBe(1)
    await host.app.schedules.delete(left, key('delete'))
    expect(await host.app.schedules.list()).toEqual([])
    expect(
      (await sessionSnapshot()).recents.find((session) => session.path === firstSession.sessionFile)?.scheduledTask,
    ).toBeUndefined()
    expect((await host.app.sessions.get(first.session!)).sessionId).toBe(first.session!.sessionId)
    off()
  } finally {
    await host.dispose()
    await fake.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
