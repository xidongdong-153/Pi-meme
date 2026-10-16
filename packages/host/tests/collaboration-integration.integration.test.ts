import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'vitest'
import { setTimeout as delay } from 'node:timers/promises'
import type { AgentSummary } from '@pi-meme/contracts/collaboration'
import type { PiSessionsSnapshot } from '@pi-meme/contracts/sessions'
import type { DesktopEvent, Snapshot } from '@pi-meme/contracts/desktop'
import type { PlanDocument } from '@pi-meme/contracts/plan'
import { useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'
import { createHost } from '../src/service'
import { HostCollaborationBridge } from '@pi-meme/subagents/server/coordinator'

async function eventually(check: () => boolean | Promise<boolean>) {
  for (let count = 0; count < 200; count++) {
    if (await check()) return
    await delay(25)
  }
  throw new Error('等待 Host 状态超时')
}

test('父任务等待子 Agent 时引导及时投递一次，子任务不被取消且父子继续完成', { timeout: 60000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'host-child-steering-'))
  let releaseChild!: () => void
  const childBarrier = new Promise<void>((resolve) => {
    releaseChild = resolve
  })
  const parentRequests: Array<Array<{ role: string; content: unknown }>> = []
  const fake = await useFakeAgent(root, {
    reply: (body) => {
      const users = (body.messages ?? []).filter((message: { role: string }) => message.role === 'user')
      if (JSON.stringify(users).includes('等待引导的独立子任务'))
        return { text: '子任务已完成', deltaBarrier: childBarrier }
      parentRequests.push(body.messages ?? [])
      if (parentRequests.length === 1)
        return {
          tool: {
            name: 'spawn_agent',
            arguments: JSON.stringify({ task_name: 'worker', message: '等待引导的独立子任务', fork_turns: 'none' }),
          },
        }
      if (parentRequests.length === 2 || parentRequests.length === 3)
        return {
          text: parentRequests.length === 3 ? '已收到用户引导，继续等待子任务' : undefined,
          tool: { name: 'wait_agent', arguments: JSON.stringify({ targets: ['worker'], timeout_ms: 5000 }) },
        }
      return { text: '已收到引导并汇总子任务' }
    },
  })
  const host = await createHost({ dataRoot: path.join(root, 'userData'), credentials: fake.credentials })
  const rpc = (method: string, args: unknown[] = [], sessionId?: string) =>
    host.rpc({ requestId: crypto.randomUUID(), clientId: 'client', method, args, sessionId })
  const snapshot = async (key?: string) => (await rpc('pi:snapshot', [], key)).result as Snapshot
  const responsive = (request: ReturnType<typeof rpc>) =>
    Promise.race([
      request,
      delay(3000).then(() => {
        throw new Error('子 Agent 等待期间输入控制被阻塞')
      }),
    ])
  try {
    const key = (await snapshot()).connection.sessionKey!
    assert.equal((await rpc('pi:access-mode', [key, 'full-access'], key)).error, undefined)
    assert.equal((await rpc('pi:prompt', [key, '开启子任务后等待结果'], key)).error, undefined)
    await eventually(async () => {
      const value = await snapshot(key)
      return (
        value.agent?.status === 'waiting_children' &&
        value.agents?.some((agent) => agent.depth === 1 && agent.status === 'running') === true
      )
    })
    assert.equal((await responsive(rpc('pi:follow-up', [key, '请处理这条用户引导'], key))).error, undefined)
    const queued = (await snapshot(key)).events?.find((value) => value.event.type === 'queue_update')?.event
    assert.ok(queued?.type === 'queue_update')
    const input = queued.followUp[0]
    assert.ok(input)
    assert.equal(input.submitted, undefined)
    assert.equal((await responsive(rpc('pi:steer-queue-input', [key, input.id], key))).error, undefined)
    for (let count = 0; count < 100 && parentRequests.length < 3; count++) await delay(25)
    assert.equal(parentRequests.length, 3, '引导应提前结束当前等待，不能继续等待子任务完成或原定超时')
    const interruptedWait = parentRequests[2]!.filter(
      (message: { role: string; content: unknown }) =>
        message.role === 'user' && JSON.stringify(message.content).includes('请处理这条用户引导'),
    )
    assert.equal(interruptedWait.length, 1)
    assert.ok((await snapshot(key)).agents?.some((agent) => agent.depth === 1 && agent.status === 'running'))
    releaseChild()
    await eventually(async () => {
      const value = await snapshot(key)
      return (
        value.agent?.status === 'completed' &&
        value.agents?.some((agent) => agent.depth === 1 && agent.status === 'completed') === true
      )
    })
    const final = await snapshot(key)
    assert.equal(parentRequests.length, 4)
    assert.equal(
      final.messages.filter(
        (message) => message.role === 'user' && JSON.stringify(message.content).includes('请处理这条用户引导'),
      ).length,
      1,
    )
    assert.ok(
      final.messages.some(
        (message) => message.role === 'assistant' && JSON.stringify(message.content).includes('已收到引导并汇总子任务'),
      ),
    )
    const received = parentRequests
      .at(-1)!
      .filter(
        (message: { role: string; content: unknown }) =>
          message.role === 'user' && JSON.stringify(message.content).includes('请处理这条用户引导'),
      )
    assert.equal(received.length, 1)
    const interrupted = final.messages.find(
      (message) => message.role === 'toolResult' && message.toolName === 'wait_agent',
    )
    assert.ok(interrupted?.role === 'toolResult')
    assert.equal(interrupted.isError, false)
    assert.equal((interrupted.details as { timedOut: boolean }).timedOut, false)
  } finally {
    releaseChild()
    await host.dispose()
    await fake.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('父任务已预约但尚未准入时登记退役，等待后续子任务与自动汇总完成', { timeout: 20000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'host-retire-admission-'))
  let spawned = false
  let resumed = false
  const fake = await useFakeAgent(root, {
    reply: (body) => {
      const text = JSON.stringify((body.messages ?? []).filter((message: { role: string }) => message.role === 'user'))
      if (text.includes('退役窗口独立子任务')) return { text: '子任务已完成', delayMs: 750 }
      if (text.includes('子 Agent 已返回结果')) {
        resumed = true
        return { text: '汇总已完成', delayMs: 50 }
      }
      if (!spawned && text.includes('预约后委派')) {
        spawned = true
        return {
          tool: {
            name: 'spawn_agent',
            arguments: JSON.stringify({ task_name: 'worker', message: '退役窗口独立子任务', fork_turns: 'none' }),
          },
        }
      }
      return { text: '根任务结束' }
    },
  })
  const host = await createHost({ dataRoot: path.join(root, 'userData'), credentials: fake.credentials })
  const rpc = (method: string, args: unknown[] = [], sessionId?: string) =>
    host.rpc({ requestId: crypto.randomUUID(), clientId: 'client', method, args, sessionId })
  let acquired = 0
  let released = 0
  const acquire = host.plugins.acquire.bind(host.plugins)
  host.plugins.acquire = (...args) => {
    acquired++
    const lease = acquire(...args)
    return {
      ...lease,
      release: async () => {
        released++
        await lease.release()
      },
    }
  }
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered!: () => void
  const entering = new Promise<void>((resolve) => {
    entered = resolve
  })
  const admit = HostCollaborationBridge.prototype.admit
  HostCollaborationBridge.prototype.admit = async function (session, message, mode, continuation, signal) {
    if (message === '预约后委派' && !continuation) {
      entered()
      await gate
    }
    await admit.call(this, session, message, mode, continuation, signal)
  }
  try {
    const source = path.join(root, 'agent-plugin')
    await mkdir(path.join(source, 'dist/agent'), { recursive: true })
    await writeFile(
      path.join(source, 'package.json'),
      JSON.stringify({
        name: 'retire-admission-fixture',
        version: '1.0.0',
        piMeme: { sdkVersion: 2, agent: 'dist/agent.js' },
      }),
    )
    await writeFile(path.join(source, 'dist/agent.js'), 'export function activate() {}')
    await host.plugins.loadDirectory(source)
    const key = ((await rpc('pi:snapshot')).result as Snapshot).connection.sessionKey!
    await rpc('pi:access-mode', [key, 'full-access'], key)
    const ref = await host.control.sessionForRuntime(key)
    await host.app.sessions.configure(
      ref,
      { agentPlugins: ['retire-admission-fixture'] },
      { idempotencyKey: crypto.randomUUID() },
    )
    await rpc('pi:prompt', [key, '旧任务'], key)
    await eventually(async () => ((await rpc('pi:agents', [key])).result as AgentSummary[])[0]?.status === 'completed')
    const prompting = rpc('pi:prompt', [key, '预约后委派'], key)
    await entering
    await writeFile(
      path.join(source, 'package.json'),
      JSON.stringify({
        name: 'retire-admission-fixture',
        version: '2.0.0',
        piMeme: { sdkVersion: 2, agent: 'dist/agent.js' },
      }),
    )
    await host.plugins.reload('retire-admission-fixture')
    assert.equal(released, 0)
    release()
    assert.equal((await prompting).error, undefined)
    await eventually(async () => {
      const agents = (await rpc('pi:agents', [key])).result as AgentSummary[]
      return (
        agents[0]?.status === 'waiting_children' &&
        agents.some((agent) => agent.depth === 1 && agent.status === 'running')
      )
    })
    assert.equal(released, 0)
    await eventually(() => acquired === released)
    assert.equal(resumed, true)
    assert.equal(acquired, 2)
    const snapshot = (await rpc('pi:snapshot')).result as Snapshot
    assert.equal(snapshot.agent?.status, 'completed')
    assert.ok(snapshot.agents?.some((agent) => agent.depth === 1 && agent.status === 'completed'))
    assert.ok(
      snapshot.messages.some(
        (message) => message.role === 'assistant' && JSON.stringify(message.content).includes('汇总已完成'),
      ),
    )
  } finally {
    release()
    HostCollaborationBridge.prototype.admit = admit
    await host.dispose()
    await fake.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('Host 重启后从原生历史恢复被抹空的计划身份，保留全部正文且只读切换不启动模型', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'host-plan-history-'))
  const dataRoot = path.join(root, 'userData')
  let nextPlan: { title: string; markdown: string } | undefined
  const fake = await useFakeAgent(root, {
    reply: () => {
      if (nextPlan) {
        const input = nextPlan
        nextPlan = undefined
        return { tool: { name: 'save_plan', arguments: JSON.stringify(input) } }
      }
      return { text: '计划已保存' }
    },
  })
  let host = await createHost({ dataRoot, credentials: fake.credentials })
  const rpc = (method: string, args: unknown[] = [], sessionId?: string) =>
    host.rpc({ requestId: crypto.randomUUID(), clientId: 'client', method, args, sessionId })
  const snapshot = async (key?: string) => (await rpc('pi:snapshot', [], key)).result as Snapshot
  const save = async (key: string, title: string) => {
    nextPlan = { title, markdown: `# ${title}\n保留所有已有计划数据` }
    assert.equal((await rpc('pi:prompt', [key, title, [], [], { mode: 'plan' }], key)).error, undefined)
    await eventually(async () => (await snapshot(key)).agent?.status === 'completed')
    const value = await snapshot(key)
    assert.ok(value.planDocuments?.some((plan) => plan.title === title))
    return value
  }
  try {
    const key = (await snapshot()).connection.sessionKey!
    assert.equal((await rpc('pi:access-mode', [key, 'full-access'], key)).error, undefined)
    await save(key, '第一份已有计划')
    const saved = await save(key, '第二份已有计划')
    const sessionFile = saved.connection.sessionFile!
    const plans = saved.planDocuments!
    assert.equal(plans.length, 2)
    const originalAgentId = saved.agent!.agentId
    const originalJsonl = await readFile(sessionFile, 'utf8')
    assert.equal(JSON.parse(originalJsonl.split('\n')[0]!).id, plans[0]!.sessionId)
    const another = (await rpc('pi:new-session')).result as { snapshot: Snapshot }
    const otherKey = another.snapshot.connection.sessionKey!
    await rpc('pi:access-mode', [otherKey, 'full-access'], otherKey)
    const other = await save(otherKey, '其他会话计划')
    const otherFile = other.connection.sessionFile!
    assert.equal(other.planDocuments!.length, 1)
    const otherJsonl = await readFile(otherFile, 'utf8')
    await host.dispose()
    const metadataFile = path.join(dataRoot, 'collaboration.json')
    const metadata = JSON.parse(await readFile(metadataFile, 'utf8')) as {
      records: Array<{ summary: AgentSummary }>
      plans: PlanDocument[]
    }
    delete metadata.records.find((record) => record.summary.agentId === originalAgentId)!.summary.sessionId
    await writeFile(metadataFile, JSON.stringify(metadata))
    const requests = fake.provider.requests.length
    host = await createHost({ dataRoot, credentials: fake.credentials })
    const selected = await rpc('pi:switch-session', [sessionFile])
    assert.equal(selected.error, undefined)
    const restored = (selected.result as { snapshot: Snapshot }).snapshot
    assert.notEqual(restored.connection.sessionKey, key)
    assert.equal(restored.connection.status, 'idle')
    assert.equal(restored.agent!.agentId, originalAgentId)
    assert.equal(restored.agent!.sessionId, plans[0]!.sessionId)
    assert.deepEqual(restored.planDocuments, plans)
    await rpc('pi:switch-session', [otherFile])
    assert.deepEqual((await snapshot()).planDocuments, other.planDocuments)
    await rpc('pi:switch-session', [sessionFile])
    assert.deepEqual((await snapshot()).planDocuments, plans)
    assert.equal(fake.provider.requests.length, requests)
    assert.equal(await readFile(sessionFile, 'utf8'), originalJsonl)
    assert.equal(await readFile(otherFile, 'utf8'), otherJsonl)
    const recovered = JSON.parse(await readFile(metadataFile, 'utf8')) as typeof metadata
    assert.deepEqual(recovered.plans, metadata.plans)
    for (const plan of metadata.plans)
      assert.equal(await readFile(path.join(dataRoot, 'plans', plan.sessionId, `${plan.id}.md`), 'utf8'), plan.markdown)
  } finally {
    await host.dispose()
    await fake.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('模式 RPC 接受 default/plan，纯命令不调用模型，协作入口绑定实际 Worker', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'host-modes-'))
  const fake = await useFakeAgent(root)
  const host = await createHost({ dataRoot: path.join(root, 'userData'), credentials: fake.credentials })
  const rpc = (method: string, args: unknown[] = [], sessionId?: string) =>
    host.rpc({ requestId: crypto.randomUUID(), clientId: 'client', method, args, sessionId })
  try {
    const initial = (await rpc('pi:snapshot')).result as Snapshot
    const key = initial.connection.sessionKey!
    assert.equal((await rpc('pi:session-mode', [key, 'plan'], key)).error, undefined)
    assert.equal(((await rpc('pi:snapshot', [], key)).result as Snapshot).state.mode, 'plan')
    assert.equal((await rpc('pi:session-mode', [key, 'default'], key)).error, undefined)
    assert.equal((await rpc('pi:prompt', [key, '/plan', [], []], key)).error, undefined)
    assert.equal(fake.provider.requests.length, 0)
    const planning = (await rpc('pi:snapshot', [], key)).result as Snapshot
    assert.equal(planning.state.mode, 'plan')
    assert.equal(planning.agent?.agentId, initial.agent?.agentId)
    assert.equal((await rpc('pi:session-mode', [key, 'default'], key)).error, undefined)
    assert.equal(((await rpc('pi:snapshot', [], key)).result as Snapshot).state.mode, 'default')
    assert.ok(
      (await rpc('spawn_agent', [{ caller: initial.agent?.agentId, task_name: 'spoof', message: '伪造请求' }], key))
        .error,
    )
    assert.ok((await rpc('save_plan', [{ title: '伪造', markdown: '没有 Worker 身份' }], key)).error)
    assert.equal(fake.provider.requests.length, 0)
  } finally {
    await host.dispose()
    await fake.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('零外部插件能聊天，父子 Worker 分别持有租约，子快照不切换视图，退役与退出释放租约', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'host-collaboration-'))
  let spawned = false
  const fake = await useFakeAgent(root, {
    reply: (body) => {
      const userText = (body.messages ?? [])
        .filter((message: { role: string }) => message.role === 'user')
        .map((message: { content: unknown }) => JSON.stringify(message.content))
        .join('\n')
      if (userText.includes('独立子任务')) return { text: '子任务已完成', delayMs: 500 }
      if (!spawned && userText.includes('启动一个子任务')) {
        spawned = true
        return {
          tool: {
            name: 'spawn_agent',
            arguments: JSON.stringify({ task_name: 'worker', message: '独立子任务', fork_turns: 'none' }),
          },
        }
      }
      return { text: '根任务完成' }
    },
  })
  const host = await createHost({ dataRoot: path.join(root, 'userData'), credentials: fake.credentials })
  const rpc = (method: string, args: unknown[] = [], sessionId?: string) =>
    host.rpc({ requestId: crypto.randomUUID(), clientId: 'client', method, args, sessionId })
  const events: DesktopEvent[] = []
  const unsubscribe = await host.subscribe('client', (event) => {
    if (event.type === 'event') events.push(event.value)
  })
  let acquired = 0
  let released = 0
  const retained: string[][] = []
  let restarted: Awaited<ReturnType<typeof createHost>> | undefined
  const acquire = host.plugins.acquire.bind(host.plugins)
  host.plugins.acquire = (...args) => {
    acquired++
    const lease = acquire(...args)
    retained.push(lease.retainedIds)
    let done = false
    return {
      ...lease,
      release: async () => {
        if (!done) {
          done = true
          released++
        }
        await lease.release()
      },
    }
  }
  try {
    const initial = (await rpc('pi:snapshot')).result as Snapshot
    const key = initial.connection.sessionKey!
    assert.deepEqual(initial.uiPlugins, [])
    await rpc('pi:access-mode', [key, 'full-access'], key)
    assert.equal((await rpc('pi:prompt', [key, '零插件基础对话', [], []], key)).error, undefined)
    await eventually(async () => ((await rpc('pi:snapshot', [], key)).result as Snapshot).agent?.status === 'completed')
    assert.ok(
      ((await rpc('pi:snapshot', [], key)).result as Snapshot).messages.some((message) => message.role === 'assistant'),
    )
    const source = path.join(root, 'agent-plugin')
    await mkdir(path.join(source, 'dist/agent'), { recursive: true })
    await writeFile(
      path.join(source, 'package.json'),
      JSON.stringify({
        name: 'lease-fixture',
        version: '1.0.0',
        piMeme: { sdkVersion: 2, agent: 'dist/agent/entry.js' },
      }),
    )
    await writeFile(path.join(source, 'dist/agent/entry.js'), 'export function activate() {}')
    await host.plugins.loadDirectory(source)
    const ref = await host.control.sessionForRuntime(key)
    await host.app.sessions.configure(ref, { agentPlugins: ['lease-fixture'] }, { idempotencyKey: crypto.randomUUID() })
    await eventually(() => released === acquired)
    const firstRun = ((await rpc('pi:agents', [key], key)).result as AgentSummary[])[0]!
    assert.equal((await rpc('pi:prompt', [key, '启动一个子任务', [], []], key)).error, undefined)
    let child: AgentSummary | undefined
    await eventually(async () => {
      const agents = (await rpc('pi:agents', [key], key)).result as AgentSummary[]
      child = agents.find((agent) => agent.depth === 1)
      return Boolean(child?.status === 'completed' && agents[0]?.status === 'completed')
    })
    assert.ok(child)
    assert.equal(child.parentAgentId, firstRun.agentId)
    assert.notEqual(child.rootTaskId, firstRun.rootTaskId)
    assert.equal(child.epoch, firstRun.epoch + 1)
    const list = (await rpc('pi:sessions')).result as PiSessionsSnapshot
    assert.equal(
      [...list.recents, ...list.projects.flatMap((group) => group.sessions), ...(list.standaloneSessions ?? [])].some(
        (session) => session.path === child!.sessionFile || session.id === child!.sessionId,
      ),
      false,
    )
    assert.ok(list.projects.every((group) => group.sessionCount === group.sessions.length))
    assert.equal(acquired, 3)
    assert.deepEqual(retained.slice(-2), [['lease-fixture'], ['lease-fixture']])
    const count = fake.provider.requests.length
    const childSnapshot = (await rpc('pi:agent-snapshot', [child.agentId])).result as Snapshot
    assert.equal(childSnapshot.agent?.agentId, child.agentId)
    assert.equal(acquired, 3)
    assert.equal(fake.provider.requests.length, count)
    assert.equal(((await rpc('pi:snapshot')).result as Snapshot).connection.sessionKey, key)
    assert.ok(
      events.some(
        (event) =>
          event.agentId === child!.agentId &&
          event.rootAgentId === firstRun.agentId &&
          event.runId &&
          event.executionGeneration !== undefined,
      ),
    )
    await writeFile(
      path.join(source, 'package.json'),
      JSON.stringify({
        name: 'lease-fixture',
        version: '2.0.0',
        piMeme: { sdkVersion: 2, agent: 'dist/agent/entry.js' },
      }),
    )
    await host.plugins.reload('lease-fixture')
    await eventually(() => released === acquired)
    const stoppedSnapshot = (await rpc('pi:agent-snapshot', [child.agentId])).result as Snapshot
    assert.equal(stoppedSnapshot.agent?.agentId, child.agentId)
    assert.equal(acquired, 3, '已退役子会话快照不能启动新 Worker')
    const rootSequences = events
      .filter((event) => event.sessionKey === key && event.sequence !== undefined)
      .map((event) => event.sequence!)
    assert.equal(new Set(rootSequences).size, rootSequences.length)
    assert.ok(rootSequences.every((sequence, index) => index === 0 || sequence > rootSequences[index - 1]!))
    assert.equal((await rpc('pi:prompt', [key, '新任务加载外部插件', [], []], key)).error, undefined)
    await eventually(async () => ((await rpc('pi:snapshot', [], key)).result as Snapshot).agent?.status === 'completed')
    const parentFile = ((await rpc('pi:snapshot', [], key)).result as Snapshot).connection.sessionFile!
    assert.ok(parentFile)
    assert.equal((await rpc('pi:session-mode', [key, 'plan'], key)).error, undefined)
    await host.dispose()
    assert.equal(released, acquired)
    restarted = await createHost({ dataRoot: path.join(root, 'userData'), credentials: fake.credentials })
    const restoredList = (
      await restarted.rpc({ requestId: crypto.randomUUID(), clientId: 'restored', method: 'pi:sessions', args: [] })
    ).result as PiSessionsSnapshot
    assert.equal(
      [
        ...restoredList.recents,
        ...restoredList.projects.flatMap((group) => group.sessions),
        ...(restoredList.standaloneSessions ?? []),
      ].some((session) => session.path === child!.sessionFile || session.id === child!.sessionId),
      false,
    )
    const restored = await restarted.rpc({
      requestId: crypto.randomUUID(),
      clientId: 'restored',
      method: 'pi:switch-session',
      args: [parentFile],
    })
    assert.equal(restored.error, undefined)
    const restoredSnapshot = (restored.result as { snapshot: Snapshot }).snapshot
    assert.equal(restoredSnapshot.state.mode, 'plan')
    assert.equal(restoredSnapshot.agent?.agentId, firstRun.agentId)
  } finally {
    unsubscribe()
    await restarted?.dispose()
    await host.dispose()
    await fake.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('根快照包含子会话待答问题，回答按实际子 sessionKey 分派并拒绝错误来源', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'host-child-question-'))
  let spawned = false
  const fake = await useFakeAgent(root, {
    reply: (body) => {
      const text = JSON.stringify(body.messages ?? [])
      if (text.includes('提问子任务')) {
        if ((body.messages ?? []).some((message: { role: string }) => message.role === 'tool')) return '子问题已回答'
        return {
          tool: {
            name: 'request_user_input',
            arguments: JSON.stringify({
              questions: [
                { id: 'goal', question: '子任务需要确认目标' },
                { id: 'detail', question: '补充说明' },
              ],
            }),
          },
        }
      }
      if (!spawned) {
        spawned = true
        return {
          tool: {
            name: 'spawn_agent',
            arguments: JSON.stringify({ task_name: 'question', message: '提问子任务', fork_turns: 'none' }),
          },
        }
      }
      return '根任务完成'
    },
  })
  const host = await createHost({ dataRoot: path.join(root, 'userData'), credentials: fake.credentials })
  const rpc = (method: string, args: unknown[] = [], sessionId?: string) =>
    host.rpc({ requestId: crypto.randomUUID(), clientId: 'client', method, args, sessionId })
  try {
    const key = ((await rpc('pi:snapshot')).result as Snapshot).connection.sessionKey!
    await rpc('pi:access-mode', [key, 'full-access'], key)
    assert.equal((await rpc('pi:prompt', [key, '请子任务提问', [], [], { mode: 'plan' }], key)).error, undefined)
    let pending: Snapshot['pendingInteractions'] extends Array<infer T> | undefined ? T | undefined : never
    await eventually(async () => {
      const value = (await rpc('pi:snapshot', [], key)).result as Snapshot
      pending = value.pendingInteractions?.find((entry) => entry.sessionKey.startsWith('agent:'))
      return Boolean(pending)
    })
    assert.ok(pending)
    assert.equal(pending.source.rootSessionKey, key)
    assert.ok((await rpc('pi:extension-ui-response', [key, pending.request.id, { value: '错误根来源' }], key)).error)
    assert.ok(
      (await rpc('pi:extension-ui-response', [key, pending.request.id, { value: '伪造子来源' }], pending.sessionKey))
        .error,
    )
    assert.equal(pending.request.method, 'questions')
    const restored = (await rpc('pi:snapshot', [], key)).result as Snapshot
    assert.deepEqual(
      restored.pendingInteractions?.find((entry) => entry.sessionKey === pending!.sessionKey),
      pending,
    )
    for (const answers of [
      [{ id: 'goal', value: '目标' }],
      [
        { id: 'goal', value: '目标' },
        { id: 'unknown', value: null },
      ],
      [
        { id: 'goal', value: '目标' },
        { id: 'goal', value: null },
      ],
    ])
      assert.ok(
        (
          await rpc(
            'pi:extension-ui-response',
            [pending.sessionKey, pending.request.id, { answers }],
            pending.sessionKey,
          )
        ).error,
      )
    const answers = [
      { id: 'goal', value: '已确认目标' },
      { id: 'detail', value: null },
    ]
    const competing = await Promise.all([
      rpc('pi:extension-ui-response', [pending.sessionKey, pending.request.id, { answers }], pending.sessionKey),
      host.rpc({
        requestId: crypto.randomUUID(),
        clientId: 'second-client',
        method: 'pi:extension-ui-response',
        args: [pending.sessionKey, pending.request.id, { answers }],
        sessionId: pending.sessionKey,
      }),
    ])
    assert.equal(competing.filter((answer) => !answer.error).length, 1)
    await eventually(async () => ((await rpc('pi:snapshot', [], key)).result as Snapshot).agent?.status === 'completed')
    const final = (await rpc('pi:snapshot', [], key)).result as Snapshot
    assert.deepEqual(final.pendingInteractions, [])
    assert.equal(final.connection.sessionKey, key)
  } finally {
    await host.dispose()
    await fake.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('根任务普通与规划模式均加载内置提问，快照恢复多题且多客户端只回答一次', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'host-root-questions-'))
  const questions = [
    {
      id: 'scope',
      question: '修改哪些页面',
      options: [{ label: '全部', description: '包含桌面端和 Web' }, { label: '当前页' }],
    },
    { id: 'detail', question: '补充说明' },
  ]
  const fake = await useFakeAgent(root, {
    reply: (body) =>
      body.messages?.at(-1)?.role === 'user'
        ? { tool: { name: 'request_user_input', arguments: JSON.stringify({ questions }) } }
        : '回答已收到',
  })
  const host = await createHost({ dataRoot: path.join(root, 'userData'), credentials: fake.credentials })
  const rpc = (method: string, args: unknown[] = [], sessionId?: string, clientId = 'client') =>
    host.rpc({ requestId: crypto.randomUUID(), clientId, method, args, sessionId })
  try {
    const key = ((await rpc('pi:snapshot')).result as Snapshot).connection.sessionKey!
    await rpc('pi:access-mode', [key, 'full-access'], key)
    for (const mode of ['default', 'plan'] as const) {
      assert.equal((await rpc('pi:prompt', [key, `请提问 ${mode}`, [], [], { mode }], key)).error, undefined)
      let pending: import('@pi-meme/contracts/collaboration').PendingInteraction | undefined
      await eventually(async () => {
        const snapshot = (await rpc('pi:snapshot', [], key)).result as Snapshot
        pending = snapshot.pendingInteractions?.find((entry) => entry.sessionKey === key)
        return Boolean(pending)
      })
      assert.ok(pending)
      assert.equal(pending.request.method, 'questions')
      if (pending.request.method !== 'questions') throw new Error('应收到多题请求')
      assert.deepEqual(pending.request.questions, questions)
      const reconnected = (await rpc('pi:snapshot', [], key, 'reconnected')).result as Snapshot
      assert.deepEqual(reconnected.pendingInteractions, [pending])
      assert.ok(
        (
          await rpc(
            'pi:extension-ui-response',
            [key, pending.request.id, { answers: [{ id: 'scope', value: '全部' }] }],
            key,
          )
        ).error,
      )
      const response =
        mode === 'default'
          ? {
              answers: [
                { id: 'scope', value: '仅桌面端' },
                { id: 'detail', value: null },
              ],
            }
          : { cancelled: true }
      const results = await Promise.all([
        rpc('pi:extension-ui-response', [key, pending.request.id, response], key),
        rpc('pi:extension-ui-response', [key, pending.request.id, response], key, 'reconnected'),
      ])
      assert.equal(results.filter((result) => !result.error).length, 1)
      await eventually(async () => !((await rpc('pi:snapshot', [], key)).result as Snapshot).state.isStreaming)
      const snapshot = (await rpc('pi:snapshot', [], key)).result as Snapshot
      assert.deepEqual(snapshot.pendingInteractions, [])
      const result = snapshot.messages
        .filter((message) => message.role === 'toolResult' && message.toolName === 'request_user_input')
        .at(-1)
      assert.ok(result?.role === 'toolResult')
      assert.deepEqual(
        result.details,
        mode === 'default'
          ? {
              answers: [
                { id: 'scope', value: '仅桌面端' },
                { id: 'detail', value: null },
              ],
              cancelled: false,
            }
          : { answers: [], cancelled: true },
      )
    }
    const tools = fake.provider.requests.map(
      (request: { tools?: Array<{ function: { name: string } }> }) =>
        request.tools?.map((tool) => tool.function.name) ?? [],
    )
    assert.ok(tools.every((names: string[]) => names.includes('request_user_input')))
    assert.ok(tools.slice(0, 2).every((names: string[]) => !names.includes('save_plan')))
    assert.ok(
      tools
        .slice(2)
        .every((names: string[]) => names.includes('save_plan') && !names.includes('write') && !names.includes('bash')),
    )
  } finally {
    await host.dispose()
    await fake.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
