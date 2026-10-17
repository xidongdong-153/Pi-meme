import assert from 'node:assert/strict'
import { test, describe } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createHostCollaborationBridge } from '../src/server/coordinator'
import type { RuntimeSdkSession } from '@pi-meme/pi-runtime/session-pool'
import type { CollaborationRequest, CollaborationResults, AgentSummary } from '@pi-meme/contracts/collaboration'
import { SdkSession } from '@pi-meme/pi-runtime/sdk/session'
import { useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'
import { fakeSession, setup } from './coordinator-fixture'

test('场景头像保存在身份与结果中，续跑保留，后代不继承且无效配置不创建身份', async () => {
  const context = await setup()
  try {
    await context.begin()
    const child = (await context.call(context.root.session, 'spawn_agent', {
      task_name: 'worker',
      message: '检查认证边界',
      avatar: 'security',
      fork_turns: 'none',
    })) as AgentSummary
    assert.equal(child.avatar, 'security')
    for (const avatar of ['unknown', '', null, 1])
      await assert.rejects(
        context.call(context.root.session, 'spawn_agent', {
          task_name: 'invalid_avatar',
          message: '任务',
          avatar,
          fork_turns: 'none',
        }),
        /头像场景无效/,
      )
    assert.equal((await context.bridge.getAgents('root-key')).length, 2)
    const childSession = context.children.get(child.sessionKey)!
    childSession.finish('审查完成')
    await context.until(
      async () =>
        (await context.bridge.getAgents('root-key')).find((entry) => entry.agentId === child.agentId)!.status ===
        'completed',
    )
    const snapshot = await context.bridge.snapshot('root-key')
    assert.equal(snapshot.agentMessages.find((entry) => entry.fromAgentId === child.agentId)?.avatar, 'security')
    const followup = (await context.call(context.root.session, 'followup_task', {
      target: child.agentId,
      message: '继续检查',
    })) as CollaborationResults['followup_task']
    assert.equal(followup.agent.avatar, 'security')
    const nested = await context.spawn('code', childSession.session)
    assert.equal(nested.avatar, undefined)
  } finally {
    await context.cleanup()
  }
})

test('容量计入等待任务；等待可取消，取消后同树仍可调度', async () => {
  const context = await setup()
  try {
    await context.begin()
    for (const name of ['one', 'two', 'three', 'four']) await context.spawn(name)
    await assert.rejects(context.spawn('five'), /4 个活动/)
    const controller = new AbortController()
    const waiting = context.call(context.root.session, 'wait_agent', { timeout_ms: 60000 }, controller.signal)
    await context.until(async () => (await context.bridge.getAgents('root-key'))[0]!.status === 'waiting_children')
    controller.abort()
    await assert.rejects(waiting, /等待已取消/)
    assert.equal((await context.bridge.getAgents('root-key'))[0]!.status, 'running')
    const first = (await context.bridge.getAgents('root-key')).find((agent) => agent.name === 'one')!
    context.children.get(first.sessionKey)!.finish('结果一')
    await context.until(
      async () =>
        (await context.bridge.getAgents('root-key')).find((agent) => agent.name === 'one')!.status === 'completed',
    )
    await context.spawn('five')
  } finally {
    await context.cleanup()
  }
})

describe('用户插话唤醒父子 Agent 等待，排队输入不唤醒，消费后继续等待', () => {
  for (const childCaller of [false, true])
    for (const queuedBeforeWait of [false, true])
      test(`${childCaller ? '子 Agent' : '根 Agent'}，${queuedBeforeWait ? '等待前' : '等待中'}插话`, async () => {
        const context = await setup()
        const controller = new AbortController()
        const calls: Array<Promise<unknown>> = []
        try {
          await context.begin()
          const parent = childCaller ? await context.spawn('parent') : undefined
          const caller = parent ? context.children.get(parent.sessionKey)! : context.root
          const target = await context.spawn('worker', caller.session)
          const callerKey = parent?.sessionKey ?? 'root-key'
          const queue = (submitted: boolean) =>
            caller.notify.event({
              generation: 1,
              event: {
                type: 'queue_update',
                steering: [
                  { id: 'other-mode', text: '下一轮计划', mode: 'plan' },
                  ...(submitted
                    ? [{ id: 'steer', text: '先回答我的问题', mode: 'default' as const, submitted: true }]
                    : []),
                ],
                followUp: [{ id: 'followup', text: '稍后执行', mode: 'default', submitted: true }],
              },
            })
          const wait = () => {
            const pending = context.call(
              caller.session,
              'wait_agent',
              { targets: [target.agentId], timeout_ms: 5000 },
              controller.signal,
            )
            calls.push(pending)
            return pending
          }
          queue(queuedBeforeWait)
          let result: CollaborationResults['wait_agent'] | undefined
          const waiting = wait().then((value) => {
            result = value as CollaborationResults['wait_agent']
          })
          calls.push(waiting)
          void waiting.catch(() => {})
          if (!queuedBeforeWait) {
            await context.until(async () => {
              const agents = await context.bridge.getAgents('root-key')
              return agents.find((entry) => entry.sessionKey === callerKey)?.status === 'waiting_children'
            })
            await new Promise<void>((resolve) => setTimeout(resolve, 5))
            assert.equal(result, undefined)
            queue(true)
          }
          await context.until(async () => Boolean(result))
          await waiting
          assert.equal(result!.timedOut, false)
          assert.deepEqual(result!.messages, [])
          assert.equal(context.children.get(target.sessionKey)!.state.isStreaming, true)
          queue(false)
          let resumed = false
          const next = wait().then(() => {
            resumed = true
          })
          calls.push(next)
          void next.catch(() => {})
          await context.until(
            async () =>
              (await context.bridge.getAgents('root-key')).find((entry) => entry.sessionKey === callerKey)?.status ===
              'waiting_children',
          )
          await new Promise<void>((resolve) => setTimeout(resolve, 5))
          assert.equal(resumed, false)
          context.children.get(target.sessionKey)!.finish('完成')
          await next
        } finally {
          controller.abort()
          await Promise.allSettled(calls)
          await context.cleanup()
        }
      })
})

test('停止后新轮次不继承未消费插话的等待唤醒状态', async () => {
  const context = await setup()
  const controller = new AbortController()
  let waiting: Promise<unknown> | undefined
  try {
    await context.begin()
    await context.spawn('previous')
    context.root.notify.event({
      generation: 1,
      event: {
        type: 'queue_update',
        steering: [{ id: 'old-steer', text: '旧插话', mode: 'default', submitted: true }],
        followUp: [],
      },
    })
    await context.bridge.stopRoot('root-key')
    await context.begin()
    const child = await context.spawn('worker')
    let resumed = false
    waiting = context
      .call(context.root.session, 'wait_agent', { targets: [child.agentId], timeout_ms: 5000 }, controller.signal)
      .then(() => {
        resumed = true
      })
    void waiting.catch(() => {})
    await context.until(async () => (await context.bridge.getAgents('root-key'))[0]!.status === 'waiting_children')
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
    assert.equal(resumed, false)
    context.children.get(child.sessionKey)!.finish('完成')
    await waiting
  } finally {
    controller.abort()
    if (waiting) await Promise.allSettled([waiting])
    await context.cleanup()
  }
})

test('同请求只创建一次；followup复用身份，忙时排队；idle消息不启动', async () => {
  const context = await setup()
  try {
    await context.begin()
    const request = {
      id: randomUUID(),
      method: 'spawn_agent' as const,
      params: { task_name: 'worker', message: '任务', fork_turns: 'none' as const },
    }
    const [one, two] = (await Promise.all([
      context.bridge.dispatch(context.root.session, request, new AbortController().signal),
      context.bridge.dispatch(context.root.session, request, new AbortController().signal),
    ])) as AgentSummary[]
    assert.equal(one!.agentId, two!.agentId)
    const fake = context.children.get(one!.sessionKey)!
    await context.call(context.root.session, 'followup_task', { target: one!.agentId, message: '排队任务' })
    fake.finish('第一次完成')
    await context.until(async () => fake.prompts.length === 2)
    assert.equal(fake.prompts[1], '排队任务')
    fake.finish('第二次完成')
    await context.until(
      async () =>
        (await context.bridge.getAgents('root-key')).find((agent) => agent.agentId === one!.agentId)!.status ===
        'completed',
    )
    await context.call(context.root.session, 'send_message', { target: one!.agentId, message: '仅存邮箱' })
    assert.equal(fake.prompts.length, 2)
    await context.call(context.root.session, 'followup_task', { target: one!.agentId, message: '第三次任务' })
    assert.equal(fake.prompts.length, 3)
    assert.equal(
      (await context.bridge.getAgents('root-key')).find((agent) => agent.name === 'worker')!.agentId,
      one!.agentId,
    )
  } finally {
    await context.cleanup()
  }
})

test('子结果落盘后立即通知界面，父任务尚未读取时也保留本轮开始时间', async () => {
  const context = await setup()
  let release!: () => void
  context.root.faults.deliveryGate = new Promise<void>((resolve) => {
    release = resolve
  })
  try {
    await context.begin()
    const child = await context.spawn('worker')
    context.children.get(child.sessionKey)!.finish('子任务已完成')
    await context.until(async () =>
      context.events.some((record) => record.event.type === 'agent_mailbox' && record.event.message.kind === 'result'),
    )
    const record = context.events.find(
      (entry) => entry.event.type === 'agent_mailbox' && entry.event.message.kind === 'result',
    )!
    assert.equal(record.sessionKey, 'root-key')
    assert.equal(record.event.type, 'agent_mailbox')
    if (record.event.type !== 'agent_mailbox') return
    const message = record.event.message
    assert.equal(message.startedAt, child.runStartedAt)
    assert.equal(message.runId, child.runId)
    assert.equal(message.status, 'completed')
    assert.equal(context.root.delivered.length, 0)
    const saved = JSON.parse(await readFile(path.join(context.directory, 'collaboration.json'), 'utf8')) as {
      records: Array<{ summary: AgentSummary; mailbox: Array<{ id: string; startedAt?: string }> }>
    }
    const root = saved.records.find((entry) => entry.summary.depth === 0)!
    assert.equal(root.mailbox.find((entry) => entry.id === message.id)?.startedAt, child.runStartedAt)
    release()
    await context.until(async () => context.root.delivered.length === 1)
  } finally {
    release()
    await context.cleanup()
  }
})

test('child先结束轮次，grandchild延迟结果触发同epoch汇总后再交付parent', async () => {
  const context = await setup()
  try {
    await context.begin()
    const child = await context.spawn('parent')
    const childSession = context.children.get(child.sessionKey)!
    const grandchild = await context.spawn('leaf', childSession.session)
    await assert.rejects(context.spawn('deep', context.children.get(grandchild.sessionKey)!.session), /嵌套两层/)
    childSession.finish('等待调查')
    await context.until(
      async () =>
        (await context.bridge.getAgents('root-key')).find((agent) => agent.agentId === child.agentId)!.status ===
        'waiting_children',
    )
    context.children.get(grandchild.sessionKey)!.finish('叶节点完成')
    await context.until(async () => childSession.continuations.length === 1)
    const resumed = (await context.bridge.getAgents('root-key')).find((agent) => agent.agentId === child.agentId)!
    assert.equal(resumed.epoch, child.epoch)
    assert.equal(resumed.rootTaskId, child.rootTaskId)
    assert.notEqual(resumed.runId, child.runId)
    childSession.finish('整理完成')
    await context.until(
      async () =>
        (await context.bridge.getAgents('root-key')).find((agent) => agent.agentId === child.agentId)!.status ===
        'completed',
    )
  } finally {
    await context.cleanup()
  }
})

test('Host 重启绑定根会话使用当前运行时代次，保留子代理身份、头像和代次', async () => {
  const context = await setup()
  let restored: ReturnType<typeof createHostCollaborationBridge> | undefined
  try {
    await context.begin()
    const child = (await context.call(context.root.session, 'spawn_agent', {
      task_name: 'worker',
      message: '验证浏览器行为',
      avatar: 'browser',
      fork_turns: 'none',
    })) as AgentSummary
    const binding = {
      sessionKey: 'root-key',
      cwd: context.directory,
      sessionFile: path.join(context.directory, 'root.jsonl'),
      state: context.root.state,
      accessMode: 'workspace-write' as const,
      session: context.root.session,
    }
    context.root.session.connection = () => ({ cwd: context.directory, generation: 8, status: 'idle' })
    context.bridge.decorateRootEvent('root-key', { generation: 8, event: { type: 'agent_settled' } })
    const original = await context.bridge.bindRoot(binding)
    assert.equal(original.executionGeneration, 8)
    await context.bridge.stopAndWait()
    restored = createHostCollaborationBridge({
      dataRoot: context.directory,
      createSession: () => {
        throw new Error('只读恢复不能创建 Worker')
      },
      emit: () => {},
    })
    const current = fakeSession(context.directory, { connection: () => {}, event: () => {}, error: () => {} })
    current.session.connection = () => ({ cwd: context.directory, generation: 0, status: 'disconnected' })
    await restored.bindRoot({ ...binding, session: current.session })
    const snapshot = await restored.snapshot('root-key')
    assert.equal(snapshot.agent.agentId, original.agentId)
    assert.equal(snapshot.agent.executionGeneration, 0)
    const savedChild = snapshot.agents.find((agent) => agent.agentId === child.agentId)!
    assert.equal(savedChild.avatar, 'browser')
    assert.equal(savedChild.executionGeneration, child.executionGeneration)
    assert.equal(savedChild.rootAgentId, original.agentId)
    current.session.connection = () => ({ cwd: context.directory, generation: 1, status: 'ready' })
    const event = restored.decorateRootEvent('root-key', {
      generation: 1,
      executionGeneration: 1,
      event: { type: 'agent_settled' },
    })
    assert.equal(event.executionGeneration, 1)
    await restored.bindRoot({ ...binding, session: current.session })
    assert.equal((await restored.snapshot('root-key')).agent.executionGeneration, 1)
  } finally {
    await restored?.stopAndWait()
    await context.cleanup()
  }
})

test('旧epoch结果持久可见但不唤醒新用户任务；restart标interrupted且只读snapshot不创建Worker', async () => {
  const context = await setup()
  try {
    await context.begin()
    const child = await context.spawn('old')
    await context.begin('plan')
    context.children.get(child.sessionKey)!.finish('旧任务结果')
    await context.until(
      async () =>
        (await context.bridge.getAgents('root-key')).find((agent) => agent.agentId === child.agentId)!.status ===
        'completed',
    )
    const snapshot = await context.bridge.snapshot('root-key')
    assert.ok(snapshot.agentMessages.some((message) => message.text === '旧任务结果'))
    assert.equal(context.root.continuations.length, 0)
    await context.spawn('unfinished')
    let creations = 0
    let allowCreation = false
    const restored = createHostCollaborationBridge({
      dataRoot: context.directory,
      createSession: (cwd, notify) => {
        creations += 1
        if (!allowCreation) throw new Error('不可创建Worker')
        return fakeSession(cwd, notify).session
      },
      emit: () => {},
    })
    const agents = await restored.getAgents('root-key')
    assert.equal(agents.find((agent) => agent.name === 'unfinished')!.status, 'interrupted')
    await restored.getAgentSnapshot(child.agentId)
    assert.equal(creations, 0)
    allowCreation = true
    await restored.bindRoot({
      sessionKey: 'root-key',
      cwd: context.directory,
      state: context.root.state,
      accessMode: 'workspace-write',
      session: context.root.session,
    })
    await restored.beginRootRun('root-key', { mode: 'plan', message: '重启后继续' })
    const unfinished = agents.find((agent) => agent.name === 'unfinished')!
    const followup = (await restored.dispatch(
      context.root.session,
      { id: randomUUID(), method: 'followup_task', params: { target: unfinished.agentId, message: '明确恢复' } },
      new AbortController().signal,
    )) as { agent: AgentSummary }
    assert.equal(followup.agent.executionGeneration, unfinished.executionGeneration + 1)
    assert.equal(creations, 1)
    await restored.stopAndWait()
  } finally {
    await context.cleanup()
  }
})

test('queued followup的wait等待预定新run，不被旧run完成结果提前满足', async () => {
  const context = await setup()
  try {
    await context.begin()
    const child = await context.spawn('worker')
    const fake = context.children.get(child.sessionKey)!
    await context.call(context.root.session, 'followup_task', { target: child.agentId, message: '下一轮' })
    let answered = false
    const waiting = context
      .call(context.root.session, 'wait_agent', { targets: [child.agentId], timeout_ms: 5000 })
      .then((result) => {
        answered = true
        return result
      })
    await context.until(async () => (await context.bridge.getAgents('root-key'))[0]!.status === 'waiting_children')
    fake.finish('旧轮结果')
    await context.until(async () => fake.prompts.length === 2)
    assert.equal(answered, false)
    fake.finish('新轮结果')
    await waiting
    assert.equal(answered, true)
  } finally {
    await context.cleanup()
  }
})

test('自动汇总准入失败转failed并保留未读取结果，释放容量供后续用户任务', async () => {
  const context = await setup()
  try {
    await context.begin()
    const child = await context.spawn('worker')
    context.root.faults.continuation = true
    await context.bridge.rootSettled('root-key')
    context.children.get(child.sessionKey)!.finish('结果正文')
    await context.until(async () => {
      const saved = JSON.parse(await readFile(path.join(context.directory, 'collaboration.json'), 'utf8'))
      return (
        saved.records.find((record: { summary: AgentSummary }) => record.summary.depth === 0)?.summary.status ===
        'failed'
      )
    })
    const persisted = JSON.parse(await readFile(path.join(context.directory, 'collaboration.json'), 'utf8')) as {
      records: Array<{ summary: AgentSummary; consumed: string[]; mailbox: Array<{ id: string }> }>
    }
    const root = persisted.records.find((record) => record.summary.depth === 0)!
    assert.ok(!root.consumed.includes(root.mailbox[0]!.id))
    assert.equal(root.summary.status, 'failed')
    context.root.faults.continuation = false
    await context.begin()
    assert.equal(context.root.continuations.length, 0)
    assert.equal(context.root.delivered.length, 1)
  } finally {
    await context.cleanup()
  }
})

test('自动汇总来源交付期间新用户epoch撤销旧resume；迟到旧settled不结束新run', async () => {
  const context = await setup()
  try {
    await context.begin()
    const oldRoot = (await context.bridge.getAgents('root-key'))[0]!
    const child = await context.spawn('worker')
    let release!: () => void
    context.root.faults.deliveryGate = new Promise<void>((resolve) => {
      release = resolve
    })
    await context.bridge.rootSettled('root-key')
    context.children.get(child.sessionKey)!.finish('旧结果')
    await context.until(async () => (await context.bridge.getAgents('root-key'))[0]!.status === 'running')
    await context.begin('plan')
    const current = (await context.bridge.getAgents('root-key'))[0]!
    release()
    await context.bridge.rootSettled('root-key', { runId: oldRoot.runId })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(context.root.continuations.length, 0)
    const after = (await context.bridge.getAgents('root-key'))[0]!
    assert.equal(after.epoch, current.epoch)
    assert.equal(after.runId, current.runId)
    assert.equal(after.status, 'running')
  } finally {
    await context.cleanup()
  }
})

test('新用户任务撤销整树多条旧followup，旧run继续但结果不唤醒新任务', async () => {
  const context = await setup()
  try {
    await context.begin()
    const child = await context.spawn('worker')
    const fake = context.children.get(child.sessionKey)!
    for (const message of ['旧队列一', '旧队列二', '旧队列三'])
      await context.call(context.root.session, 'followup_task', { target: child.agentId, message })
    await context.begin('plan')
    assert.equal(
      (await context.bridge.getAgents('root-key')).find((entry) => entry.agentId === child.agentId)!.status,
      'running',
    )
    fake.finish('旧结果')
    await context.until(
      async () =>
        (await context.bridge.getAgents('root-key')).find((entry) => entry.agentId === child.agentId)!.status ===
        'completed',
    )
    assert.deepEqual(fake.prompts, ['子任务'])
    assert.equal(context.root.continuations.length, 0)
    const stored = JSON.parse(await readFile(path.join(context.directory, 'collaboration.json'), 'utf8'))
    assert.ok(stored.records.every((record: { queued: unknown[] }) => record.queued.length === 0))
    assert.ok((await context.bridge.snapshot('root-key')).agentMessages.some((message) => message.text === '旧结果'))
    await context.bridge.rootSettled('root-key')
    await context.bridge.waitForIdle()
    await context.bridge.retireSessions([child.sessionKey])
  } finally {
    await context.cleanup()
  }
})

test('Worker退役后followup递增持久代次，丢弃旧Worker事件；问答列表与快照同步', async () => {
  const context = await setup()
  try {
    await context.begin()
    const child = await context.spawn('worker')
    const old = context.children.get(child.sessionKey)!
    old.finish('结束')
    await context.until(
      async () =>
        (await context.bridge.getAgents('root-key')).find((entry) => entry.agentId === child.agentId)!.status ===
        'completed',
    )
    await context.until(async () => context.root.delivered.length > 0)
    await context.bridge.rootSettled('root-key')
    await context.bridge.retireSessions([child.sessionKey])
    await context.begin()
    await context.call(context.root.session, 'followup_task', { target: child.agentId, message: '新任务' })
    const current = (await context.bridge.getAgents('root-key')).find((entry) => entry.agentId === child.agentId)!
    assert.equal(current.executionGeneration, child.executionGeneration + 1)
    const count = context.events.length
    old.notify.event({ generation: 1, event: { type: 'agent_settled' } })
    assert.equal(context.events.length, count)
    const active = context.children.get(child.sessionKey)!
    active.notify.event({
      generation: 1,
      event: { type: 'extension_ui_request', id: 'question', method: 'input', title: '问题' },
    })
    const update = context.events.filter((event) => event.event.type === 'agents_update').at(-1)!
    assert.equal(
      update.event.type === 'agents_update' &&
        update.event.agents.find((agent) => agent.agentId === child.agentId)!.status,
      'waiting_input',
    )
    assert.equal(
      (await context.bridge.getAgentSnapshot(child.agentId)).connection.generation,
      current.executionGeneration,
    )
    assert.equal(
      (await context.bridge.snapshot('root-key')).agents.find((entry) => entry.agentId === child.agentId)!.status,
      'waiting_input',
    )
    active.notify.event({ generation: 1, event: { type: 'extension_ui_closed', id: 'question', reason: 'answered' } })
    assert.equal(
      (await context.bridge.getAgents('root-key')).find((entry) => entry.agentId === child.agentId)!.status,
      'running',
    )
    assert.equal(
      context.events.filter((event) => event.event.type === 'agents_update').at(-1)!.event.type,
      'agents_update',
    )
  } finally {
    await context.cleanup()
  }
})

test('idle来源消息在后续新task followup中写真实Pi JSONL，保留旧来源且不重复交付', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-collaboration-native-'))
  const fake = await useFakeAgent(directory)
  const sessions = new Map<string, SdkSession>()
  const bridge = createHostCollaborationBridge({
    dataRoot: directory,
    emit: () => {},
    createSession: (cwd, notify, key) => {
      const session = new SdkSession(cwd, notify, fake.runtimePaths, fake.credentials)
      sessions.set(key, session)
      return session
    },
  })
  const root = fakeSession(directory, {
    connection: () => {},
    error: () => {},
    event: (event) => {
      bridge.decorateRootEvent('root', event)
    },
  })
  root.state.model = { provider: 'fake', id: 'first' }
  const call = (method: CollaborationRequest['method'], params: unknown) =>
    bridge.dispatch(
      root.session,
      { id: randomUUID(), method, params } as CollaborationRequest,
      new AbortController().signal,
    )
  const completed = async (id: string) => {
    const deadline = Date.now() + 5000
    while ((await bridge.getAgents('root')).find((agent) => agent.agentId === id)?.status !== 'completed') {
      if (Date.now() > deadline) throw new Error('真实Pi子任务未完成')
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
    }
  }
  try {
    await bridge.bindRoot({
      sessionKey: 'root',
      cwd: directory,
      state: root.state,
      accessMode: 'full-access',
      session: root.session,
    })
    await bridge.beginRootRun('root', { mode: 'default', message: '旧任务' })
    const child = (await call('spawn_agent', {
      task_name: 'worker',
      message: '第一次任务',
      fork_turns: 'none',
    })) as AgentSummary
    await completed(child.agentId)
    const sent = (await call('send_message', { target: child.agentId, message: '来自旧任务的补充信息' })) as {
      messageId: string
    }
    assert.equal(fake.provider.requests.length, 1)
    await bridge.beginRootRun('root', { mode: 'default', message: '新用户任务' })
    await call('followup_task', { target: child.agentId, message: '明确继续' })
    await completed(child.agentId)
    const active = sessions.get(child.sessionKey)!.getActiveSession()
    const entries = (await readFile(active.sessionFile!, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const sources = entries.filter(
      (entry) => entry.type === 'custom_message' && entry.details?.messageId === sent.messageId,
    )
    assert.equal(sources.length, 1)
    assert.equal(sources[0].content, `[来自 ${child.parentAgentId}] 来自旧任务的补充信息`)
    assert.equal(sources[0].details.fromAgentId, child.parentAgentId)
    assert.equal(sources[0].details.rootTaskId, child.rootTaskId)
    await call('followup_task', { target: child.agentId, message: '再继续一次' })
    await completed(child.agentId)
    const finalEntries = (await readFile(active.sessionFile!, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.equal(finalEntries.filter((entry) => entry.details?.messageId === sent.messageId).length, 1)
  } finally {
    await bridge.stopAndWait()
    await fake.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('子任务启动snapshot和父汇总来源交付期间stop都不会重新prompt或覆盖stopped', async () => {
  const context = await setup()
  try {
    await context.begin()
    let release!: () => void
    context.creationFaults.snapshotGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const spawning = context.spawn('blocked')
    await context.until(async () => context.children.size === 1)
    await context.bridge.stopRoot('root-key')
    const fake = [...context.children.values()][0]!
    release()
    await assert.rejects(spawning, /启动已取消/)
    assert.equal(fake.prompts.length, 0)
    context.creationFaults.snapshotGate = undefined
    await context.begin()
    const child = await context.spawn('worker')
    context.root.faults.deliveryGate = new Promise<void>((resolve) => {
      release = resolve
    })
    await context.bridge.rootSettled('root-key')
    context.children.get(child.sessionKey)!.finish('结果')
    await context.until(async () => (await context.bridge.getAgents('root-key'))[0]!.status === 'running')
    await context.bridge.stopRoot('root-key')
    const runId = (await context.bridge.getAgents('root-key'))[0]!.runId
    release()
    await context.bridge.rootFailed('root-key', new Error('迟到失败'), runId)
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    assert.equal(context.root.continuations.length, 0)
    assert.equal((await context.bridge.getAgents('root-key'))[0]!.status, 'stopped')
  } finally {
    await context.cleanup()
  }
})

test('forkall保留模型父上下文但child详情只显示自身任务，followup及旧身份重启边界可恢复', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-agent-origin-'))
  const fake = await useFakeAgent(directory)
  const children = new Map<string, SdkSession>()
  const bridge = createHostCollaborationBridge({
    dataRoot: directory,
    emit: () => {},
    createSession: (cwd, notify, key) => {
      const session = new SdkSession(cwd, notify, fake.runtimePaths, fake.credentials)
      children.set(key, session)
      return session
    },
  })
  const root = new SdkSession(
    directory,
    {
      connection: () => {},
      error: () => {},
      event: (event) => {
        bridge.decorateRootEvent('root', event)
      },
    },
    fake.runtimePaths,
    fake.credentials,
  )
  const parentText = '父专属指令：创建3个子代理，各执行一个独立任务'
  const ownText = '子专属任务：分析alpha，不重复父委派'
  const wait = async (predicate: () => Promise<boolean>) => {
    const deadline = Date.now() + 5000
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error('真实child边界测试未完成')
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
    }
  }
  const call = (method: CollaborationRequest['method'], params: unknown) =>
    bridge.dispatch(root, { id: randomUUID(), method, params } as CollaborationRequest, new AbortController().signal)
  let restored: ReturnType<typeof createHostCollaborationBridge> | undefined
  try {
    root.start(directory)
    await root.snapshot()
    await root.setModel({ provider: 'fake', id: 'first' })
    await root.prompt(parentText)
    await wait(async () => !(await root.snapshot()).state.isStreaming)
    const rootSnapshot = await root.snapshot()
    await bridge.bindRoot({
      sessionKey: 'root',
      cwd: directory,
      state: rootSnapshot.state,
      accessMode: 'full-access',
      session: root,
      ...root.getActiveSession(),
    })
    await bridge.beginRootRun('root', { mode: 'default', message: parentText })
    const child = (await call('spawn_agent', {
      task_name: 'alpha',
      message: ownText,
      fork_turns: 'all',
    })) as AgentSummary
    await wait(
      async () =>
        (await bridge.getAgents('root')).find((agent) => agent.agentId === child.agentId)?.status === 'completed',
    )
    const childRequest = JSON.stringify(fake.provider.requests[1])
    assert.ok(childRequest.includes(parentText))
    assert.ok(childRequest.includes(ownText))
    assert.ok(childRequest.includes('继承的父会话是背景'))
    assert.ok(child.conversationOrigin!.inheritedEntryIds.length > 0)
    const view = await bridge.getAgentSnapshot(child.agentId)
    assert.equal(view.messages.filter((message) => message.role === 'user').length, 1)
    assert.ok(!JSON.stringify(view.messages).includes(parentText))
    assert.ok(
      !view.sessionEntries!.entries.some((entry) => child.conversationOrigin!.inheritedEntryIds.includes(entry.id)),
    )
    await call('followup_task', { target: child.agentId, message: '后续任务：保留child首轮' })
    await wait(
      async () =>
        (await bridge.getAgents('root')).find((agent) => agent.agentId === child.agentId)?.status === 'completed',
    )
    assert.equal(
      (await bridge.getAgentSnapshot(child.agentId)).messages.filter((message) => message.role === 'user').length,
      2,
    )
    const none = (await call('spawn_agent', {
      task_name: 'none',
      message: '新上下文任务',
      fork_turns: 'none',
    })) as AgentSummary
    await wait(
      async () =>
        (await bridge.getAgents('root')).find((agent) => agent.agentId === none.agentId)?.status === 'completed',
    )
    assert.deepEqual(none.conversationOrigin, {
      parentAgentId: none.parentAgentId,
      inheritedLeafId: null,
      inheritedEntryIds: [],
    })
    assert.equal(
      (await bridge.getAgentSnapshot(none.agentId)).messages.filter((message) => message.role === 'user').length,
      1,
    )
    await bridge.stopAndWait()
    const record = (
      bridge as unknown as { records: Map<string, { summary: AgentSummary; session?: RuntimeSdkSession }> }
    ).records.get(child.agentId)!
    delete record.summary.conversationOrigin
    let disconnectedRequests = 0
    const disconnected = record.session!
    record.session = new Proxy(disconnected, {
      get: (target, property) => {
        if (property === 'configureAgentTask' || property === 'start')
          return () => {
            disconnectedRequests++
            throw new Error('disconnected查看详情不得发送懒启动RPC')
          }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    assert.equal(
      (await bridge.getAgentSnapshot(child.agentId)).messages.filter((message) => message.role === 'user').length,
      2,
    )
    assert.equal(disconnectedRequests, 0)
    const file = path.join(directory, 'collaboration.json')
    const saved = JSON.parse(await readFile(file, 'utf8'))
    const savedChild = saved.records.find(
      (record: { summary: AgentSummary }) => record.summary.agentId === child.agentId,
    )
    delete savedChild.summary.conversationOrigin
    await writeFile(file, JSON.stringify(saved))
    const before = await readFile(child.sessionFile!, 'utf8')
    restored = createHostCollaborationBridge({
      dataRoot: directory,
      emit: () => {},
      createSession: () => {
        throw new Error('只读恢复不能创建Worker')
      },
    })
    const after = await restored.getAgentSnapshot(child.agentId)
    assert.equal(after.messages.filter((message) => message.role === 'user').length, 2)
    assert.ok(!JSON.stringify(after.messages).includes(parentText))
    assert.ok(after.agent!.conversationOrigin!.inheritedEntryIds.length > 0)
    assert.equal(await readFile(child.sessionFile!, 'utf8'), before)
  } finally {
    await restored?.stopAndWait()
    await bridge.stopAndWait()
    await root.stopAndWait()
    await fake.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('forknone首条assistant落盘前读取live详情不读不存在的JSONL，空继承边界停后和重启仍保留', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-agent-none-unflushed-'))
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const entering = new Promise<void>((resolve) => {
    entered = resolve
  })
  const fake = await useFakeAgent(directory, { reply: { text: '子任务完成', delayMs: 100 } })
  let created = 0
  const bridge = createHostCollaborationBridge({
    dataRoot: directory,
    emit: () => {},
    createSession: (cwd, notify) => {
      created++
      return new SdkSession(cwd, notify, fake.runtimePaths, fake.credentials, undefined, {
        onAdmission: async () => {
          entered()
          await gate
        },
      })
    },
  })
  const root = new SdkSession(
    directory,
    { connection: () => {}, error: () => {}, event: (event) => bridge.decorateRootEvent('root', event) },
    fake.runtimePaths,
    fake.credentials,
  )
  let restored: ReturnType<typeof createHostCollaborationBridge> | undefined
  try {
    root.start(directory)
    await root.snapshot()
    await root.setModel({ provider: 'fake', id: 'first' })
    await bridge.bindRoot({
      sessionKey: 'root',
      cwd: directory,
      state: (await root.snapshot()).state,
      accessMode: 'full-access',
      session: root,
      ...root.getActiveSession(),
    })
    await bridge.beginRootRun('root', { mode: 'default', message: '委派空上下文任务' })
    const spawning = bridge.dispatch(
      root,
      {
        id: randomUUID(),
        method: 'spawn_agent',
        params: { task_name: 'none', message: '子任务原文', fork_turns: 'none' },
      },
      new AbortController().signal,
    )
    await entering
    const child = (await bridge.getAgents('root')).find((agent) => agent.name === 'none')!
    assert.ok(child.sessionFile)
    await assert.rejects(readFile(child.sessionFile), /ENOENT/)
    const live = await bridge.getAgentSnapshot(child.agentId)
    assert.equal(created, 1)
    assert.equal(live.agent!.status, 'running')
    assert.equal(live.messages.length, 0)
    assert.deepEqual(live.agent!.conversationOrigin, {
      parentAgentId: child.parentAgentId,
      inheritedLeafId: null,
      inheritedEntryIds: [],
    })
    release()
    await spawning
    assert.match(JSON.stringify((await bridge.getAgentSnapshot(child.agentId)).messages), /子任务原文/)
    const deadline = Date.now() + 5000
    while ((await bridge.getAgentSnapshot(child.agentId)).state.isStreaming) {
      if (Date.now() > deadline) throw new Error('无继承子任务没有完成')
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
    }
    const completed = await bridge.getAgentSnapshot(child.agentId)
    assert.match(JSON.stringify(completed.messages), /子任务完成/)
    await bridge.stopAndWait()
    assert.deepEqual((await bridge.getAgentSnapshot(child.agentId)).messages, completed.messages)
    restored = createHostCollaborationBridge({
      dataRoot: directory,
      emit: () => {},
      createSession: () => {
        throw new Error('读取持久无继承详情不得创建Worker')
      },
    })
    const recovered = await restored.getAgentSnapshot(child.agentId)
    assert.deepEqual(recovered.messages, completed.messages)
    assert.deepEqual(recovered.agent!.conversationOrigin, live.agent!.conversationOrigin)
  } finally {
    release()
    await restored?.stopAndWait()
    await bridge.stopAndWait()
    await root.stopAndWait()
    await fake.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

describe('forknone模型首响应前interrupt或Host停止后，原生用户记录可离线恢复且重启不启动Worker', () => {
  for (const action of ['interrupt', 'stop'])
    test(action, async () => {
      const directory = await mkdtemp(path.join(tmpdir(), 'pi-agent-none-stop-'))
      let release!: () => void
      let entered!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const entering = new Promise<void>((resolve) => {
        entered = resolve
      })
      const fake = await useFakeAgent(directory, {
        reply: async () => {
          entered()
          await gate
          return '不应收到的首响应'
        },
      })
      const bridge = createHostCollaborationBridge({
        dataRoot: directory,
        emit: () => {},
        createSession: (cwd, notify) => new SdkSession(cwd, notify, fake.runtimePaths, fake.credentials),
      })
      const root = new SdkSession(
        directory,
        { connection: () => {}, error: () => {}, event: (event) => bridge.decorateRootEvent('root', event) },
        fake.runtimePaths,
        fake.credentials,
      )
      let restored: ReturnType<typeof createHostCollaborationBridge> | undefined
      try {
        root.start(directory)
        await root.snapshot()
        await root.setModel({ provider: 'fake', id: 'first' })
        await bridge.bindRoot({
          sessionKey: 'root',
          cwd: directory,
          state: (await root.snapshot()).state,
          accessMode: 'full-access',
          session: root,
          ...root.getActiveSession(),
        })
        await bridge.beginRootRun('root', { mode: 'default', message: '委派并等待' })
        const child = (await bridge.dispatch(
          root,
          {
            id: randomUUID(),
            method: 'spawn_agent',
            params: { task_name: 'none', message: '停止前的子任务', fork_turns: 'none' },
          },
          new AbortController().signal,
        )) as AgentSummary
        await entering
        const before = (await readFile(child.sessionFile!, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
        assert.equal(before.filter((entry) => entry.type === 'message' && entry.message.role === 'user').length, 1)
        assert.equal(before.filter((entry) => entry.type === 'message' && entry.message.role === 'assistant').length, 0)
        if (action === 'interrupt')
          await bridge.dispatch(
            root,
            { id: randomUUID(), method: 'interrupt_agent', params: { target: child.agentId } },
            new AbortController().signal,
          )
        await bridge.stopAndWait()
        const stopped = await bridge.getAgentSnapshot(child.agentId)
        assert.equal(stopped.state.isStreaming, false)
        assert.equal(stopped.messages.filter((message) => message.role === 'user').length, 1)
        assert.match(JSON.stringify(stopped.messages), /停止前的子任务/)
        restored = createHostCollaborationBridge({
          dataRoot: directory,
          emit: () => {},
          createSession: () => {
            throw new Error('停止后读取不得启动Worker')
          },
        })
        const recovered = await restored.getAgentSnapshot(child.agentId)
        assert.deepEqual(recovered.messages, stopped.messages)
        assert.deepEqual(recovered.agent!.conversationOrigin, stopped.agent!.conversationOrigin)
        await rm(child.sessionFile!)
        await assert.rejects(restored.getAgentSnapshot(child.agentId), /ENOENT/)
      } finally {
        release()
        await restored?.stopAndWait()
        await bridge.stopAndWait()
        await root.stopAndWait()
        await fake.dispose()
        await rm(directory, { recursive: true, force: true })
      }
    })
})

test('forknone无文件的准入预约被中断时撤销身份，重启不残留不可读取的子会话', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-agent-none-admission-stop-'))
  const fake = await useFakeAgent(directory)
  let entered!: () => void
  const entering = new Promise<void>((resolve) => {
    entered = resolve
  })
  const bridge = createHostCollaborationBridge({
    dataRoot: directory,
    emit: () => {},
    createSession: (cwd, notify) =>
      new SdkSession(cwd, notify, fake.runtimePaths, fake.credentials, undefined, {
        onAdmission: async (_message, _mode, _continuation, signal) => {
          entered()
          await new Promise<void>((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(new Error('准入已取消')), { once: true }),
          )
        },
      }),
  })
  const root = new SdkSession(
    directory,
    { connection: () => {}, error: () => {}, event: (event) => bridge.decorateRootEvent('root', event) },
    fake.runtimePaths,
    fake.credentials,
  )
  let restored: ReturnType<typeof createHostCollaborationBridge> | undefined
  try {
    root.start(directory)
    await root.snapshot()
    await root.setModel({ provider: 'fake', id: 'first' })
    await bridge.bindRoot({
      sessionKey: 'root',
      cwd: directory,
      state: (await root.snapshot()).state,
      accessMode: 'full-access',
      session: root,
      ...root.getActiveSession(),
    })
    await bridge.beginRootRun('root', { mode: 'default', message: '委派但取消准入' })
    const spawning = bridge
      .dispatch(
        root,
        {
          id: randomUUID(),
          method: 'spawn_agent',
          params: { task_name: 'none', message: '尚未准入', fork_turns: 'none' },
        },
        new AbortController().signal,
      )
      .catch((cause: unknown) => cause)
    await entering
    const child = (await bridge.getAgents('root')).find((agent) => agent.name === 'none')!
    await assert.rejects(readFile(child.sessionFile!), /ENOENT/)
    await bridge.dispatch(
      root,
      { id: randomUUID(), method: 'interrupt_agent', params: { target: child.agentId } },
      new AbortController().signal,
    )
    assert.match(String(await spawning), /准入已取消/)
    assert.ok(!(await bridge.getAgents('root')).some((agent) => agent.agentId === child.agentId))
    await bridge.stopAndWait()
    restored = createHostCollaborationBridge({
      dataRoot: directory,
      emit: () => {},
      createSession: () => {
        throw new Error('预约取消后不能启动Worker')
      },
    })
    assert.ok(!(await restored.getAgents('root')).some((agent) => agent.agentId === child.agentId))
    assert.equal(fake.provider.requests.length, 0)
  } finally {
    await restored?.stopAndWait()
    await bridge.stopAndWait()
    await root.stopAndWait()
    await fake.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('checkout gate 阻止新子代理与已有 Worker followup，busy 包含排队与等待任务', async () => {
  let locked = false
  const context = await setup(() => {
    if (locked) throw new Error('工作目录正在切换分支')
  })
  try {
    await context.begin()
    const child = await context.spawn('worker')
    assert.throws(() => context.bridge.assertCheckoutIdle(() => true), /运行中的子任务/)
    locked = true
    await assert.rejects(context.spawn('blocked'), /正在切换分支/)
    await assert.rejects(
      context.call(context.root.session, 'followup_task', { target: child.agentId, message: '不能排队' }),
      /正在切换分支/,
    )
    locked = false
    context.children.get(child.sessionKey)!.finish('结果')
    await context.until(
      async () =>
        (await context.bridge.getAgents('root-key')).find((agent) => agent.agentId === child.agentId)!.status ===
        'completed',
    )
    locked = true
    await assert.rejects(
      context.call(context.root.session, 'followup_task', { target: child.agentId, message: '不能复用' }),
      /正在切换分支/,
    )
  } finally {
    await context.cleanup()
  }
})

test('整树暂停不等待 wait_agent，恢复保持当前运行身份', async () => {
  const context = await setup()
  try {
    await context.begin()
    const child = await context.spawn('worker')
    const before = await context.bridge.getAgents('root-key')
    const waiting = context.call(context.root.session, 'wait_agent', { targets: ['worker'], timeout_ms: 10000 })
    await context.until(async () => (await context.bridge.getAgents('root-key'))[0]!.status === 'waiting_children')
    await context.bridge.pauseRoot('root-key')
    const worker = context.children.get(child.sessionKey)!
    assert.equal(context.root.state.isPaused, true)
    assert.equal(worker.state.isPaused, true)
    assert.equal(worker.prompts.length, 1)
    await context.bridge.resumeRoot('root-key')
    const after = await context.bridge.getAgents('root-key')
    for (const agent of after) {
      const previous = before.find((entry) => entry.agentId === agent.agentId)!
      assert.equal(agent.runId, previous.runId)
      assert.equal(agent.rootTaskId, previous.rootTaskId)
      assert.equal(agent.epoch, previous.epoch)
    }
    assert.equal(worker.prompts.length, 1)
    assert.equal(worker.continuations.length, 0)
    worker.finish('完成')
    await waiting
  } finally {
    await context.cleanup()
  }
})

test('暂停时子结果留在邮箱，spawn 和 followup 返回后恢复按序启动', async () => {
  const context = await setup()
  try {
    await context.begin()
    const child = await context.spawn('worker')
    const worker = context.children.get(child.sessionKey)!
    await context.bridge.pauseRoot('root-key')
    worker.finish('结果')
    await context.until(
      async () =>
        (await context.bridge.getAgents('root-key')).find((agent) => agent.agentId === child.agentId)?.status ===
        'completed',
    )
    assert.equal(context.root.delivered.length, 0)
    assert.equal(context.root.continuations.length, 0)
    const fresh = await context.spawn('queued_worker')
    assert.equal(context.children.has(fresh.sessionKey), false)
    await context.call(context.root.session, 'followup_task', { target: 'queued_worker', message: '第二轮' })
    await context.bridge.resumeRoot('root-key')
    await context.until(async () => context.children.get(fresh.sessionKey)?.prompts.length === 1)
    const freshWorker = context.children.get(fresh.sessionKey)!
    assert.deepEqual(freshWorker.prompts, ['子任务'])
    freshWorker.finish('首轮完成')
    await context.until(async () => freshWorker.prompts.length === 2)
    assert.deepEqual(freshWorker.prompts, ['子任务', '第二轮'])
    await context.until(async () => context.root.delivered.length > 0)
  } finally {
    await context.cleanup()
  }
})

test('启动交错暂停保留待启动轮次，旧暂停确认不覆盖恢复', async () => {
  const context = await setup()
  let releaseSnapshot!: () => void
  let releasePause!: () => void
  try {
    await context.begin()
    context.creationFaults.snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve
    })
    const spawning = context.spawn('worker')
    await context.until(async () => context.children.size === 1)
    const worker = [...context.children.values()][0]!
    worker.faults.pauseGate = new Promise<void>((resolve) => {
      releasePause = resolve
    })
    const pausing = context.bridge.pauseRoot('root-key')
    await context.until(async () => worker.state.isPaused === true)
    worker.faults.pauseGate = undefined
    await context.bridge.resumeRoot('root-key')
    releasePause()
    await pausing
    assert.equal(worker.state.isPaused, false)
    await context.bridge.pauseRoot('root-key')
    releaseSnapshot()
    const child = await spawning
    assert.deepEqual(worker.prompts, [])
    context.creationFaults.snapshotGate = undefined
    await context.bridge.resumeRoot('root-key')
    await context.until(async () => worker.prompts.length === 1)
    const resumed = (await context.bridge.getAgents('root-key')).find((agent) => agent.agentId === child.agentId)!
    assert.equal(resumed.runId, child.runId)
    assert.equal(resumed.epoch, child.epoch)
  } finally {
    releaseSnapshot?.()
    releasePause?.()
    await context.cleanup()
  }
})

test('停止暂停树释放门闸并取消待启动任务，暂停状态不持久化', async () => {
  const context = await setup()
  try {
    await context.begin()
    const child = await context.spawn('worker')
    await context.bridge.pauseRoot('root-key')
    const queued = await context.spawn('queued_worker')
    await context.bridge.stopRoot('root-key')
    assert.equal(context.root.state.isPaused, false)
    assert.equal(context.children.get(child.sessionKey)!.state.isPaused, false)
    await context.bridge.resumeRoot('root-key')
    assert.equal(context.children.has(queued.sessionKey), false)
    const saved = JSON.parse(await readFile(path.join(context.directory, 'collaboration.json'), 'utf8'))
    assert.ok(
      saved.records.every(
        (record: { summary: AgentSummary; pauseRequested?: boolean }) =>
          !record.summary.isPaused && !record.pauseRequested,
      ),
    )
  } finally {
    await context.cleanup()
  }
})

test('新的根轮次撤销暂停中尚未启动的旧子任务', async () => {
  const context = await setup()
  try {
    await context.begin()
    await context.bridge.pauseRoot('root-key')
    const child = await context.spawn('old_worker')
    await context.begin()
    await context.bridge.resumeRoot('root-key')
    await context.until(
      async () =>
        (await context.bridge.getAgents('root-key')).find((agent) => agent.agentId === child.agentId)?.status ===
        'interrupted',
    )
    assert.equal(context.children.has(child.sessionKey), false)
  } finally {
    await context.cleanup()
  }
})

test('恢复待启动任务与停止交错时，迟到启动失败不覆盖停止状态', async () => {
  const context = await setup()
  let releaseSnapshot!: () => void
  try {
    await context.begin()
    await context.bridge.pauseRoot('root-key')
    const child = await context.spawn('worker')
    context.creationFaults.snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve
    })
    await context.bridge.resumeRoot('root-key')
    await context.until(async () => context.children.has(child.sessionKey))
    await context.bridge.stopRoot('root-key')
    releaseSnapshot()
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    const stopped = await context.bridge.getAgents('root-key')
    assert.equal(stopped[0]!.status, 'stopped')
    assert.equal(stopped.find((agent) => agent.agentId === child.agentId)!.status, 'interrupted')
    assert.equal(stopped.find((agent) => agent.agentId === child.agentId)!.error, undefined)
    assert.deepEqual(context.children.get(child.sessionKey)!.prompts, [])
  } finally {
    releaseSnapshot?.()
    await context.cleanup()
  }
})

test('快速暂停恢复在待启动记录保存期间交错，drainer 不漏掉恢复唤醒', async () => {
  const context = await setup()
  const control = context.bridge as unknown as {
    persist: () => Promise<void>
    records: Map<string, { pendingStart?: unknown }>
  }
  const persist = control.persist
  let releaseSnapshot!: () => void
  let releasePersist!: () => void
  let enteredPersist!: () => void
  const entered = new Promise<void>((resolve) => {
    enteredPersist = resolve
  })
  const gate = new Promise<void>((resolve) => {
    releasePersist = resolve
  })
  let blocked = false
  try {
    await context.begin()
    await context.bridge.pauseRoot('root-key')
    const child = await context.spawn('worker')
    context.creationFaults.snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve
    })
    await context.bridge.resumeRoot('root-key')
    await context.until(async () => context.children.has(child.sessionKey))
    await context.bridge.pauseRoot('root-key')
    control.persist = async () => {
      const writing = persist.call(context.bridge)
      if (!blocked && control.records.get(child.agentId)?.pendingStart) {
        blocked = true
        enteredPersist()
        await gate
      }
      await writing
    }
    releaseSnapshot()
    await entered
    await context.bridge.resumeRoot('root-key')
    releasePersist()
    await context.until(async () => context.children.get(child.sessionKey)!.prompts.length === 1)
    const resumed = (await context.bridge.getAgents('root-key')).find((agent) => agent.agentId === child.agentId)!
    assert.equal(resumed.runId, child.runId)
    assert.equal(resumed.epoch, child.epoch)
    assert.deepEqual(context.children.get(child.sessionKey)!.prompts, ['子任务'])
  } finally {
    releaseSnapshot?.()
    releasePersist()
    control.persist = persist
    await context.cleanup()
  }
})
