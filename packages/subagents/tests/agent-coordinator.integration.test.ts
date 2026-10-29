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
import { finishAgentReply, useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'
import { assistantMessage } from '../../../tests/fixtures/messages.mjs'
import { create as collaborationExtension } from '../src/agent/entry'
import { fakeSession, readSavedRecords, setup } from './coordinator-fixture'

test('RPC 会话代理的未知属性不应把正式根会话标成临时会话', async () => {
  const context = await setup()
  try {
    const session = new Proxy(context.root.session, {
      get: (target, property, receiver) =>
        Reflect.has(target, property) ? Reflect.get(target, property, receiver) : () => Promise.resolve(),
    })
    const root = await context.bridge.bindRoot({
      sessionKey: 'proxy-root',
      cwd: context.directory,
      state: context.root.state,
      accessMode: 'workspace-write',
      session,
    })
    await context.bridge.setSessionMode('proxy-root', 'plan')
    const saved = (await context.savedRecords()).find((record) => record.summary.agentId === root.agentId)
    assert.equal(saved?.nextMode, 'plan')
    assert.equal(context.bridge.isTemporarySession('proxy-root'), false)
  } finally {
    await context.cleanup()
  }
})

test('编辑预检拒绝清理受阻的子任务；截断移除身份、邮箱与迟到事件', async () => {
  const context = await setup()
  try {
    const appendUser = (id: string) =>
      context.root.entries.push({
        type: 'message',
        id,
        parentId: context.root.entries.at(-1)?.id ?? null,
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: id, timestamp: Date.now() },
      })
    appendUser('first')
    await context.begin()
    const earlier = await context.spawn('earlier')
    const oldWorker = context.children.get(earlier.sessionKey)!
    await context.bridge.stopRoot('root-key')
    appendUser('second')
    await context.begin()
    const later = await context.spawn('later')
    const laterWorker = context.children.get(later.sessionKey)!
    await context.bridge.stopRoot('root-key')
    const records = (context.bridge as unknown as { records: Map<string, { summary: AgentSummary }> }).records
    const record = records.get(later.agentId)!
    record.summary.cleanup = { state: 'blocked', causeId: 'test', revision: 1, error: '停止失败' }
    await assert.rejects(context.bridge.prepareEdit('root-key'), /尚未完成清理/)
    assert.equal((await context.bridge.getAgents('root-key')).length, 3)
    record.summary.cleanup.state = 'completed'
    await context.bridge.prepareEdit('root-key')
    context.root.entries.pop()
    await context.bridge.historyEdited(context.root.session)
    assert.deepEqual(
      (await context.bridge.getAgents('root-key')).filter((agent) => agent.depth > 0).map((agent) => agent.agentId),
      [earlier.agentId],
    )
    assert.ok((await context.savedRecords()).every((saved) => saved.summary.agentId !== later.agentId))
    const update = context.events.at(-1)!.event
    assert.equal(update.type, 'agents_update')
    if (update.type === 'agents_update') assert.deepEqual(update.agentMessages, [])
    const count = context.events.length
    laterWorker.reply('迟到结果')
    assert.equal(context.events.length, count)
    await assert.rejects(context.call(laterWorker.session, 'list_agents', {}), /无效或已结束/)
    assert.equal(oldWorker.session.connection().status, 'disconnected')
    await context.begin()
    const replacement = await context.spawn('later')
    assert.notEqual(replacement.agentId, later.agentId)
  } finally {
    await context.cleanup()
  }
})

test('旧记录和分叉身份按保留的原生工具结果清理，codemode 嵌套调用不误删', async () => {
  const context = await setup()
  try {
    await context.begin()
    const retained = await context.spawn('retained')
    const removed = await context.spawn('removed')
    await context.bridge.stopRoot('root-key')
    const records = (
      context.bridge as unknown as { records: Map<string, { importedAgentId?: string; sourceEntryId?: string }> }
    ).records
    records.get(retained.agentId)!.sourceEntryId = undefined
    const saved = await context.savedRecords()
    const root = saved.find((record) => record.summary.depth === 0)!
    const reply = root.replies!.find((reply) => 'agentId' in reply.result && reply.result.agentId === retained.agentId)!
    context.root.entries.push({
      id: 'nested-result',
      parentId: null,
      type: 'message',
      timestamp: new Date().toISOString(),
      message: {
        role: 'toolResult',
        toolName: 'codemode',
        toolCallId: 'outer',
        isError: false,
        content: [],
        timestamp: Date.now(),
        nestedCalls: { complete: true, calls: [{ id: reply.id, name: 'spawn_agent', status: 'ok', durationMs: 1 }] },
      },
    })
    // 普通旧记录依赖持久回复中的嵌套调用身份。
    await context.bridge.historyEdited(context.root.session)
    assert.deepEqual(
      (await context.bridge.getAgents('root-key')).filter((agent) => agent.depth > 0).map((agent) => agent.agentId),
      [retained.agentId],
    )
    assert.ok((await context.savedRecords()).every((record) => record.summary.agentId !== removed.agentId))
    records.get(retained.agentId)!.importedAgentId = 'source-agent'
    const entry = context.root.entries[0]!
    if (entry.type === 'message' && entry.message.role === 'toolResult') {
      entry.message.nestedCalls = undefined
      entry.message.toolName = 'spawn_agent'
      entry.message.details = { ...retained, agentId: 'source-agent' }
    }
    await context.bridge.historyEdited(context.root.session)
    assert.equal((await context.bridge.getAgents('root-key')).length, 2)
    context.root.entries.length = 0
    await context.bridge.historyEdited(context.root.session)
    assert.equal((await context.bridge.getAgents('root-key')).length, 1)
  } finally {
    await context.cleanup()
  }
})

function enableCollaboration(bridge: ReturnType<typeof createHostCollaborationBridge>, session: SdkSession) {
  session.configureInlineExtensions(
    collaborationExtension({
      requestCollaboration: (request, signal) =>
        bridge.dispatch(
          session,
          { ...request, id: randomUUID() } as CollaborationRequest,
          signal ?? new AbortController().signal,
        ),
      savePlan: async () => {
        throw new Error('本测试不保存计划')
      },
    }),
  )
}

test('最终模型错误通知主会话；完成意向的报告仍保留', async () => {
  const context = await setup()
  try {
    await context.begin()
    const child = await context.spawn('worker')
    const worker = context.children.get(child.sessionKey)!
    await context.call(worker.session, 'finish_agent', { report: '已完成部分工作' })
    worker.notify.event({
      generation: 1,
      event: {
        type: 'message_end',
        message: assistantMessage([], Date.now(), { stopReason: 'error', errorMessage: '模型返回 503' }),
      },
    })
    worker.notify.event({ generation: 1, event: { type: 'agent_settled' } })
    await context.until(async () => {
      const agents = await context.bridge.getAgents('root-key')
      return agents.find((agent) => agent.agentId === child.agentId)?.cleanup?.state === 'completed'
    })
    const summary = (await context.bridge.getAgents('root-key')).find((agent) => agent.agentId === child.agentId)!
    assert.equal(summary.status, 'failed')
    assert.equal(summary.error, '模型返回 503')
    assert.equal(summary.report, '已完成部分工作')
    const saved = await context.savedRecords()
    const rootRecord = saved.find((entry) => entry.summary.depth === 0)
    const resultMessages = rootRecord?.mailbox.filter(
      (item) => item.fromAgentId === child.agentId && item.kind === 'result',
    )
    assert.equal(resultMessages?.length, 1)
  } finally {
    await context.cleanup()
  }
})

test('Host 重启中断已提交完成意向的子任务时保留报告', async () => {
  const context = await setup()
  try {
    await context.begin()
    const child = await context.spawn('worker')
    await context.call(context.children.get(child.sessionKey)!.session, 'finish_agent', { report: '重启前的工作报告' })
    const restored = createHostCollaborationBridge({
      dataRoot: context.directory,
      emit: () => {},
      createSession: () => {
        throw new Error('恢复阶段不创建 Worker')
      },
    })
    const summary = (await restored.getAgents('root-key')).find((agent) => agent.agentId === child.agentId)
    assert.equal(summary?.status, 'interrupted')
    assert.equal(summary?.report, '重启前的工作报告')
  } finally {
    await context.cleanup()
  }
})

test('真实 Pi 子任务 finish_agent 后收到模型 503，失败结果持久通知主会话', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-child-model-error-'))
  const fake = await useFakeAgent(directory, {
    reply: (body, index) =>
      index === 1 ? finishAgentReply(body, '已完成部分工作') : { status: 503, text: '模型端 503' },
  })
  const root = fakeSession(directory, { connection: () => {}, event: () => {}, error: () => {} })
  root.state.model = { provider: 'fake', id: 'first' }
  const bridge = createHostCollaborationBridge({
    dataRoot: directory,
    emit: () => {},
    createSession: (cwd, notify) => {
      const session = new SdkSession(cwd, notify, fake.runtimePaths, fake.credentials)
      enableCollaboration(bridge, session)
      return session
    },
  })
  try {
    await bridge.bindRoot({
      sessionKey: 'root',
      cwd: directory,
      state: root.state,
      accessMode: 'full-access',
      session: root.session,
    })
    await bridge.beginRootRun('root', { mode: 'default', message: '主任务' })
    const child = (await bridge.dispatch(
      root.session,
      {
        id: randomUUID(),
        method: 'spawn_agent',
        params: { task_name: 'worker', message: '执行任务', fork_turns: 'none' },
      },
      new AbortController().signal,
    )) as AgentSummary
    const deadline = Date.now() + 25000
    let summary: AgentSummary | undefined
    do {
      summary = (await bridge.getAgents('root')).find((agent) => agent.agentId === child.agentId)
      if (summary?.status === 'failed' && summary.cleanup?.state === 'completed') break
      if (Date.now() > deadline) throw new Error('真实 Pi 模型失败未完成清理')
      await new Promise<void>((resolve) => setTimeout(resolve, 20))
    } while (true)
    assert.match(summary.error ?? '', /503/)
    assert.equal(summary.report, '已完成部分工作')
    const saved = await readSavedRecords(directory)
    const rootRecord = saved.find((entry) => entry.summary.depth === 0)
    const resultMessages = rootRecord?.mailbox.filter(
      (message) => message.kind === 'result' && message.fromAgentId === child.agentId,
    )
    assert.equal(resultMessages?.length, 1)
  } finally {
    await bridge.stopAndWait()
    await fake.dispose()
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)

test('只等待 A 时 B 最终失败也会唤醒主会话', async () => {
  const context = await setup()
  try {
    await context.begin()
    await context.spawn('a')
    const b = await context.spawn('b')
    const waiting = context.call(context.root.session, 'wait_agent', { targets: ['a'], timeout_ms: 1000 })
    context.children.get(b.sessionKey)!.notify.event({
      generation: 1,
      event: {
        type: 'message_end',
        message: assistantMessage([], Date.now(), { stopReason: 'error', errorMessage: '模型失败' }),
      },
    })
    context.children.get(b.sessionKey)!.notify.event({ generation: 1, event: { type: 'agent_settled' } })
    const result = waiting as Promise<CollaborationResults['wait_agent']>
    const settled = await result
    assert.equal(settled.wakeReason, 'critical')
    assert.equal(settled.timedOut, false)
    assert.equal(
      settled.messages.some((message) => message.fromAgentId === b.agentId && message.status === 'failed'),
      true,
    )
    assert.equal(
      (await context.bridge.getAgents('root-key')).find((agent) => agent.taskPath === '/root/a')?.status,
      'running',
    )
  } finally {
    await context.cleanup()
  }
})

test('中间 Agent 失败取消自己的孙代理并保留其他分支', async () => {
  const context = await setup()
  try {
    await context.begin()
    const parent = await context.spawn('parent')
    const sibling = await context.spawn('sibling')
    const worker = context.children.get(parent.sessionKey)!
    const grandchild = await context.spawnLegacy('grandchild', worker.session)
    worker.notify.event({
      generation: 1,
      event: {
        type: 'message_end',
        message: assistantMessage([], Date.now(), { stopReason: 'error', errorMessage: '上级模型失败' }),
      },
    })
    worker.notify.event({ generation: 1, event: { type: 'agent_settled' } })
    await context.until(async () => {
      const agents = await context.bridge.getAgents('root-key')
      return agents.find((agent) => agent.agentId === parent.agentId)?.cleanup?.state === 'completed'
    })
    const agents = await context.bridge.getAgents('root-key')
    assert.equal(agents.find((agent) => agent.agentId === grandchild.agentId)?.status, 'interrupted')
    assert.equal(agents.find((agent) => agent.agentId === sibling.agentId)?.status, 'running')
  } finally {
    await context.cleanup()
  }
})

test('旧子任务继续执行时发来的消息只进历史，不影响新根任务', async () => {
  const context = await setup()
  try {
    await context.begin()
    const child = await context.spawn('old_worker')
    await context.begin()
    const response = (await context.call(context.children.get(child.sessionKey)!.session, 'send_message', {
      target: '/root',
      message: '旧任务反馈',
    })) as CollaborationResults['send_message']
    assert.equal(response.deliveryState, 'history_only')
    assert.equal(response.delivered, false)
    const waiting = (await context.call(context.root.session, 'wait_agent', {
      targets: ['old_worker'],
      timeout_ms: 0,
    })) as CollaborationResults['wait_agent']
    assert.equal(waiting.messages.length, 0)
    assert.equal(waiting.timedOut, true)
    assert.equal(context.root.delivered.includes(response.messageId), false)
    const saved = await context.savedRecords()
    const rootRecord = saved.find((entry) => entry.summary.depth === 0)
    assert.equal(
      rootRecord?.mailbox.some((message) => message.id === response.messageId && message.historyOnly),
      true,
    )
  } finally {
    await context.cleanup()
  }
})

test('旧运行失败只取消自身排队任务，新根任务排队的后续任务继续执行', async () => {
  const context = await setup()
  try {
    await context.begin()
    const child = await context.spawn('worker')
    await context.begin()
    const queued = (await context.call(context.root.session, 'followup_task', {
      target: 'worker',
      message: '新任务委派',
    })) as CollaborationResults['followup_task']
    assert.equal(queued.queued, true)
    const old = context.children.get(child.sessionKey)!
    old.notify.event({
      generation: 1,
      event: {
        type: 'message_end',
        message: assistantMessage([], Date.now(), { stopReason: 'error', errorMessage: '旧运行失败' }),
      },
    })
    old.notify.event({ generation: 1, event: { type: 'agent_settled' } })
    await context.until(async () => {
      const current = (await context.bridge.getAgents('root-key')).find((agent) => agent.agentId === child.agentId)
      return current?.runId !== child.runId && current?.status === 'running'
    })
    const current = (await context.bridge.getAgents('root-key')).find((agent) => agent.agentId === child.agentId)!
    assert.equal(current.status, 'running')
    assert.equal(current.task, '新任务委派')
    assert.equal(context.root.continuations.length, 0)
  } finally {
    await context.cleanup()
  }
})

test('分叉复制已结束子代理，运行中的子代理阻止新建，未包含的身份留在原会话', async () => {
  const context = await setup()
  try {
    await context.begin()
    const writer = await context.spawn('writer')
    const reviewer = await context.spawn('reviewer')
    await assert.rejects(context.bridge.prepareFork('root-key', [writer.agentId, reviewer.agentId]), /子代理仍在运行/)
    const writerFile = path.join(context.directory, 'writer.jsonl')
    await writeFile(
      writerFile,
      `${JSON.stringify({
        type: 'session',
        version: 3,
        id: 'writer-session',
        timestamp: new Date().toISOString(),
        cwd: context.directory,
      })}
${JSON.stringify({
  type: 'message',
  id: 'writer-message',
  parentId: null,
  timestamp: new Date().toISOString(),
  message: { role: 'user', content: '写文章', timestamp: 1 },
})}
`,
    )
    const worker = context.children.get(writer.sessionKey)!
    worker.session.getActiveSession = () => ({ sessionId: 'writer-session', sessionFile: writerFile })
    await worker.finish('写完了')
    await context.until(
      async () => (await context.bridge.getAgentSnapshot(writer.agentId)).agent?.status === 'completed',
    )
    const saved = await context.bridge.getAgentSnapshot(writer.agentId)
    assert.equal(saved.agent?.sessionFile, writerFile)
    const fork = fakeSession(context.directory, { connection: () => {}, event: () => {}, error: () => {} })
    const forkFile = path.join(context.directory, 'fork.jsonl')
    await context.bridge.prepareFork('root-key', [writer.agentId])
    await context.bridge.adoptFork(
      'root-key',
      {
        sessionKey: 'fork-key',
        cwd: context.directory,
        sessionFile: forkFile,
        sessionId: 'fork-session',
        state: fork.state,
        accessMode: 'workspace-write',
        session: fork.session,
      },
      [writer.agentId],
    )
    const forked = (await context.bridge.getAgents('fork-key')).filter((agent) => agent.depth > 0)
    assert.equal(forked.length, 1)
    assert.equal(forked[0]?.name, 'writer')
    assert.equal(forked[0]?.taskPath, '/root/writer')
    assert.notEqual(forked[0]?.agentId, writer.agentId)
    assert.equal(forked[0]?.importedRunId, writer.runId)
    assert.notEqual(forked[0]?.sessionFile, writerFile)
    const header = JSON.parse((await readFile(forked[0]!.sessionFile!, 'utf8')).split(/\r?\n/, 1)[0]!) as {
      parentSession?: string
    }
    assert.equal(header.parentSession, path.resolve(writerFile))
    const original = await context.bridge.getAgents('root-key')
    assert.equal(original.find((agent) => agent.agentId === writer.agentId)?.sessionFile, writerFile)
    assert.ok(original.some((agent) => agent.agentId === reviewer.agentId))
    assert.equal(
      forked.some((agent) => agent.name === 'reviewer'),
      false,
    )
  } finally {
    await context.cleanup()
  }
})

test('查询可用模型和思考强度，子任务默认继承调用方当前配置且逐项覆盖', async () => {
  const context = await setup()
  try {
    const inherited = { provider: 'fake', id: 'first', name: '默认模型', reasoning: true }
    const selected = { provider: 'other', id: 'second', name: '指定模型', reasoning: true }
    context.root.models.push(inherited, selected)
    context.root.state.model = inherited
    context.root.state.thinkingLevel = 'high'
    await context.begin()
    const available = (await context.call(
      context.root.session,
      'list_agent_models',
      {},
    )) as CollaborationResults['list_agent_models']
    assert.deepEqual(available.models, [inherited, selected])
    assert.deepEqual(available.thinkingLevels, ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    assert.deepEqual(available.current, { model: inherited, thinkingLevel: 'high' })
    const plain = await context.spawn('plain')
    assert.deepEqual(plain.model, inherited)
    assert.equal(plain.thinkingLevel, 'high')
    const spawn = (name: string, selection: object) =>
      context.call(context.root.session, 'spawn_agent', {
        task_name: name,
        message: '子任务',
        fork_turns: 'none',
        ...selection,
      }) as Promise<AgentSummary>
    const modelOnly = await spawn('model_only', { model: { provider: 'other', id: 'second' } })
    assert.deepEqual(modelOnly.model, selected)
    assert.equal(modelOnly.thinkingLevel, 'high')
    const thinkingOnly = await spawn('thinking_only', { thinking_level: 'off' })
    assert.deepEqual(thinkingOnly.model, inherited)
    assert.equal(thinkingOnly.thinkingLevel, 'off')
    const worker = context.children.get(modelOnly.sessionKey)!
    assert.deepEqual(worker.state.model, selected)
    assert.equal(worker.state.thinkingLevel, 'high')
    await assert.rejects(context.spawn('nested', worker.session), /不支持嵌套/)
    assert.deepEqual(context.root.state.model, inherited)
    assert.equal(context.root.state.thinkingLevel, 'high')
  } finally {
    await context.cleanup()
  }
})

test('无效模型或思考强度在创建身份和任务入队前拒绝，不回退默认值', async () => {
  const context = await setup()
  try {
    await context.begin()
    const invalid = [{ model: { provider: 'missing', id: 'unknown' } }, { thinking_level: 'invalid' }]
    for (const selection of invalid) {
      await assert.rejects(
        context.call(context.root.session, 'spawn_agent', {
          task_name: 'invalid',
          message: '子任务',
          fork_turns: 'none',
          ...selection,
        }),
        /模型不可用|思考强度不可用/,
      )
    }
    assert.equal((await context.bridge.getAgents('root-key')).length, 1)
    assert.equal(context.children.size, 0)
    const child = await context.spawn('worker')
    for (const selection of invalid) {
      await assert.rejects(
        context.call(context.root.session, 'followup_task', {
          target: 'worker',
          message: '下一任务',
          ...selection,
        }),
        /模型不可用|思考强度不可用/,
      )
    }
    await context.children.get(child.sessionKey)!.finish('完成')
    await context.until(async () => (await context.bridge.getAgents('root-key'))[1]!.status === 'completed')
    assert.equal(context.children.get(child.sessionKey)!.prompts.length, 1)
  } finally {
    await context.cleanup()
  }
})

test('后续任务固定入队时的显式配置，省略时重新继承调用方而非子任务上一轮配置', async () => {
  const context = await setup()
  try {
    const inherited = { provider: 'fake', id: 'first' }
    const selected = { provider: 'other', id: 'second' }
    context.root.models.push(inherited, selected)
    context.root.state.model = inherited
    context.root.state.thinkingLevel = 'high'
    await context.begin()
    const child = await context.spawn('worker')
    const worker = context.children.get(child.sessionKey)!
    const queued = (await context.call(context.root.session, 'followup_task', {
      target: 'worker',
      message: '指定配置的任务',
      model: selected,
      thinking_level: 'low',
    })) as CollaborationResults['followup_task']
    assert.equal(queued.queued, true)
    assert.deepEqual(worker.state.model, inherited)
    assert.equal(worker.state.thinkingLevel, 'high')
    context.root.state.thinkingLevel = 'max'
    const records = await context.savedRecords()
    const targetRecord = records.find((record: { summary: AgentSummary }) => record.summary.agentId === child.agentId)
    const queuedPolicy = targetRecord!.queued[0]!.policy
    assert.deepEqual(queuedPolicy.model, selected)
    assert.equal(queuedPolicy.thinkingLevel, 'low')
    await worker.finish('首项完成')
    await context.until(async () => worker.prompts.length === 2)
    assert.deepEqual(worker.state.model, selected)
    assert.equal(worker.state.thinkingLevel, 'low')
    await worker.finish('指定配置任务完成')
    await context.until(async () => (await context.bridge.getAgents('root-key'))[1]!.status === 'completed')
    const next = (await context.call(context.root.session, 'followup_task', {
      target: 'worker',
      message: '恢复继承配置',
    })) as CollaborationResults['followup_task']
    assert.equal(next.queued, false)
    assert.deepEqual(next.agent.model, inherited)
    assert.equal(next.agent.thinkingLevel, 'max')
    assert.deepEqual(worker.state.model, inherited)
    assert.equal(worker.state.thinkingLevel, 'max')
  } finally {
    await context.cleanup()
  }
})

test('根任务启动前失败后可以开始新任务', async () => {
  const context = await setup()
  try {
    await context.bridge.rootFailed('root-key', new Error('启动失败'))
    assert.equal((await context.bridge.getAgents('root-key'))[0]?.cleanup, undefined)
    await context.bridge.beginRootRun('root-key', { mode: 'default', message: '重试' })
    assert.equal((await context.bridge.getAgents('root-key'))[0]?.status, 'running')
  } finally {
    await context.cleanup()
  }
})

test('根任务失败先取消子树和排队任务，清理完成后才可显式恢复', async () => {
  const context = await setup()
  try {
    await context.begin('plan')
    const child = await context.spawn('worker')
    const worker = context.children.get(child.sessionKey)!
    await context.call(context.root.session, 'followup_task', { target: 'worker', message: '下一项子任务' })
    const before = (await context.bridge.getAgents('root-key'))[0]!
    await context.bridge.rootFailed('root-key', new Error('network error'), before.runId)
    await context.until(async () => (await context.bridge.getAgents('root-key'))[0]?.cleanup?.state === 'completed')
    await context.bridge.setSessionMode('root-key', 'default')
    await context.until(async () => {
      try {
        await context.bridge.admitRecovery(context.root.session, 'plan')
        return true
      } catch (cause) {
        if (String(cause).includes('子树清理尚未完成')) return false
        throw cause
      }
    })
    const recovered = await context.bridge.getAgents('root-key')
    for (const field of ['agentId', 'rootTaskId', 'epoch', 'runId', 'task', 'runStartedAt', 'mode'] as const)
      assert.equal(recovered[0]![field], before[field], field)
    assert.equal(recovered[0]!.status, 'running')
    assert.equal(recovered[0]!.error, undefined)
    assert.equal(recovered[0]!.runCompletedAt, undefined)
    assert.equal(recovered[1]?.status, 'interrupted')
    assert.equal(recovered[1]?.error, '上级任务失败，当前运行已取消')
    assert.equal(await context.bridge.getSessionMode('root-key'), 'default')
    assert.equal(worker.prompts.length, 1)
    assert.equal(worker.prompts.length, 1)
  } finally {
    await context.cleanup()
  }
})

test('失败子树清理未完成时拒绝新根任务，清理完成后允许开始', async () => {
  const context = await setup()
  let release = () => {}
  try {
    await context.begin()
    const child = await context.spawn('worker')
    const worker = context.children.get(child.sessionKey)!
    const originalStop = worker.session.stopAndWait.bind(worker.session)
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    worker.session.stopAndWait = async () => {
      await gate
      await originalStop()
    }
    const rootRun = (await context.bridge.getAgents('root-key'))[0]!
    await context.bridge.rootFailed('root-key', new Error('主任务失败'), rootRun.runId)
    await assert.rejects(context.begin(), /子树清理尚未完成/)
    release()
    await context.until(async () => (await context.bridge.getAgents('root-key'))[0]?.cleanup?.state === 'completed')
    await context.until(async () => {
      try {
        await context.begin()
        return true
      } catch (cause) {
        if (String(cause).includes('子树清理尚未完成')) return false
        throw cause
      }
    })
    assert.equal((await context.bridge.getAgents('root-key'))[0]?.cleanup, undefined)
  } finally {
    release()
    await context.cleanup()
  }
})

test('恢复准入接受已结算和首次绑定历史，拒绝暂停、子会话和取消请求且不重启已停止子任务', async () => {
  const context = await setup()
  try {
    await context.bridge.admitRecovery(context.root.session, 'default')
    const initial = (await context.bridge.getAgents('root-key'))[0]!
    assert.ok(initial.runId)
    await context.bridge.rootSettled('root-key')
    await context.bridge.admitRecovery(context.root.session, 'default')
    assert.equal((await context.bridge.getAgents('root-key'))[0]!.runId, initial.runId)
    const child = await context.spawn('worker')
    await context.bridge.rootSettled('root-key')
    await context.bridge.admitRecovery(context.root.session, 'default')
    const current = (await context.bridge.getAgents('root-key'))[0]!
    assert.equal(current.status, 'running')
    await assert.rejects(
      context.bridge.admitRecovery(context.children.get(child.sessionKey)!.session, 'default'),
      /根会话/,
    )
    await context.bridge.rootFailed('root-key', new Error('network error'))
    const cancelled = new AbortController()
    cancelled.abort()
    await assert.rejects(context.bridge.admitRecovery(context.root.session, 'default', cancelled.signal), /根会话/)
    await context.bridge.pauseRoot('root-key')
    await assert.rejects(context.bridge.admitRecovery(context.root.session, 'default'), /暂停/)
    await context.bridge.stopRoot('root-key')
    await context.bridge.admitRecovery(context.root.session, 'default')
    const resumed = await context.bridge.getAgents('root-key')
    assert.equal(resumed[0]!.status, 'running')
    assert.equal(resumed[0]!.runId, initial.runId)
    assert.equal(resumed[1]!.status, 'interrupted')
    assert.equal(context.children.get(child.sessionKey)!.prompts.length, 1)
  } finally {
    await context.cleanup()
  }
})

test('同级代理短名称按当前层级寻址，发送和等待反馈不需要重新派发任务', async () => {
  const context = await setup()
  try {
    await context.begin()
    const frontend = await context.spawn('frontend')
    const backend = await context.spawn('backend')
    const front = context.children.get(frontend.sessionKey)!
    const back = context.children.get(backend.sessionKey)!
    const [result, sent] = (await Promise.all([
      context.call(front.session, 'wait_agent', { targets: ['backend'], timeout_ms: 1000 }),
      context.call(back.session, 'send_message', { target: 'frontend', message: '接口已经准备好，请联调' }),
    ])) as [CollaborationResults['wait_agent'], CollaborationResults['send_message']]
    assert.deepEqual(
      result.messages.map((message) => message.id),
      [sent.messageId],
    )
    assert.equal(result.agents[0]!.agentId, backend.agentId)
  } finally {
    await context.cleanup()
  }
})

test('阶段回复保留原任务，收到主代理反馈后在原会话继续', async () => {
  const context = await setup()
  try {
    await context.begin()
    const child = await context.spawn('worker')
    const worker = context.children.get(child.sessionKey)!
    worker.reply('接口初稿已经完成，等待验收意见')
    await context.until(async () => !(await context.bridge.getAgentSnapshot(child.agentId)).state.isStreaming)
    const parked = (await context.bridge.getAgents('root-key')).find((agent) => agent.agentId === child.agentId)!
    assert.equal(parked.status, 'waiting_children')
    assert.equal(parked.runCompletedAt, undefined)
    await context.call(context.root.session, 'send_message', { target: 'worker', message: '请补充错误分支' })
    await context.until(async () => worker.continuations.length === 1)
    assert.match(worker.continuations[0]!, /^Collaboration feedback has arrived\./)
    assert.match(worker.continuations[0]!, /any required review criteria/)
    const resumed = (await context.bridge.getAgents('root-key')).find((agent) => agent.agentId === child.agentId)!
    for (const key of [
      'agentId',
      'sessionId',
      'sessionKey',
      'rootTaskId',
      'runId',
      'epoch',
      'executionGeneration',
    ] as const)
      assert.equal(resumed[key], child[key])
    assert.equal(worker.prompts.length, 1)
  } finally {
    await context.cleanup()
  }
})

test('主代理和同级代理多轮反馈、等待、修改、验收都保留原任务和会话，仅明确完成后交付最终结果', async () => {
  const context = await setup()
  try {
    await context.begin()
    const frontend = await context.spawn('frontend')
    const backend = await context.spawn('backend')
    const front = context.children.get(frontend.sessionKey)!
    const back = context.children.get(backend.sessionKey)!
    const root = (await context.bridge.getAgents('root-key'))[0]!
    await context.bridge.rootSettled('root-key')

    const waiting = context.call(front.session, 'wait_agent', { targets: ['backend'], timeout_ms: 1000 })
    await context.call(back.session, 'send_message', { target: 'frontend', message: '接口初稿，请联调' })
    const api = (await waiting) as CollaborationResults['wait_agent']
    assert.equal(api.messages[0]!.text, '接口初稿，请联调')
    await context.call(front.session, 'send_message', { target: '/root', message: '页面初稿，请验收' })
    await context.until(async () => context.root.continuations.length === 1)
    front.reply('等待验收')
    await context.until(
      async () => (await context.bridge.getAgentSnapshot(frontend.agentId)).agent!.status === 'waiting_children',
    )
    await context.bridge.rootSettled('root-key')
    await context.call(context.root.session, 'send_message', { target: 'frontend', message: '错误提示需修改' })
    await context.until(async () => front.continuations.length === 1)
    await context.call(front.session, 'send_message', { target: 'backend', message: '请补充错误状态码' })
    const correction = context.call(front.session, 'wait_agent', { targets: ['backend'], timeout_ms: 1000 })
    await context.call(back.session, 'send_message', { target: 'frontend', message: '错误状态码已补充' })
    assert.equal(((await correction) as CollaborationResults['wait_agent']).messages[0]!.text, '错误状态码已补充')
    front.reply('修改已完成，请再次验收')
    await context.until(async () => context.root.continuations.length === 2)
    await context.until(
      async () => (await context.bridge.getAgentSnapshot(frontend.agentId)).agent!.status === 'waiting_children',
    )
    const beforeConfirmation = await context.bridge.getAgents('root-key')
    assert.ok(beforeConfirmation.filter((agent) => agent.depth > 0).every((agent) => !agent.runCompletedAt))
    assert.equal(
      context.events.filter((event) => event.event.type === 'agent_mailbox' && event.event.message.kind === 'result')
        .length,
      0,
    )
    await context.call(context.root.session, 'send_message', { target: 'frontend', message: '验收通过，可以完成' })
    await context.until(async () => front.continuations.length === 2)
    await front.finish('页面和错误处理完成，验收通过')
    await back.finish('接口和状态码完成')
    await context.until(async () =>
      (await context.bridge.getAgents('root-key'))
        .filter((agent) => agent.depth > 0)
        .every((agent) => agent.status === 'completed'),
    )
    await context.until(async () => context.root.delivered.length === 4)
    await context.bridge.rootSettled('root-key')
    const after = await context.bridge.getAgents('root-key')
    assert.equal(after[0]!.status, 'completed')
    for (const before of [root, frontend, backend]) {
      const current = after.find((agent) => agent.agentId === before.agentId)!
      for (const key of [
        'runId',
        'sessionId',
        'sessionKey',
        'rootTaskId',
        'epoch',
        'executionGeneration',
        'runStartedAt',
      ] as const)
        assert.equal(current[key], before[key])
    }
    assert.equal(front.prompts.length, 1)
    assert.equal(back.prompts.length, 1)
    assert.equal(context.children.size, 2)
    assert.equal(
      context.events.filter((event) => event.event.type === 'agent_mailbox' && event.event.message.kind === 'result')
        .length,
      2,
    )
  } finally {
    await context.cleanup()
  }
})

test('子代理可以等待主代理反馈；超时、暂停和中断不提交完成结果，终态不因迟到消息重新启动', async () => {
  const context = await setup()
  try {
    await context.begin()
    const child = await context.spawn('worker')
    const worker = context.children.get(child.sessionKey)!
    const timed = (await context.call(worker.session, 'wait_agent', {
      targets: ['/root'],
      timeout_ms: 1,
    })) as CollaborationResults['wait_agent']
    assert.equal(timed.timedOut, true)
    await assert.rejects(context.call(worker.session, 'wait_agent', { targets: [child.agentId] }), /不能等待自己/)
    const waiting = context.call(worker.session, 'wait_agent', { targets: ['/root'], timeout_ms: 1000 })
    await context.call(context.root.session, 'send_message', { target: 'worker', message: '请继续修改' })
    assert.equal(((await waiting) as CollaborationResults['wait_agent']).messages[0]!.text, '请继续修改')
    worker.reply('等待下一次意见')
    await context.until(
      async () => (await context.bridge.getAgentSnapshot(child.agentId)).agent!.status === 'waiting_children',
    )
    await context.bridge.pauseRoot('root-key')
    await context.call(context.root.session, 'send_message', { target: 'worker', message: '暂停期间的反馈' })
    assert.equal(worker.continuations.length, 0)
    await context.bridge.resumeRoot('root-key')
    await context.until(async () => worker.continuations.length === 1)
    const abort = new AbortController()
    const interruptedWait = context.call(
      worker.session,
      'wait_agent',
      { targets: ['/root'], timeout_ms: 1000 },
      abort.signal,
    )
    const cancelled = assert.rejects(interruptedWait, /等待已取消/)
    await context.until(
      async () => (await context.bridge.getAgentSnapshot(child.agentId)).agent!.status === 'waiting_children',
    )
    abort.abort()
    await cancelled
    await context.call(context.root.session, 'interrupt_agent', { target: 'worker' })
    await context.call(context.root.session, 'send_message', { target: 'worker', message: '迟到反馈' })
    assert.equal(worker.continuations.length, 1)
    assert.equal((await context.bridge.getAgentSnapshot(child.agentId)).agent!.status, 'interrupted')
    assert.equal(
      context.events.filter((event) => event.event.type === 'agent_mailbox' && event.event.message.kind === 'result')
        .length,
      1,
    )
  } finally {
    await context.cleanup()
  }
})

test('嵌套同级短名优先当前层，下级同名优先下级，跨层必须用完整路径', async () => {
  const context = await setup()
  try {
    await context.begin()
    const outerWorker = await context.spawn('worker')
    const owner = await context.spawn('owner')
    const ownerSession = context.children.get(owner.sessionKey)!.session
    const worker = await context.spawnLegacy('worker', ownerSession)
    const peer = await context.spawnLegacy('peer', ownerSession)
    await assert.rejects(
      context.call(context.root.session, 'followup_task', { target: worker.agentId, message: '拒绝旧二级任务续派' }),
      /一级子代理续派/,
    )
    const peerSession = context.children.get(peer.sessionKey)!.session
    await context.call(peerSession, 'send_message', { target: 'worker', message: '同级请求' })
    assert.equal(context.children.get(worker.sessionKey)!.delivered.length, 1)
    assert.equal(context.children.get(outerWorker.sessionKey)!.delivered.length, 0)
    await context.call(ownerSession, 'send_message', { target: 'worker', message: '下级请求' })
    assert.equal(context.children.get(worker.sessionKey)!.delivered.length, 2)
    await context.call(peerSession, 'send_message', { target: outerWorker.taskPath, message: '跨层请求' })
    assert.equal(context.children.get(outerWorker.sessionKey)!.delivered.length, 1)
    await assert.rejects(context.call(ownerSession, 'finish_agent', { report: '不应完成' }), /下级任务完成/)
    await assert.rejects(context.call(context.root.session, 'finish_agent', { report: '不应完成' }), /只有子 Agent/)
  } finally {
    await context.cleanup()
  }
})

test('等待已返回但工具结果尚未确认时，其他反馈不会把同一条消息再次投递', async () => {
  const context = await setup()
  try {
    await context.begin()
    const child = await context.spawn('worker')
    const worker = context.children.get(child.sessionKey)!
    const id = randomUUID()
    const waiting = context.bridge.dispatch(
      context.root.session,
      {
        id,
        method: 'wait_agent',
        params: { targets: ['worker'], timeout_ms: 1000 },
      },
      new AbortController().signal,
    )
    await context.until(async () => (await context.bridge.getAgents('root-key'))[0]!.status === 'waiting_children')
    const first = (await context.call(worker.session, 'send_message', {
      target: '/root',
      message: '第一条反馈',
    })) as CollaborationResults['send_message']
    const result = (await waiting) as CollaborationResults['wait_agent']
    assert.equal(result.messages[0]!.id, first.messageId)
    const second = (await context.call(worker.session, 'send_message', {
      target: '/root',
      message: '第二条反馈',
    })) as CollaborationResults['send_message']
    assert.deepEqual(context.root.delivered, [second.messageId])
    context.bridge.decorateRootEvent('root-key', {
      generation: 1,
      event: {
        type: 'message_end',
        message: {
          role: 'toolResult',
          toolCallId: id,
          toolName: 'wait_agent',
          details: result,
          content: [],
          isError: false,
          timestamp: Date.now(),
        },
      },
    })
    await context.bridge.resumeRoot('root-key')
    assert.deepEqual(context.root.delivered, [second.messageId])
    const records = await context.savedRecords()
    assert.ok(records.every((record) => (record as Record<string, unknown>).waitingMessages === undefined))
  } finally {
    await context.cleanup()
  }
})

test('完成意向遇到新反馈会撤销，处理并重新确认后才提交最终结果', async () => {
  const context = await setup()
  try {
    await context.begin()
    const child = await context.spawn('worker')
    const worker = context.children.get(child.sessionKey)!
    await context.call(worker.session, 'finish_agent', { report: '第一版报告' })
    await context.call(context.root.session, 'send_message', { target: 'worker', message: '还有一项修改' })
    worker.reply('收到，等待补充要求')
    await context.until(
      async () => (await context.bridge.getAgentSnapshot(child.agentId)).agent!.status === 'waiting_children',
    )
    await context.call(context.root.session, 'send_message', { target: 'worker', message: '修改后验收通过' })
    await context.until(async () => worker.continuations.length === 1)
    await worker.finish('已修改并通过验收')
    await context.until(
      async () => (await context.bridge.getAgentSnapshot(child.agentId)).agent!.status === 'completed',
    )
    assert.equal((await context.bridge.getAgentSnapshot(child.agentId)).agent!.report, '已修改并通过验收')
  } finally {
    await context.cleanup()
  }
})

test('消息投递已经开始时，等待只报告发送方，正文不重复进入等待结果', async () => {
  const context = await setup()
  let release!: () => void
  try {
    await context.begin()
    const child = await context.spawn('worker')
    const worker = context.children.get(child.sessionKey)!
    let entered!: () => void
    const entering = new Promise<void>((resolve) => {
      entered = resolve
    })
    worker.faults.deliveryStarted = entered
    worker.faults.deliveryGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const sending = context.call(context.root.session, 'send_message', {
      target: 'worker',
      message: '已经开始投递的反馈',
    })
    await entering
    const result = (await context.call(worker.session, 'wait_agent', {
      targets: ['/root'],
      timeout_ms: 1000,
    })) as CollaborationResults['wait_agent']
    assert.deepEqual(result.messages, [])
    assert.deepEqual(result.notifiedBy, [child.rootAgentId])
    assert.equal(result.timedOut, false)
    release()
    const sent = (await sending) as CollaborationResults['send_message']
    assert.deepEqual(worker.delivered, [sent.messageId])
    const next = (await context.call(worker.session, 'wait_agent', {
      targets: ['/root'],
      timeout_ms: 0,
    })) as CollaborationResults['wait_agent']
    assert.deepEqual(next.messages, [])
    assert.equal(next.notifiedBy, undefined)
    assert.equal(next.timedOut, true)
  } finally {
    release?.()
    await context.cleanup()
  }
})

test('旧任务的等待在新任务开始后取消，不恢复新任务状态或读取新反馈', async () => {
  const context = await setup()
  try {
    await context.begin()
    await context.spawn('worker')
    const waiting = context.call(context.root.session, 'wait_agent', { targets: ['worker'], timeout_ms: 1000 })
    const cancelled = assert.rejects(waiting, /等待所属任务已结束或更换/)
    await context.until(async () => (await context.bridge.getAgents('root-key'))[0]!.status === 'waiting_children')
    await context.begin()
    await cancelled
    assert.equal((await context.bridge.getAgents('root-key'))[0]!.status, 'running')
  } finally {
    await context.cleanup()
  }
})

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
    await childSession.finish('审查完成')
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
    await assert.rejects(context.spawn('code', childSession.session), /不支持嵌套/)
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
    await context.children.get(first.sessionKey)!.finish('结果一')
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
          const target = await context.spawn('worker')
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
          await context.children.get(target.sessionKey)!.finish('完成')
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
    await context.children.get(child.sessionKey)!.finish('完成')
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
    await fake.finish('第一次完成')
    await context.until(async () => fake.prompts.length === 2)
    assert.equal(fake.prompts[1], '排队任务')
    await fake.finish('第二次完成')
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
    await context.children.get(child.sessionKey)!.finish('子任务已完成')
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
    const records = await context.savedRecords()
    const root = records.find((entry) => entry.summary.depth === 0)!
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
    const grandchild = await context.spawnLegacy('leaf', childSession.session)
    await assert.rejects(context.spawn('deep', context.children.get(grandchild.sessionKey)!.session), /不支持嵌套/)
    childSession.reply('等待调查')
    await context.until(
      async () =>
        (await context.bridge.getAgents('root-key')).find((agent) => agent.agentId === child.agentId)!.status ===
        'waiting_children',
    )
    await context.children.get(grandchild.sessionKey)!.finish('叶节点完成')
    await context.until(async () => childSession.continuations.length === 1)
    assert.match(childSession.continuations[0]!, /^A child agent has returned a result\./)
    assert.match(childSession.continuations[0]!, /evidence to review, not automatic acceptance/)
    const resumed = (await context.bridge.getAgents('root-key')).find((agent) => agent.agentId === child.agentId)!
    assert.equal(resumed.epoch, child.epoch)
    assert.equal(resumed.rootTaskId, child.rootTaskId)
    assert.equal(resumed.runId, child.runId)
    await childSession.finish('整理完成')
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
    await context.children.get(child.sessionKey)!.finish('旧任务结果')
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
    await fake.finish('旧轮结果')
    await context.until(async () => fake.prompts.length === 2)
    assert.equal(answered, false)
    await fake.finish('新轮结果')
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
    await context.children.get(child.sessionKey)!.finish('结果正文')
    await context.until(async () => {
      const records = await context.savedRecords()
      return records.find((record) => record.summary.depth === 0)?.summary.status === 'failed'
    })
    const persisted = await context.savedRecords()
    const root = persisted.find((record) => record.summary.depth === 0)!
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
    await context.children.get(child.sessionKey)!.finish('旧结果')
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
    await fake.finish('旧结果')
    await context.until(
      async () =>
        (await context.bridge.getAgents('root-key')).find((entry) => entry.agentId === child.agentId)!.status ===
        'completed',
    )
    assert.deepEqual(fake.prompts, ['子任务'])
    assert.equal(context.root.continuations.length, 0)
    const stored = await context.savedRecords()
    assert.ok(stored.every((record: { queued: unknown[] }) => record.queued.length === 0))
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
    await old.finish('结束')
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

test('idle来源消息只留历史，后续新task不注入真实Pi JSONL', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-collaboration-native-'))
  const fake = await useFakeAgent(directory, { reply: (body) => finishAgentReply(body, '任务完成') })
  const sessions = new Map<string, SdkSession>()
  const bridge = createHostCollaborationBridge({
    dataRoot: directory,
    emit: () => {},
    createSession: (cwd, notify, key) => {
      const session = new SdkSession(cwd, notify, fake.runtimePaths, fake.credentials)
      enableCollaboration(bridge, session)
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
    assert.equal(fake.provider.requests.length, 2)
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
    assert.equal(sources.length, 0)
    await call('followup_task', { target: child.agentId, message: '再继续一次' })
    await completed(child.agentId)
    const finalEntries = (await readFile(active.sessionFile!, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.equal(finalEntries.filter((entry) => entry.details?.messageId === sent.messageId).length, 0)
    const saved = await readSavedRecords(directory)
    const childRecord = saved.find((entry) => entry.summary.agentId === child.agentId)
    assert.equal(
      childRecord?.mailbox.some((message) => message.id === sent.messageId && message.historyOnly),
      true,
    )
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
    await context.children.get(child.sessionKey)!.finish('结果')
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
  const fake = await useFakeAgent(directory, {
    reply: (body) =>
      JSON.stringify(body.messages).includes('You are a child agent executing a delegated task.')
        ? finishAgentReply(body, '子任务完成')
        : '父任务阶段回复',
  })
  const children = new Map<string, SdkSession>()
  const bridge = createHostCollaborationBridge({
    dataRoot: directory,
    emit: () => {},
    createSession: (cwd, notify, key) => {
      const session = new SdkSession(cwd, notify, fake.runtimePaths, fake.credentials)
      enableCollaboration(bridge, session)
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
    assert.ok(childRequest.includes('Inherited parent conversation is background context'))
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
    const partitionFile = path.join(directory, 'state', 'collaboration', 'roots', `${child.rootAgentId}.json`)
    const partition = JSON.parse(await readFile(partitionFile, 'utf8'))
    const savedChild = partition.records.find(
      (record: { summary: AgentSummary }) => record.summary.agentId === child.agentId,
    )
    delete savedChild.summary.conversationOrigin
    await writeFile(partitionFile, JSON.stringify(partition, null, 2))
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
    await context.children.get(child.sessionKey)!.finish('结果')
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
    await worker.finish('完成')
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
    await worker.finish('结果')
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
    await freshWorker.finish('首轮完成')
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
    const records = await context.savedRecords()
    assert.ok(
      records.every(
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

test('子代理设置默认值、单次覆盖、排队快照与单层准入', async () => {
  let defaults: import('@pi-meme/contracts/settings').SubagentDefaults = {
    model: { provider: 'test', id: 'default' },
    thinkingLevel: 'low',
  }
  const context = await setup(undefined, () => defaults)
  try {
    const configured = { provider: 'test', id: 'default', name: '配置模型' }
    const explicit = { provider: 'test', id: 'explicit', name: '单次模型' }
    context.root.models.push(configured, explicit)
    context.root.state.thinkingLevel = 'high'
    await context.begin()
    const child = await context.spawn('worker')
    assert.deepEqual(child.model, configured)
    assert.equal(child.thinkingLevel, 'low')
    const worker = context.children.get(child.sessionKey)!
    await assert.rejects(context.spawn('nested', worker.session), /不支持嵌套/)
    assert.equal((await context.bridge.getAgents('root-key')).length, 2)
    const queued = (await context.call(context.root.session, 'followup_task', {
      target: child.agentId,
      message: '下一项',
      model: explicit,
      thinking_level: 'off',
    })) as CollaborationResults['followup_task']
    assert.equal(queued.queued, true)
    defaults = { model: null, thinkingLevel: null }
    assert.deepEqual(worker.state.model, configured)
    await worker.finish('完成当前任务')
    await context.until(async () => worker.state.model?.id === explicit.id)
    assert.equal(worker.state.thinkingLevel, 'off')
    defaults = { model: { provider: 'missing', id: 'missing' }, thinkingLevel: null }
    await assert.rejects(context.spawn('invalid'), /子代理模型不可用/)
    assert.equal((await context.bridge.getAgents('root-key')).length, 2)
  } finally {
    await context.cleanup()
  }
})

test('临时会话子代理零落盘：flushAll 不向 roots/ 写分片，deleteTemporarySessions 彻底清除内存', async () => {
  const context = await setup()
  try {
    const tempSession = (await import('./coordinator-fixture')).fakeSession(context.directory, {
      connection: () => {},
      event: () => {},
      error: () => {},
    })
    const tempBinding = {
      sessionKey: 'temp-session-key',
      sessionId: 'temp-session-id',
      sessionFile: path.join(context.directory, 'temporary', 'temp-session-id', 'session.jsonl'),
      cwd: context.directory,
      state: tempSession.state,
      accessMode: 'full-access' as const,
      session: tempSession.session,
      temporary: true,
    }
    const rootSummary = await context.bridge.bindRoot(tempBinding)
    assert.equal(rootSummary.name, 'root')

    // 内存中可以读取到该临时根 agent
    const agents = await context.bridge.getAgents('temp-session-key')
    assert.equal(agents.length, 1)
    assert.equal(agents[0]?.sessionKey, 'temp-session-key')

    // 触发 flushAll
    await context.bridge.flushAll()

    // 验证磁盘上 roots 目录绝对没有写入该临时根分片文件
    const rootsDir = path.join(context.directory, 'state', 'collaboration', 'roots')
    const { readdir } = await import('node:fs/promises')
    const rootFiles = await readdir(rootsDir).catch(() => [])
    assert.ok(!rootFiles.some((f) => f.includes(rootSummary.rootAgentId)), 'roots/ 目录下绝无临时根分片')

    // 调用 deleteTemporarySessions 彻底清除
    const result = await context.bridge.deleteTemporarySessions({
      sessionIds: ['temp-session-id'],
      sessionKeys: ['temp-session-key'],
    })
    assert.deepEqual(result.deletedRootAgentIds, [rootSummary.rootAgentId])

    // 验证内存中已被完全清除，再次查询抛出未绑定
    await assert.rejects(context.bridge.getAgents('temp-session-key'), /协作根会话尚未绑定/)
  } finally {
    await context.cleanup()
  }
})

test('关闭临时会话保留其他窗口的计划修订', async () => {
  const context = await setup()
  try {
    const sessions = await Promise.all(
      ['first', 'second'].map(async (key) => {
        const fake = fakeSession(context.directory, { connection: () => {}, event: () => {}, error: () => {} })
        fake.session.start(context.directory)
        const sessionId = fake.session.getActiveSession().sessionId!
        await context.bridge.bindRoot({
          sessionKey: key,
          sessionId,
          cwd: context.directory,
          state: fake.state,
          accessMode: 'full-access',
          session: fake.session,
          temporary: true,
        })
        return { key, sessionId, fake }
      }),
    )
    const [first, second] = sessions
    const document = {
      id: randomUUID(),
      sessionId: second.sessionId,
      runId: randomUUID(),
      revision: 1,
      title: '保留的计划',
      markdown: '执行当前计划',
      updatedAt: new Date().toISOString(),
    }
    second.fake.appendPlan(document)
    await context.bridge.syncPlan(second.fake.session)
    second.fake.entries.length = 0
    await context.bridge.syncPlan(second.fake.session)
    second.fake.appendPlan(document)
    const before = await context.bridge.syncPlan(second.fake.session)
    assert.equal(before.document?.revision, 3)

    await context.bridge.deleteTemporarySessions({ sessionIds: [first.sessionId], sessionKeys: [first.key] })

    const after = await context.bridge.syncPlan(second.fake.session)
    assert.deepEqual(after, before)
    assert.deepEqual(await context.bridge.resolveSessionPlan(second.key, before.document!), before.document)
  } finally {
    await context.cleanup()
  }
})

test('临时会话停止失败后重试仍清理根 Worker', async () => {
  const context = await setup()
  try {
    const fake = fakeSession(context.directory, { connection: () => {}, event: () => {}, error: () => {} })
    const sessionId = fake.session.getActiveSession().sessionId!
    const root = await context.bridge.bindRoot({
      sessionKey: 'temporary-root',
      sessionId,
      cwd: context.directory,
      state: fake.state,
      accessMode: 'full-access',
      session: fake.session,
      temporary: true,
    })
    const stop = fake.session.stopAndWait.bind(fake.session)
    let attempts = 0
    fake.session.stopAndWait = async () => {
      attempts++
      if (attempts === 1) throw new Error('停止 Worker 失败')
      await stop()
    }
    const targets = { sessionIds: [sessionId], sessionKeys: ['temporary-root'] }

    await assert.rejects(context.bridge.deleteTemporarySessions(targets), /停止 Worker 失败/)
    assert.equal((await context.bridge.getAgents('temporary-root'))[0]?.agentId, root.agentId)

    await context.bridge.deleteTemporarySessions(targets)
    assert.equal(attempts, 2)
    await assert.rejects(context.bridge.getAgents('temporary-root'), /协作根会话尚未绑定/)
  } finally {
    await context.cleanup()
  }
})

test('批量清理遇到停止失败时保留所有目标供重试', async () => {
  const context = await setup()
  try {
    const sessions = await Promise.all(
      ['first', 'second'].map(async (key) => {
        const fake = fakeSession(context.directory, { connection: () => {}, event: () => {}, error: () => {} })
        const sessionId = fake.session.getActiveSession().sessionId!
        await context.bridge.bindRoot({
          sessionKey: key,
          sessionId,
          cwd: context.directory,
          state: fake.state,
          accessMode: 'full-access',
          session: fake.session,
          temporary: true,
        })
        return { key, sessionId, fake }
      }),
    )
    const stop = sessions[1].fake.session.stopAndWait.bind(sessions[1].fake.session)
    let attempts = 0
    sessions[1].fake.session.stopAndWait = async () => {
      if (++attempts === 1) throw new Error('停止 Worker 失败')
      await stop()
    }
    const targets = { sessionIds: sessions.map((item) => item.sessionId) }
    await assert.rejects(context.bridge.deleteTemporarySessions(targets), /停止 Worker 失败/)
    for (const item of sessions) assert.equal((await context.bridge.getAgents(item.key)).length, 1)
    await context.bridge.deleteTemporarySessions(targets)
    for (const item of sessions) await assert.rejects(context.bridge.getAgents(item.key), /协作根会话尚未绑定/)
  } finally {
    await context.cleanup()
  }
})
