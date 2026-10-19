import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { SdkSession } from '../src/sdk/session'
import { safeBranchLeaf } from '../src/safe-session-fork'
import { assertPlanTool } from '../src/extensions/plan-mode'
import type { PiSessionEntry } from '@pi-meme/contracts/pi'
import type { TaskMode } from '@pi-meme/contracts/plan'
import { useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'

function entry(id: string, parentId: string | null, message: unknown): PiSessionEntry {
  return { id, parentId, timestamp: '2026-10-10', type: 'message', message } as PiSessionEntry
}

test('安全分支排除整个未闭合工具批次，保留闭合prefix和compaction；新需求在未闭合组之后明确拒绝', () => {
  const entries = [
    entry('u', null, { role: 'user', content: '任务' }),
    {
      id: 'c',
      parentId: 'u',
      type: 'compaction',
      timestamp: '2026-10-10',
      summary: '摘要',
      firstKeptEntryId: 'u',
      tokensBefore: 100,
    } as PiSessionEntry,
    entry('a', 'c', {
      role: 'assistant',
      content: [
        { type: 'toolCall', id: 'one', name: 'read' },
        { type: 'toolCall', id: 'two', name: 'read' },
      ],
    }),
    entry('r1', 'a', { role: 'toolResult', toolCallId: 'one' }),
    entry('r2', 'r1', { role: 'toolResult', toolCallId: 'two' }),
  ]
  assert.equal(safeBranchLeaf(entries, 'r1'), 'c')
  assert.equal(safeBranchLeaf(entries, 'r2'), 'r2')
  assert.throws(
    () => safeBranchLeaf([...entries, entry('new', 'r1', { role: 'user', content: '最新需求' })], 'new'),
    /最新用户消息/,
  )
  assert.equal(safeBranchLeaf([...entries, entry('other', 'u', { role: 'user', content: '其他分支' })], 'r1'), 'c')
})

test('Plan执行链拒绝写入、bash、MCP、codemode和第三方工具，同时允许协作及完成工具', () => {
  for (const name of ['bash', 'user_bash', 'write', 'edit', 'mcp__read', 'codemode', 'external'])
    assert.throws(() => assertPlanTool('plan', name), /规划模式不能执行/)
  for (const name of [
    'read',
    'grep',
    'find',
    'ls',
    'spawn_agent',
    'send_message',
    'followup_task',
    'interrupt_agent',
    'list_agents',
    'wait_agent',
    'finish_agent',
    'request_user_input',
    'save_plan',
  ])
    assert.doesNotThrow(() => assertPlanTool('plan', name))
})

test('跨模式输入保留各自mode，计划队列逐条admission且关闭模式不改变正在执行的轮次', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-plan-queue-'))
  const fake = await useFakeAgent(directory, {
    reply: (_body, index) => ({ text: `第${index}轮完成`, holdMs: index === 1 ? 150 : 0 }),
  })
  const admissions: TaskMode[] = []
  const session = new SdkSession(
    directory,
    { connection: () => {}, error: () => {}, event: () => {} },
    fake.runtimePaths,
    fake.credentials,
    undefined,
    {
      onAdmission: async (_message, mode) => {
        admissions.push(mode)
      },
    },
  )
  try {
    session.start(directory)
    await session.snapshot()
    await session.setModel({ provider: 'fake', id: 'first' })
    await session.prompt('正在执行的任务')
    await session.followUp('计划第一项', undefined, [], { mode: 'plan' })
    await session.followUp('计划第二项', undefined, [], { mode: 'plan' })
    await session.setSessionMode('default')
    assert.equal((await session.snapshot()).state.activeMode, 'default')
    const deadline = Date.now() + 5000
    while (admissions.length < 3 || (await session.snapshot()).state.isStreaming) {
      if (Date.now() > deadline) throw new Error('队列没有逐条执行')
      await delay(10)
    }
    assert.deepEqual(admissions, ['default', 'plan', 'plan'])
    assert.equal((await session.snapshot()).state.mode, 'default')
    assert.equal(fake.provider.requests.length, 3)
    for (const request of fake.provider.requests.slice(1)) {
      const tools = request.tools?.map((tool: { function: { name: string } }) => tool.function.name) ?? []
      assert.ok(!tools.includes('bash') && !tools.includes('write') && !tools.includes('edit'))
    }
  } finally {
    await session.stopAndWait()
    await fake.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('切到Plan重建服务时不运行第三方session_start；撤回队列保留原文而非技能展开正文', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-plan-extension-'))
  const fake = await useFakeAgent(directory, { reply: { text: '保持执行', holdMs: 1000 } })
  const marker = path.join(directory, 'extension-started')
  const session = new SdkSession(
    directory,
    { connection: () => {}, error: () => {}, event: () => {} },
    fake.runtimePaths,
    fake.credentials,
  )
  session.configureInlineExtensions([
    {
      name: 'third-party',
      factory: (pi) => {
        pi.on('session_start', async () => {
          await writeFile(marker, '运行了扩展')
        })
      },
    },
  ])
  try {
    session.start(directory)
    await session.snapshot()
    assert.equal(await readFile(marker, 'utf8'), '运行了扩展')
    await rm(marker)
    await session.setSessionMode('plan')
    await assert.rejects(readFile(marker), /ENOENT/)
    await session.setModel({ provider: 'fake', id: 'first' })
    await session.prompt('分析任务')
    await session.followUp('排队原文', undefined, [], { mode: 'plan' })
    const cleared = await session.clearQueue()
    assert.equal(cleared.followUp[0]!.text, '排队原文')
    assert.equal(cleared.followUp[0]!.mode, 'plan')
    assert.ok(cleared.followUp[0]!.id)
  } finally {
    await session.abort().catch(() => {})
    await session.stopAndWait()
    await fake.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('准入拒绝与准入期间Abort都回到idle，下一轮仍能正常发送', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-plan-admission-'))
  const fake = await useFakeAgent(directory)
  let rejectAdmission = true
  let waitAdmission = false
  let entered!: () => void
  const entering = new Promise<void>((resolve) => {
    entered = resolve
  })
  const session = new SdkSession(
    directory,
    { connection: () => {}, error: () => {}, event: () => {} },
    fake.runtimePaths,
    fake.credentials,
    undefined,
    {
      onAdmission: async (_message, _mode, _continuation, signal) => {
        if (rejectAdmission) throw new Error('Host拒绝准入')
        if (waitAdmission) {
          entered()
          await new Promise<void>((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(new Error('准入已取消')), { once: true }),
          )
        }
      },
    },
  )
  try {
    session.start(directory)
    await session.snapshot()
    await session.setModel({ provider: 'fake', id: 'first' })
    await assert.rejects(session.prompt('被拒任务'), /Host拒绝准入/)
    await session.assertIdle()
    rejectAdmission = false
    waitAdmission = true
    const pending = session.prompt('等待准入')
    await entering
    await session.abort()
    await assert.rejects(pending, /准入已取消/)
    await session.assertIdle()
    waitAdmission = false
    await session.prompt('有效任务')
    const deadline = Date.now() + 5000
    while ((await session.snapshot()).state.isStreaming) {
      if (Date.now() > deadline) throw new Error('有效任务没有完成')
      await delay(10)
    }
    assert.equal(fake.provider.requests.length, 1)
  } finally {
    await session.stopAndWait()
    await fake.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('子代理结果的头像和起止时间写入原生记录，重建后保留且重复交付不追加', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-result-timestamps-'))
  const fake = await useFakeAgent(directory)
  const session = new SdkSession(
    directory,
    { connection: () => {}, error: () => {}, event: () => {} },
    fake.runtimePaths,
    fake.credentials,
  )
  const message = {
    id: 'result-stable',
    fromAgentId: 'child',
    toAgentId: 'root',
    rootTaskId: 'task',
    epoch: 1,
    runId: 'child-run',
    kind: 'result' as const,
    status: 'completed' as const,
    name: 'reviewer',
    avatar: 'security' as const,
    text: '完整结果正文',
    startedAt: new Date(1000).toISOString(),
    completedAt: new Date(2000).toISOString(),
    createdAt: new Date(2100).toISOString(),
  }
  try {
    session.start(directory)
    await session.snapshot()
    await session.setModel({ provider: 'fake', id: 'first' })
    await session.prompt('主任务')
    const deadline = Date.now() + 5000
    while ((await session.snapshot()).state.isStreaming) {
      if (Date.now() > deadline) throw new Error('主任务未完成')
      await delay(10)
    }
    assert.equal((await session.deliverCollaborationMessage(message)).persisted, true)
    const file = session.getActiveSession().sessionFile!
    await session.stopAndWait()
    session.start(directory, file)
    const restored = await session.snapshot()
    const report = restored.messages.find(
      (entry) => entry.role === 'custom' && entry.customType === 'pi-meme-collaboration',
    )
    assert.ok(report?.role === 'custom')
    assert.equal(report.display, false)
    assert.equal((report.details as { avatar?: string }).avatar, message.avatar)
    assert.equal((report.details as { startedAt?: string }).startedAt, message.startedAt)
    assert.equal((report.details as { completedAt?: string }).completedAt, message.completedAt)
    assert.equal((await session.deliverCollaborationMessage(message)).persisted, true)
    assert.equal(
      (await session.getEntries()).entries.filter(
        (entry) => entry.type === 'custom_message' && entry.customType === 'pi-meme-collaboration',
      ).length,
      1,
    )
  } finally {
    await session.stopAndWait()
    await fake.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('公开CustomMessage在安全边界写原生JSONL，以messageId去重，重建后重复交付不追加', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-source-message-'))
  const fake = await useFakeAgent(directory, { reply: { text: '等待边界', holdMs: 100 } })
  const session = new SdkSession(
    directory,
    { connection: () => {}, error: () => {}, event: () => {} },
    fake.runtimePaths,
    fake.credentials,
  )
  const message = {
    id: 'message-stable',
    fromAgentId: 'child',
    toAgentId: 'root',
    rootTaskId: 'task',
    epoch: 1,
    kind: 'message' as const,
    text: '来源正文',
    createdAt: new Date().toISOString(),
  }
  try {
    session.start(directory)
    await session.snapshot()
    await session.setModel({ provider: 'fake', id: 'first' })
    await session.prompt('运行任务')
    assert.equal((await session.deliverCollaborationMessage(message)).persisted, false)
    assert.equal((await session.deliverCollaborationMessage(message)).persisted, false)
    const deadline = Date.now() + 5000
    while ((await session.snapshot()).state.isStreaming) {
      if (Date.now() > deadline) throw new Error('来源消息没有到达安全边界')
      await delay(10)
    }
    const entries = (await session.getEntries()).entries.filter(
      (entry) => entry.type === 'custom_message' && entry.customType === 'pi-meme-collaboration',
    )
    assert.equal(entries.length, 1)
    const file = session.getActiveSession().sessionFile!
    assert.match(await readFile(file, 'utf8'), /message-stable/)
    await session.stopAndWait()
    session.start(directory, file)
    await session.snapshot()
    assert.equal((await session.deliverCollaborationMessage(message)).persisted, true)
    assert.equal(
      (await session.getEntries()).entries.filter(
        (entry) => entry.type === 'custom_message' && entry.customType === 'pi-meme-collaboration',
      ).length,
      1,
    )
  } finally {
    await session.stopAndWait()
    await fake.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('真实Pi wait_agent工具结果保留details.messages，message_end可作为JSONL读取ACK', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-wait-ack-'))
  const fake = await useFakeAgent(directory, {
    reply: (_body, index) => (index === 1 ? { tool: { name: 'wait_agent', arguments: '{}' } } : '汇总完成'),
  })
  const completed: unknown[] = []
  const source = {
    id: 'result-child-run',
    fromAgentId: 'child',
    toAgentId: 'root',
    rootTaskId: 'task',
    epoch: 1,
    runId: 'child-run',
    kind: 'result' as const,
    text: '子结果',
    createdAt: new Date().toISOString(),
  }
  const session = new SdkSession(
    directory,
    {
      connection: () => {},
      error: () => {},
      event: (event) => {
        if (event.event.type === 'message_end' && event.event.message.role === 'toolResult')
          completed.push(event.event.message.details)
      },
    },
    fake.runtimePaths,
    fake.credentials,
  )
  session.configureInlineExtensions([
    {
      name: 'pi-meme-collaboration',
      factory: (pi) => {
        pi.registerTool({
          name: 'wait_agent',
          label: '等待',
          description: '读取子结果',
          parameters: { type: 'object', properties: {}, additionalProperties: false } as never,
          execute: async () => ({
            content: [{ type: 'text', text: source.text }],
            details: { agents: [], messages: [source], timedOut: false },
          }),
        })
      },
    },
  ])
  try {
    session.start(directory)
    await session.snapshot()
    await session.setModel({ provider: 'fake', id: 'first' })
    await session.prompt('读取结果')
    const deadline = Date.now() + 5000
    while ((await session.snapshot()).state.isStreaming) {
      if (Date.now() > deadline) throw new Error('等待工具没有完成')
      await delay(10)
    }
    assert.deepEqual((completed[0] as { messages: unknown[] }).messages, [source])
    const result = (await session.getEntries()).entries.find(
      (entry) => entry.type === 'message' && entry.message.role === 'toolResult',
    )
    assert.ok(result?.type === 'message' && result.message.role === 'toolResult')
    assert.deepEqual((result.message.details as { messages: unknown[] }).messages, [source])
    const before = (await session.getEntries()).entries
    assert.deepEqual(await session.deliverCollaborationMessage(source), { persisted: true })
    assert.deepEqual((await session.getEntries()).entries, before)
  } finally {
    await session.stopAndWait()
    await fake.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('Plan准备期间关闭模式只改变未来模式，不执行第三方startup；续汇总也不覆盖未来mode', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-plan-preparing-'))
  const fake = await useFakeAgent(directory)
  const marker = path.join(directory, 'extension-started')
  const admissions: TaskMode[] = []
  const session = new SdkSession(
    directory,
    { connection: () => {}, error: () => {}, event: () => {} },
    fake.runtimePaths,
    fake.credentials,
    undefined,
    {
      onAdmission: async (_message, mode) => {
        admissions.push(mode)
      },
    },
  )
  session.configureInlineExtensions([
    {
      name: 'third-party',
      factory: (pi) => {
        pi.on('session_start', async () => {
          await writeFile(marker, '第三方已运行')
        })
      },
    },
  ])
  try {
    session.start(directory)
    await session.snapshot()
    await session.setModel({ provider: 'fake', id: 'first' })
    await rm(marker)
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const entering = new Promise<void>((resolve) => {
      entered = resolve
    })
    const capture = session.captureRestoreState.bind(session)
    session.captureRestoreState = async () => {
      entered()
      await gate
      return capture()
    }
    const preparing = session.prompt('计划任务', undefined, [], { mode: 'plan' })
    await entering
    await session.setSessionMode('default')
    release()
    await preparing
    await assert.rejects(readFile(marker), /ENOENT/)
    while ((await session.snapshot()).state.isStreaming) await delay(5)
    assert.equal((await session.snapshot()).state.mode, 'default')
    await session.continueCollaborationTask('根据子结果继续计划', 'plan')
    while ((await session.snapshot()).state.isStreaming) await delay(5)
    assert.equal((await session.snapshot()).state.mode, 'default')
    assert.deepEqual(admissions, ['plan', 'plan'])
    const history = (await readFile(session.getActiveSession().sessionFile!, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.equal(history.filter((entry) => entry.type === 'message' && entry.message.role === 'user').length, 1)
    const control = history.filter(
      (entry) => entry.type === 'custom_message' && entry.customType === 'pi-meme-collaboration-control',
    )
    assert.equal(control.length, 1)
    assert.equal(control[0].display, false)
    assert.equal((await session.snapshot()).messages.filter((message) => message.role === 'user').length, 1)
    assert.equal(
      (await session.snapshot()).sessionEntries!.entries.filter(
        (entry) => entry.customType === 'pi-meme-collaboration-control' && entry.display === false,
      ).length,
      1,
    )
    for (const request of fake.provider.requests) {
      const tools = request.tools?.map((tool: { function: { name: string } }) => tool.function.name) ?? []
      assert.ok(!tools.includes('bash') && !tools.includes('write') && !tools.includes('edit'))
    }
    await session.prompt('后续普通任务')
    while ((await session.snapshot()).state.isStreaming) await delay(5)
    assert.equal(await readFile(marker, 'utf8'), '第三方已运行')
    assert.equal(admissions.at(-1), 'default')
  } finally {
    await session.stopAndWait()
    await fake.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
