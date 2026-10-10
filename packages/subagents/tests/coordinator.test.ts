import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createHostCollaborationBridge } from '../src/server/coordinator'
import type { RuntimeSdkSession } from '@pi-meme/pi-runtime/session-pool'
import type { DesktopEvent, Snapshot } from '@pi-meme/contracts/desktop'
import type { CollaborationRequest, AgentSummary } from '@pi-meme/contracts/collaboration'
import type { TaskMode } from '@pi-meme/contracts/plan'
import { SdkSession } from '@pi-meme/pi-runtime/sdk/session'
import { useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'

type Notify = ConstructorParameters<typeof SdkSession>[1]
function fakeSession(cwd: string, notify: Notify) {
  const sessionId = randomUUID()
  const state: Snapshot['state'] = {
    mode: 'default',
    isStreaming: false,
    isCompacting: false,
    steeringMode: 'all',
    followUpMode: 'one-at-a-time',
    pendingMessageCount: 0,
  }
  const messages: Snapshot['messages'] = []
  const prompts: string[] = []
  const delivered: string[] = []
  const continuations: string[] = []
  const faults: { continuation?: boolean; deliveryGate?: Promise<void>; snapshotGate?: Promise<void> } = {}
  let status: Snapshot['connection']['status'] = 'idle'
  const session = {
    configureAccess: () => {},
    configureAgentTask: async () => {},
    configureCapabilities: () => {},
    configureInlineExtensions: () => {},
    start: () => {
      status = 'ready'
    },
    connection: () => ({ cwd, generation: 1, status }),
    getActiveSession: () => ({ sessionId }),
    setSessionMode: async (mode: TaskMode) => {
      state.mode = mode
    },
    setModel: async (model: Snapshot['state']['model']) => {
      state.model = model
      return model
    },
    setThinkingLevel: async (level: Snapshot['state']['thinkingLevel']) => {
      state.thinkingLevel = level
    },
    prompt: async (message: string) => {
      prompts.push(message)
      state.isStreaming = true
    },
    continueCollaborationTask: async (message: string) => {
      if (faults.continuation) throw new Error('准入失败')
      continuations.push(message)
      state.isStreaming = true
    },
    deliverCollaborationMessage: async (message: { id: string; text?: string }) => {
      await faults.deliveryGate
      if (!delivered.includes(message.id)) {
        delivered.push(message.id)
        notify.event({
          generation: 1,
          event: {
            type: 'message_end',
            message: {
              role: 'custom',
              customType: 'pi-meme-collaboration',
              content: message.text ?? '',
              display: true,
              details: { messageId: message.id },
              timestamp: Date.now(),
            },
          },
        })
      }
      return { persisted: true }
    },
    snapshot: async () => {
      await faults.snapshotGate
      return {
        connection: { cwd, generation: 1, status },
        state: { ...state },
        messages: messages.slice(),
        models: [],
      }
    },
    getEntries: async () => ({ entries: [], leafId: null }),
    abort: async () => {
      state.isStreaming = false
    },
    stopAndWait: async () => {
      status = 'disconnected'
    },
  } as unknown as RuntimeSdkSession
  const finish = (text: string) => {
    messages.push({
      role: 'assistant',
      content: [{ type: 'text', text }],
      timestamp: Date.now(),
    } as Snapshot['messages'][number])
    state.isStreaming = false
    notify.event({ generation: 1, event: { type: 'agent_settled' } })
  }
  return { session, finish, prompts, delivered, continuations, state, faults, notify }
}
async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-collaboration-'))
  const children = new Map<string, ReturnType<typeof fakeSession>>()
  const events: DesktopEvent[] = []
  const creationFaults: { snapshotGate?: Promise<void> } = {}
  const bridge = createHostCollaborationBridge({
    dataRoot: directory,
    createSession: (cwd, notify, key) => {
      const fake = fakeSession(cwd, notify)
      Object.assign(fake.faults, creationFaults)
      children.set(key, fake)
      return fake.session
    },
    emit: (event) => events.push(event),
  })
  const root = fakeSession(directory, {
    connection: () => {},
    event: (event) => {
      bridge.decorateRootEvent('root-key', event)
    },
    error: () => {},
  })
  await bridge.bindRoot({
    sessionKey: 'root-key',
    cwd: directory,
    state: root.state,
    accessMode: 'workspace-write',
    session: root.session,
  })
  const begin = async (mode: TaskMode = 'default') => {
    root.state.mode = mode
    await bridge.beginRootRun('root-key', { mode, message: '根任务' })
  }
  const call = async (
    session: RuntimeSdkSession,
    method: CollaborationRequest['method'],
    params: unknown,
    signal = new AbortController().signal,
    id = randomUUID(),
  ) => {
    const result = await bridge.dispatch(session, { id, method, params } as CollaborationRequest, signal)
    if (method === 'wait_agent' && session === root.session)
      bridge.decorateRootEvent('root-key', {
        generation: 1,
        event: {
          type: 'message_end',
          message: {
            role: 'toolResult',
            toolCallId: id,
            toolName: 'wait_agent',
            content: [],
            details: result,
            isError: false,
            timestamp: Date.now(),
          },
        },
      })
    return result
  }
  const spawn = async (name: string, session = root.session) =>
    (await call(session, 'spawn_agent', { task_name: name, message: '子任务', fork_turns: 'none' })) as AgentSummary
  const until = async (predicate: () => Promise<boolean>) => {
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      if (await predicate()) return
      await new Promise<void>((resolve) => setTimeout(resolve, 1))
    }
    throw new Error('状态未达到预期')
  }
  return {
    directory,
    bridge,
    children,
    events,
    creationFaults,
    root,
    begin,
    call,
    spawn,
    until,
    cleanup: async () => {
      await bridge.stopAndWait()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

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

test('计划运行中关闭下一轮模式不提升child权限；计划落盘ACK后才发saved', async () => {
  const context = await setup()
  try {
    await context.begin('plan')
    await context.bridge.setSessionMode('root-key', 'default')
    const child = await context.spawn('reader')
    assert.equal(child.mode, 'plan')
    await assert.rejects(
      context.bridge.savePlan(
        context.root.session,
        { title: '计划', markdown: '# 计划' },
        new AbortController().signal,
      ),
      /尚未全部结束/,
    )
    context.children.get(child.sessionKey)!.finish('调查完成')
    await context.until(
      async () =>
        (await context.bridge.getAgents('root-key')).find((agent) => agent.name === 'reader')!.status === 'completed',
    )
    await context.call(context.root.session, 'wait_agent', { targets: [child.agentId], timeout_ms: 0 })
    const document = await context.bridge.savePlan(
      context.root.session,
      { title: '计划', markdown: '# 计划\n具体步骤' },
      new AbortController().signal,
    )
    assert.equal(
      await readFile(path.join(context.directory, 'plans', document.sessionId, `${document.id}.md`), 'utf8'),
      document.markdown,
    )
    const next = await context.bridge.savePlan(
      context.root.session,
      { title: '修订计划', markdown: '# 修订计划' },
      new AbortController().signal,
    )
    assert.equal(next.id, document.id)
    assert.equal(next.revision, 2)
    assert.equal(context.events.filter((event) => event.event.type === 'plan_saved').length, 2)
  } finally {
    await context.cleanup()
  }
})

test('根会话重绑定和 Host 重启时保留计划身份，不把同目录其他会话的计划混入', async () => {
  const context = await setup()
  let restored: ReturnType<typeof createHostCollaborationBridge> | undefined
  try {
    await context.begin('plan')
    const document = await context.bridge.savePlan(
      context.root.session,
      { title: '已有计划', markdown: '# 已有计划\n保留正文' },
      new AbortController().signal,
    )
    const sessionFile = path.join(context.directory, 'root.jsonl')
    const binding = {
      cwd: context.directory,
      sessionFile,
      state: context.root.state,
      accessMode: 'workspace-write' as const,
      session: context.root.session,
    }
    const original = (await context.bridge.snapshot('root-key')).agent
    await context.bridge.bindRoot({ ...binding, sessionKey: 'root-key' })
    assert.equal((await context.bridge.snapshot('root-key')).agent.sessionId, document.sessionId)
    assert.deepEqual((await context.bridge.snapshot('root-key')).planDocuments, [document])
    await context.bridge.stopAndWait()
    restored = createHostCollaborationBridge({
      dataRoot: context.directory,
      createSession: () => {
        throw new Error('只读恢复不能创建 Worker')
      },
      emit: () => {},
    })
    await restored.bindRoot({ ...binding, sessionKey: 'restored-key' })
    const snapshot = await restored.snapshot('restored-key')
    assert.equal(snapshot.agent.agentId, original.agentId)
    assert.equal(snapshot.agent.sessionKey, 'restored-key')
    assert.deepEqual(snapshot.planDocuments, [document])
    const otherSession = fakeSession(context.directory, { connection: () => {}, event: () => {}, error: () => {} })
    await restored.bindRoot({
      ...binding,
      sessionKey: 'other-key',
      sessionFile: path.join(context.directory, 'other.jsonl'),
      sessionId: randomUUID(),
      session: otherSession.session,
    })
    assert.deepEqual((await restored.snapshot('other-key')).planDocuments, [])
    await restored.bindRoot({
      ...binding,
      sessionKey: 'other-key',
      sessionFile: path.join(context.directory, 'other.jsonl'),
      sessionId: otherSession.session.getActiveSession().sessionId,
      session: otherSession.session,
    })
    assert.equal(
      (await restored.snapshot('other-key')).agent.sessionId,
      otherSession.session.getActiveSession().sessionId,
    )
    assert.equal(
      await readFile(path.join(context.directory, 'plans', document.sessionId, `${document.id}.md`), 'utf8'),
      document.markdown,
    )
  } finally {
    await restored?.stopAndWait()
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

test('文档目录无法写入时反馈失败，不发saved，不产生虚假snapshot', async () => {
  const context = await setup()
  try {
    await context.begin('plan')
    await mkdir(context.directory, { recursive: true })
    await writeFile(path.join(context.directory, 'plans'), '占用目录')
    await assert.rejects(
      context.bridge.savePlan(
        context.root.session,
        { title: '计划', markdown: '# 计划' },
        new AbortController().signal,
      ),
      /EEXIST|ENOTDIR/,
    )
    assert.equal(context.events.filter((event) => event.event.type === 'plan_saved').length, 0)
    assert.equal((await context.bridge.snapshot('root-key')).planDocuments.length, 0)
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

test('计划metadata保存失败恢复原文档revision，删除未确认新文件和临时文件', async () => {
  const context = await setup()
  try {
    await context.begin('plan')
    const first = await context.bridge.savePlan(
      context.root.session,
      { title: '第一版', markdown: '# 第一版' },
      new AbortController().signal,
    )
    const plansDirectory = path.join(context.directory, 'plans', first.sessionId)
    await rm(path.join(context.directory, 'collaboration.json'))
    await mkdir(path.join(context.directory, 'collaboration.json'))
    await assert.rejects(
      context.bridge.savePlan(
        context.root.session,
        { title: '第二版', markdown: '# 第二版' },
        new AbortController().signal,
      ),
      /EISDIR|ENOTEMPTY/,
    )
    assert.equal(await readFile(path.join(plansDirectory, `${first.id}.md`), 'utf8'), '# 第一版')
    const { readdir } = await import('node:fs/promises')
    assert.deepEqual(await readdir(plansDirectory), [`${first.id}.md`])
    assert.equal((await context.bridge.snapshot('root-key')).planDocuments[0]!.revision, 1)
    await rm(path.join(context.directory, 'collaboration.json'), { recursive: true })
    await context.begin('plan')
  } finally {
    await context.cleanup()
  }
})

test('计划写盘期间取消清理tmp，不改变已确认revision', async () => {
  const context = await setup()
  try {
    await context.begin('plan')
    const first = await context.bridge.savePlan(
      context.root.session,
      { title: '已确认计划', markdown: '# 已确认计划' },
      new AbortController().signal,
    )
    const controller = new AbortController()
    const { watch } = await import('node:fs')
    const plansDirectory = path.join(context.directory, 'plans', first.sessionId)
    const watcher = watch(plansDirectory, (_event, filename) => {
      if (filename?.endsWith('.tmp')) controller.abort()
    })
    try {
      await assert.rejects(
        context.bridge.savePlan(
          context.root.session,
          { title: '取消修订', markdown: '内容\n'.repeat(1000000) },
          controller.signal,
        ),
        /取消或更换/,
      )
    } finally {
      watcher.close()
    }
    const { readdir } = await import('node:fs/promises')
    assert.equal(await readFile(path.join(plansDirectory, `${first.id}.md`), 'utf8'), '# 已确认计划')
    assert.deepEqual(await readdir(plansDirectory), [`${first.id}.md`])
    assert.equal((await context.bridge.snapshot('root-key')).planDocuments[0]!.revision, 1)
    assert.equal(context.events.filter((event) => event.event.type === 'plan_saved').length, 1)
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

test('child已completed但queued followup尚未启动时不能保存计划或结束树', async () => {
  const context = await setup()
  let release!: () => void
  try {
    await context.begin('plan')
    const child = await context.spawn('worker')
    await context.call(context.root.session, 'followup_task', { target: child.agentId, message: '后续调查' })
    context.root.faults.deliveryGate = new Promise<void>((resolve) => {
      release = resolve
    })
    context.children.get(child.sessionKey)!.finish('首轮结果')
    await context.until(
      async () =>
        (await context.bridge.getAgents('root-key')).find((entry) => entry.agentId === child.agentId)!.status ===
        'completed',
    )
    await assert.rejects(
      context.bridge.savePlan(
        context.root.session,
        { title: '提前保存', markdown: '# 提前保存' },
        new AbortController().signal,
      ),
      /子 Agent 尚未全部结束或结果尚未读取/,
    )
    const settling = context.bridge.rootSettled('root-key')
    await context.until(
      async () =>
        context.root.delivered.length === 0 && (await context.bridge.getAgents('root-key'))[0]!.status === 'running',
    )
    assert.notEqual((await context.bridge.getAgents('root-key'))[0]!.status, 'completed')
    release()
    await settling
  } finally {
    release?.()
    await context.cleanup()
  }
})

test('Host停止等待计划写入和回滚完成，停止ACK后不再产生文档或saved事件', async () => {
  const context = await setup()
  try {
    await context.begin('plan')
    const sessionId = context.root.session.getActiveSession().sessionId!
    const directory = path.join(context.directory, 'plans', sessionId)
    await mkdir(directory, { recursive: true })
    const { watch } = await import('node:fs')
    let stopped!: Promise<void>
    let enter!: () => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    let started = false
    const watcher = watch(directory, (_event, filename) => {
      if (!started && filename?.endsWith('.tmp')) {
        started = true
        stopped = context.bridge.stopAndWait()
        enter()
      }
    })
    let saveSettled = false
    const saving = context.bridge
      .savePlan(
        context.root.session,
        { title: '停止期间文档', markdown: '内容\n'.repeat(4000000) },
        new AbortController().signal,
      )
      .finally(() => {
        saveSettled = true
      })
    const rejection = assert.rejects(saving, /取消或更换/)
    try {
      await entered
      await stopped
      assert.equal(saveSettled, true)
      await rejection
      const { readdir } = await import('node:fs/promises')
      assert.deepEqual(await readdir(directory), [])
      assert.equal(context.events.filter((event) => event.event.type === 'plan_saved').length, 0)
      assert.equal((await context.bridge.snapshot('root-key')).agent.status, 'stopped')
    } finally {
      watcher.close()
    }
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

test('forknone模型首响应前interrupt或Host停止后，原生用户记录可离线恢复且重启不启动Worker', async (t) => {
  for (const action of ['interrupt', 'stop'])
    await t.test(action, async () => {
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
