import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { test, vi } from 'vitest'
import { ActivityService, type ActivityCaller } from '../src/server/service'

const supported = process.platform === 'darwin' || process.platform === 'linux'
const ref = { hostId: 'test-host', sessionId: 'test-session' }

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'activity-service-')))
  const cwd = path.join(root, 'project')
  const dataRoot = path.join(root, 'data')
  await Promise.all([mkdir(cwd), mkdir(dataRoot)])
  const changes: string[] = []
  const logEvents: number[] = []
  const service = new ActivityService({
    hostId: ref.hostId,
    dataRoot,
    onChange: (activity) => changes.push(activity.status),
    onLogs: ({ sequence }) => logEvents.push(sequence),
  })
  const caller: ActivityCaller = {
    session: ref,
    cwd,
    agentDir: dataRoot,
    sourceName: '主 Agent',
    accessMode: 'full-access',
  }
  return {
    root,
    cwd,
    service,
    caller,
    changes,
    logEvents,
    async dispose() {
      await service.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}

const command = (source: string) => `${JSON.stringify(process.execPath)} -e '${source.replaceAll("'", "'\\''")}'`

test('失败运行仅停止自己创建的服务，同身份的新运行保持运行', { skip: !supported }, async () => {
  const f = await fixture()
  try {
    const firstRun = { agentId: 'agent', rootTaskId: 'task-old', epoch: 1, runId: 'run-old' }
    const nextRun = { agentId: 'agent', rootTaskId: 'task-new', epoch: 2, runId: 'run-new' }
    const input = { name: '测试服务', requestId: 'same-request', command: command('setInterval(()=>{},1000)') }
    const oldService = await f.service.start({ ...f.caller, sourceAgentId: 'agent', sourceRun: firstRun }, input)
    const nextService = await f.service.start({ ...f.caller, sourceAgentId: 'agent', sourceRun: nextRun }, input)
    assert.notEqual(oldService.serviceId, nextService.serviceId)
    await f.service.stopRun(firstRun)
    const activities = f.service.list(ref).activities
    assert.equal(activities.find((activity) => activity.serviceId === oldService.serviceId)?.status, 'stopped')
    assert.equal(activities.find((activity) => activity.serviceId === nextService.serviceId)?.status, 'running')
  } finally {
    await f.dispose()
  }
})
async function until(read: () => boolean) {
  for (let index = 0; index < 120; index++) {
    if (read()) return
    await delay(25)
  }
  throw new Error('等待服务状态超时')
}
async function canConnect(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

test('显式启动登记、同请求幂等、停止释放真实端口且会话控制隔离', { skip: !supported }, async () => {
  const f = await fixture()
  try {
    const input = {
      name: 'Web 服务',
      requestId: 'one',
      command: command(`
        const server=require('node:net').createServer();
        server.listen(0,'127.0.0.1',()=>console.log('http://127.0.0.1:'+server.address().port));
      `),
    }
    const starting = f.service.start(f.caller, input)
    assert.equal(f.service.list(ref).activities[0].status, 'starting')
    assert.throws(() => f.service.assertIdle(f.cwd), /仍有活动服务/)
    const [activity, same] = await Promise.all([starting, f.service.start(f.caller, input)])
    assert.equal(same.serviceId, activity.serviceId)
    assert.equal(f.service.list(ref).activities.length, 1)
    await until(() => f.service.list(ref).activities[0].urls.length > 0)
    const running = f.service.list(ref).activities[0]
    const port = Number(new URL(running.urls[0]).port)
    assert.equal(await canConnect(port), true)
    assert.throws(() => f.service.logs({ ...ref, sessionId: 'other' }, activity.serviceId), /不属于此会话/)
    await assert.rejects(f.service.stop({ ...ref, hostId: 'other' }, activity.serviceId), /Host 不匹配/)
    await assert.rejects(f.service.start(f.caller, { ...input, command: 'other' }), /同一启动请求/)
    const stopped = await f.service.stop(ref, activity.serviceId)
    assert.equal(stopped.status, 'stopped')
    assert.equal(stopped.stopReason, '用户停止')
    assert.equal(await canConnect(port), false)
    assert.equal((await f.service.stop(ref, activity.serviceId)).status, 'stopped')
    f.service.assertIdle()
    assert.ok(f.changes.includes('running'))
    assert.ok(f.changes.includes('stopping'))
  } finally {
    await f.dispose()
  }
})

test('日志尾有界、安全提取地址且普通日志以节流事件更新', { skip: !supported }, async () => {
  const f = await fixture()
  try {
    const activity = await f.service.start(f.caller, {
      name: '日志服务',
      requestId: 'logs',
      command: command(`
        console.log('javascript:alert(1) http://user:password@localhost:1/ http://localhost:5173/');
        process.stdout.write('x'.repeat(300*1024));
        setInterval(()=>console.log('tick'),50);
      `),
    })
    await until(() => f.service.logs(ref, activity.serviceId).truncated && f.logEvents.length > 0)
    const logs = f.service.logs(ref, activity.serviceId)
    assert.equal(Buffer.byteLength(logs.output) <= 256 * 1024, true)
    assert.equal(logs.truncated, true)
    assert.deepEqual(f.service.list(ref).activities[0].urls, ['http://localhost:5173/'])
    assert.ok(logs.sequence > 0)
    await f.service.stop(ref, activity.serviceId)
  } finally {
    await f.dispose()
  }
})

test('启动交接后取消原工具不停止服务，Host dispose 停止服务并拒绝新启动', { skip: !supported }, async () => {
  const f = await fixture()
  try {
    const abort = new AbortController()
    const input = { name: '后台服务', requestId: 'dispose', command: command('setInterval(()=>{},1000)') }
    const activity = await f.service.start(f.caller, input, abort.signal)
    abort.abort()
    await delay(50)
    assert.equal(f.service.list(ref).activities[0].status, 'running')
    await f.service.dispose()
    assert.equal(f.service.list(ref).activities[0].status, 'stopped')
    assert.equal(f.service.list(ref).activities[0].stopReason, 'Host 正常退出')
    await assert.rejects(f.service.start(f.caller, input), /已关闭/)
    assert.equal(f.service.logs(ref, activity.serviceId).sequence, 0)
  } finally {
    await f.dispose()
  }
})

test('启动尚未完成时停止和 Host dispose 不留下运行记录', { skip: !supported }, async () => {
  const f = await fixture()
  try {
    const launch = f.service.start(f.caller, {
      name: '待启动服务',
      requestId: 'pending',
      command: command('setInterval(()=>{},1000)'),
    })
    const rejection = assert.rejects(launch, /启动已取消/)
    await f.service.dispose()
    await rejection
    assert.equal(f.service.list(ref).activities[0].status, 'stopped')
    assert.equal(f.service.list(ref).activities[0].stopReason, 'Host 正常退出')
    f.service.assertIdle()
  } finally {
    await f.dispose()
  }
})

test('停止信号失败保留活动和错误，重试可重新发送信号', { skip: !supported }, async () => {
  const f = await fixture()
  try {
    const activity = await f.service.start(f.caller, {
      name: '重试服务',
      requestId: 'retry',
      command: command('console.log("ready");setInterval(()=>{},1000)'),
    })
    await until(() => f.service.logs(ref, activity.serviceId).output.includes('ready'))
    const kill = vi.spyOn(process, 'kill').mockImplementationOnce(() => {
      throw Object.assign(new Error('临时拒绝信号'), { code: 'EPERM' })
    })
    try {
      await assert.rejects(f.service.stop(ref, activity.serviceId), /临时拒绝信号/)
    } finally {
      kill.mockRestore()
    }
    const failed = f.service.list(ref).activities[0]
    assert.equal(failed.status, 'stopping')
    assert.match(failed.lastError!, /临时拒绝信号/)
    assert.throws(() => f.service.assertIdle(), /仍有活动服务/)
    assert.equal((await f.service.stop(ref, activity.serviceId)).status, 'stopped')
    assert.equal(f.service.list(ref).activities[0].lastError, undefined)
  } finally {
    await f.dispose()
  }
})

test('不同可信来源不共享启动幂等键，结束记录保持数量上限', { skip: !supported }, async () => {
  const f = await fixture()
  try {
    const input = { name: '隔离服务', requestId: 'same', command: command('setInterval(()=>{},1000)') }
    const root = await f.service.start(f.caller, input)
    const child = await f.service.start({ ...f.caller, sourceAgentId: 'child', sourceName: '子 Agent' }, input)
    assert.notEqual(root.serviceId, child.serviceId)
    await Promise.all([f.service.stop(ref, root.serviceId), f.service.stop(ref, child.serviceId)])
    for (let index = 0; index < 68; index++) {
      await assert.rejects(
        f.service.start(f.caller, { ...input, requestId: `failed-${index}`, cwd: path.join(f.root, 'missing') }),
        /ENOENT/,
      )
    }
    assert.equal(f.service.list(ref).activities.length, 64)
    f.service.assertIdle()
  } finally {
    await f.dispose()
  }
})

test('服务沙箱继承原工作区权限，不以输入 cwd 扩大授权', { skip: !supported }, async () => {
  const f = await fixture()
  try {
    const outside = path.join(f.root, 'outside')
    await mkdir(outside)
    const caller = { ...f.caller, accessMode: 'workspace-write' as const }
    await assert.rejects(
      f.service.start(caller, { name: '越界目录', command: 'true', cwd: outside, requestId: 'outside' }),
      /工作区外启动/,
    )
    const activity = await f.service.start(caller, {
      name: '受限服务',
      requestId: 'sandbox',
      command: `echo allowed > allowed; echo forbidden > ${JSON.stringify(path.join(outside, 'forbidden'))}; echo ready; sleep 30`,
    })
    await until(() => f.service.logs(ref, activity.serviceId).output.includes('ready'))
    assert.equal(await readFile(path.join(f.cwd, 'allowed'), 'utf8'), 'allowed\n')
    await assert.rejects(readFile(path.join(outside, 'forbidden')), /ENOENT/)
    await f.service.stop(ref, activity.serviceId)
    const readonly = await f.service.start(
      { ...f.caller, accessMode: 'read-only' },
      { name: '只读服务', requestId: 'read-only', command: 'echo forbidden > readonly; echo ready; sleep 30' },
    )
    await until(() => f.service.logs(ref, readonly.serviceId).output.includes('ready'))
    await assert.rejects(readFile(path.join(f.cwd, 'readonly')), /ENOENT/)
    await f.service.stop(ref, readonly.serviceId)
  } finally {
    await f.dispose()
  }
})
