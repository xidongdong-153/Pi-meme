import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import { ActivityService } from '@pi-meme/activities/server/service'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { createHost } from '../src/service'
import { useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'

async function eventually<T>(read: () => Promise<T>, ready: (value: T) => boolean) {
  const deadline = Date.now() + 15000
  for (;;) {
    const value = await read()
    if (ready(value)) return value
    if (Date.now() > deadline) throw new Error(`等待服务状态超时：${JSON.stringify(value)}`)
    await delay(20)
  }
}

test(
  'Agent 通过 Worker 启动服务，回复结束后持续；显式 API 停止不请求模型且可补读状态',
  { timeout: 30000, skip: process.platform === 'win32' },
  async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'pi-service-api-')))
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.log('SERVICE_READY');setInterval(()=>{},1000)")}`
    const fake = await useFakeAgent(root, {
      reply: (_body, index) =>
        index === 1 || index === 3
          ? {
              tool: {
                id: `call-service-${index}`,
                name: 'manage_service',
                arguments: JSON.stringify({ action: 'start', name: '测试 Web', command }),
              },
            }
          : '服务已启动',
    })
    const stopping = vi.spyOn(ActivityService.prototype, 'stop')
    const host = await createHost({ dataRoot: fake.runtimePaths.dataRoot, credentials: fake.credentials })
    try {
      const cwd = path.join(root, 'project')
      await mkdir(cwd)
      const project = await host.app.projects.register({ cwd }, { idempotencyKey: 'project' })
      const ref = await host.app.sessions.create(
        { project, configuration: { accessMode: 'full-access', model: { provider: 'fake', id: 'first' } } },
        { idempotencyKey: 'session' },
      )
      const other = await host.app.sessions.create({ project }, { idempotencyKey: 'other' })
      const receipt = await host.app.sessions.submit(
        ref,
        { delivery: 'start', text: '启动测试项目服务' },
        { idempotencyKey: 'start' },
      )
      await eventually(
        () => host.app.sessions.receipt(receipt.operationId),
        (value) => ['completed', 'failed'].includes(value.status),
      )
      const list = await eventually(
        () => host.app.activities.list(ref),
        (value) => value.activities.some((activity) => activity.status === 'running'),
      )
      const service = list.activities[0]
      assert.equal(service.name, '测试 Web')
      assert.equal(service.sourceName, '主 Agent')
      assert.equal(service.cwd, cwd)
      assert.equal((await host.app.activities.list(other)).activities.length, 0)
      await assert.rejects(
        host.app.activities.stop(other, service.serviceId, { idempotencyKey: 'foreign' }),
        /不属于此会话/,
      )
      await assert.rejects(
        host.app.sessions.configure(ref, { accessMode: 'read-only' }, { idempotencyKey: 'lower' }),
        /先在活动面板停止/,
      )
      assert.throws(() => host.prepareMaintenance(), /服务/)
      await eventually(
        () => host.app.activities.logs(ref, service.serviceId),
        (value) => value.output.includes('SERVICE_READY'),
      )
      const requests = fake.provider.requests.length
      const events: import('@pi-meme/contracts/app-host').HostControlEvent[] = []
      const [left, right] = await Promise.all([
        host.app.activities.stop(ref, service.serviceId, { idempotencyKey: 'stop' }),
        host.app.activities.stop(ref, service.serviceId, { idempotencyKey: 'stop' }),
      ])
      assert.equal(left.status, 'stopped')
      assert.equal(right.serviceId, left.serviceId)
      const unsubscribe = await host.app.events.subscribe({ sessionId: ref.sessionId, after: list.cursor }, (event) =>
        events.push(event),
      )
      assert.ok(
        events.some(
          (event) =>
            event.type === 'activity' && (event.value as { serviceId?: string }).serviceId === service.serviceId,
        ),
      )
      unsubscribe()
      await delay(30)
      assert.equal(fake.provider.requests.length, requests)
      assert.equal((await host.app.activities.list(ref)).activities[0].stopReason, '用户停止')
      await assert.rejects(host.app.activities.list({ ...ref, hostId: 'wrong-host' }), /Host 身份不匹配/)
      const again = await host.app.sessions.submit(
        ref,
        { delivery: 'start', text: '再次启动后测试删除' },
        { idempotencyKey: 'start-again' },
      )
      await eventually(
        () => host.app.sessions.receipt(again.operationId),
        (value) => ['completed', 'failed'].includes(value.status),
      )
      const running = await eventually(
        () => host.app.activities.list(ref),
        (value) => value.activities.some((activity) => activity.status === 'running'),
      )
      const live = running.activities.find((activity) => activity.status === 'running')!
      await host.app.sessions.stopTask(ref, { idempotencyKey: 'stop-task-with-service' })
      assert.equal(
        (await host.app.activities.list(ref)).activities.find((activity) => activity.serviceId === live.serviceId)
          ?.status,
        'running',
      )
      const target = await host.app.sessions.get(ref)
      const beforeDeletion = fake.provider.requests.length
      const response = await host.rpc({
        requestId: 'delete-with-service',
        clientId: 'test-ui',
        method: 'session:delete',
        args: [target.sessionFile],
      })
      assert.equal(response.error, undefined, JSON.stringify(response.error))
      const deleted = response.result as { errors: string[]; deletedPaths: string[] }
      assert.deepEqual(deleted.errors, [])
      assert.ok(deleted.deletedPaths.includes(target.sessionFile!))
      await assert.rejects(host.app.activities.list(ref), /会话不存在/)
      const stopIndex = stopping.mock.calls.findLastIndex(
        ([, serviceId, reason]) => serviceId === live.serviceId && reason === '删除会话',
      )
      assert.notEqual(stopIndex, -1)
      const ended = await stopping.mock.results[stopIndex]!.value
      assert.equal(ended.status, 'stopped')
      assert.equal(ended.stopReason, '删除会话')
      const deletionEvents = await host.app.events.read({ sessionId: ref.sessionId, after: running.cursor })
      assert.ok(
        deletionEvents.events.some(
          (event) =>
            event.type === 'activity' &&
            (event.value as { serviceId?: string }).serviceId === live.serviceId &&
            (event.value as { revision?: number }).revision === ended.revision,
        ),
      )
      assert.equal(fake.provider.requests.length, beforeDeletion)
    } finally {
      await host.dispose()
      stopping.mockRestore()
      await fake.dispose()
      await rm(root, { recursive: true, force: true })
    }
  },
)
