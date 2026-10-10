import assert from 'node:assert/strict'
import { test } from 'node:test'
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { PiSessionPool } from '../src/session-pool'
import { SdkSession } from '../src/sdk/session'
import type { Snapshot, DesktopEvent, DesktopError } from '@pi-meme/contracts/desktop'
import type { PiExtensionDialogRequest } from '@pi-meme/contracts/pi'
import { assistantMessage, userMessage } from '../../../tests/fixtures/messages.mjs'
import { useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'
import { requestText } from '../../../tests/fixtures/fake-provider.mjs'

const extension = fileURLToPath(new URL('../../../tests/fixtures/test-extension.mjs', import.meta.url))

test('消息预约后登记退役不与初始化互等，退役保留本轮直到结束', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-retire-admission-'))
  const agent = await useFakeAgent(directory, { reply: () => ({ text: '已结束', delayMs: 100 }) })
  let armed = false
  let retiring: Promise<boolean> | undefined
  const pool = new PiSessionPool(
    directory,
    {
      connection: () => {},
      event: () => {},
      error: () => {},
      sessionsChanged: () => {
        if (!armed) return
        armed = false
        retiring = pool.retireSessions(() => true)
      },
    },
    undefined,
    agent.runtimePaths,
    agent.credentials,
  )
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    pool.start(directory)
    const key = pool.connection().sessionKey!
    await pool.prompt(key, '旧任务')
    await waitFor(() => pool.getRuntimeSessions().every((record) => !record.running))
    armed = true
    await Promise.race([
      pool.prompt(key, '已预约任务').then(async () => {
        assert.equal((await pool.snapshot()).state.isStreaming, true)
        await retiring
      }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('消息预约与 Worker 退役互相等待')), 5000)
      }),
    ])
    assert.equal(agent.provider.requests.length, 2)
    assert.equal((await pool.snapshot()).state.isStreaming, false)
  } finally {
    clearTimeout(timeout)
    await pool.stopAndWait()
    await retiring
    await agent.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('先登记退役再等待任务树，新消息等待旧 Worker 释放后启动', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-retire-tree-'))
  const agent = await useFakeAgent(directory)
  let session!: SdkSession
  let stops = 0
  const pool = new PiSessionPool(
    directory,
    { connection: () => {}, event: () => {}, error: () => {}, sessionsChanged: () => {} },
    undefined,
    agent.runtimePaths,
    agent.credentials,
    (cwd, notify, paths, credentials, mcp) => {
      session = new SdkSession(cwd, notify, paths, credentials, mcp)
      return session
    },
  )
  let release!: () => void
  const ready = new Promise<void>((resolve) => {
    release = resolve
  })
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    pool.start(directory)
    const key = pool.connection().sessionKey!
    await pool.prompt(key, '旧任务')
    await waitFor(() => pool.getRuntimeSessions().every((record) => !record.running))
    const stop = session.stopAndWait.bind(session)
    session.stopAndWait = async () => {
      stops++
      await stop()
    }
    const retiring = pool.retireSessions(
      (id) => id === key,
      () => ready,
    )
    let started = false
    const prompting = pool.prompt(key, '等待任务树结束的新任务').then(() => {
      started = true
    })
    await delay(20)
    assert.equal(started, false)
    assert.equal(stops, 0)
    assert.equal(agent.provider.requests.length, 1)
    release()
    await Promise.race([
      Promise.all([retiring, prompting]),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('任务树结束后新消息没有启动')), 5000)
      }),
    ])
    await waitFor(() => pool.getRuntimeSessions().every((record) => !record.running))
    assert.equal(stops, 1)
    assert.equal(agent.provider.requests.length, 2)
  } finally {
    release()
    clearTimeout(timeout)
    await pool.stopAndWait()
    await agent.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('扩展命令已 settled 而消息回复尚未返回时，快照不会重新标记运行并阻塞退役', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-settled-prompt-'))
  const agent = await useFakeAgent(directory)
  const extensions = path.join(directory, '.pi', 'extensions')
  await mkdir(extensions, { recursive: true })
  await writeFile(
    path.join(extensions, 'settled-command.js'),
    "export default pi => pi.registerCommand('settled-command', { handler: async () => {} })\n",
  )
  let held = false
  let release!: () => void
  const pool = new PiSessionPool(
    directory,
    { connection: () => {}, event: () => {}, error: () => {}, sessionsChanged: () => {} },
    undefined,
    agent.runtimePaths,
    agent.credentials,
    (cwd, notify, paths, credentials, mcp) => {
      const session = new SdkSession(cwd, notify, paths, credentials, mcp)
      const prompt = session.prompt.bind(session)
      session.prompt = async (...args) => {
        await prompt(...args)
        if (args[0] !== '/settled-command') return
        held = true
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
      return session
    },
  )
  try {
    pool.start(directory)
    const key = pool.connection().sessionKey!
    await pool.prompt(key, '准备会话')
    await waitFor(() => pool.getRuntimeSessions().every((record) => !record.running))
    await pool.setAccessMode(key, 'full-access')
    const pending = pool.prompt(key, '/settled-command')
    await waitFor(() => held)
    assert.equal((await pool.snapshot()).state.isStreaming, false)
    release()
    await pending
    await Promise.race([
      pool.retireSessions((id) => id === key),
      delay(2000).then(() => {
        throw new Error('已结束命令不能阻塞 Worker 退役')
      }),
    ])
  } finally {
    release?.()
    await pool.stopAndWait()
    await agent.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('退役先提供本地快照，在途 Worker 快照失败也回落，不等进程关闭', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-retire-snapshot-'))
  const agent = await useFakeAgent(directory)
  let session!: SdkSession
  const pool = new PiSessionPool(
    directory,
    { connection: () => {}, event: () => {}, error: () => {}, sessionsChanged: () => {} },
    undefined,
    agent.runtimePaths,
    agent.credentials,
    (cwd, notify, paths, credentials, mcp) => {
      session = new SdkSession(cwd, notify, paths, credentials, mcp)
      return session
    },
  )
  let finishStop!: () => void
  let rejectRead!: (cause: Error) => void
  try {
    pool.start(directory)
    const key = pool.connection().sessionKey!
    await pool.prompt(key, '快照退役验收')
    await waitFor(() => pool.getRuntimeSessions().every((record) => !record.running))
    const originalSnapshot = session.snapshot.bind(session)
    const originalStop = session.stopAndWait.bind(session)
    let heldRead = false
    let closing = false
    session.snapshot = () => {
      if (!heldRead) {
        heldRead = true
        return new Promise<Snapshot>((_resolve, reject) => {
          rejectRead = reject
        })
      }
      return originalSnapshot()
    }
    session.stopAndWait = async () => {
      closing = true
      await new Promise<void>((resolve) => {
        finishStop = resolve
      })
      await originalStop()
    }
    const reading = pool.snapshot()
    await waitFor(() => heldRead)
    const retiring = pool.retireSessions((id) => id === key)
    await waitFor(() => closing)
    assert.ok((await pool.snapshot()).messages.some((message) => messageText(message).includes('快照退役验收')))
    rejectRead(new Error('Pi 尚未连接'))
    assert.ok((await reading).messages.some((message) => messageText(message).includes('快照退役验收')))
    finishStop()
    await retiring
    session.stopAndWait = originalStop
  } finally {
    finishStop?.()
    rejectRead?.(new Error('验收结束'))
    await pool.stopAndWait()
    await agent.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

async function installProjectExtension(directory: string, source = extension) {
  const extensionsDirectory = path.join(directory, '.pi', 'extensions')
  await mkdir(extensionsDirectory, { recursive: true })
  const installed = path.join(extensionsDirectory, `${path.basename(source, path.extname(source))}.js`)
  await copyFile(source, installed)
  return installed
}

async function installBrokenProjectExtension(directory: string) {
  const extensionsDirectory = path.join(directory, '.pi', 'extensions')
  await mkdir(extensionsDirectory, { recursive: true })
  const installed = path.join(extensionsDirectory, 'broken-extension.js')
  await writeFile(installed, "throw new Error('模拟扩展加载失败')\n")
  return installed
}

async function appSessionFile(agent: Awaited<ReturnType<typeof useFakeAgent>>, cwd: string, filename: string) {
  const directory = agent.runtimePaths.sessionDirectory(cwd)
  await mkdir(directory, { recursive: true })
  return path.join(directory, filename)
}

/** 提示词里带 slow 的回复延迟 1 秒，用来把会话保持在运行中状态。 */
function slowReply(body: { messages?: unknown[] }) {
  return { text: '收到', delayMs: requestText(body).includes('slow') ? 1000 : 0 }
}

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('等待会话状态超时')
    await delay(10)
  }
}

/** SDK 会话会带一条系统提示词，与 Pi CLI 一致；断言对话内容时忽略它。 */
function dialogue(messages: readonly { role: string }[]) {
  return messages.filter((message) => message.role !== 'system')
}

/** 重连会重新写入权限提示消息，时间戳会变；对比会话正文时只取角色与文本。 */
function conversation(messages: readonly { role: string; content?: unknown }[]) {
  return messages.map((message) => ({ role: message.role, text: messageText(message) }))
}

/** 直播会话里的消息正文是分片数组，读盘历史是纯字符串，断言文本时统一取文本。 */
function messageText(message: { role: string; content?: unknown }): string {
  if (typeof message.content === 'string') return message.content
  if (!Array.isArray(message.content)) return ''
  return message.content
    .filter(
      (part): part is { type: string; text: string } =>
        typeof part === 'object' && part !== null && part.type === 'text',
    )
    .map((part) => part.text)
    .join('')
}

test('两个项目的 Agent 并行运行，切回后台会话和停止当前会话不影响另一任务', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-session-pool-'))
  const secondDirectory = path.join(directory, 'second')
  await mkdir(secondDirectory)
  const agent = await useFakeAgent(directory, { reply: slowReply })
  const events: DesktopEvent[] = []
  let changes = 0
  const pool = new PiSessionPool(
    directory,
    {
      connection: () => {},
      event: (value) => events.push(value),
      error: () => {},
      sessionsChanged: () => {
        changes++
      },
    },
    undefined,
    agent.runtimePaths,
    agent.credentials,
  )
  try {
    pool.start(directory)
    await pool.snapshot()
    await pool.prompt(pool.connection().sessionKey!, '后台任务 A slow')
    const firstPath = pool.getActiveSession().sessionFile!
    pool.newSessionInDirectory(secondDirectory)
    const second = await pool.snapshot()
    assert.notEqual(second.connection.sessionKey, undefined)
    await pool.prompt(pool.connection().sessionKey!, '后台任务 B slow')
    const secondPath = pool.getActiveSession().sessionFile!
    await waitFor(() => pool.getRuntimeSessions().filter((session) => session.running).length === 2)
    assert.ok(
      events.some((value) => value.sessionKey !== pool.connection().sessionKey && value.event.type === 'agent_start'),
    )
    await assert.rejects(
      pool.idle(async () => {}),
      /有会话正在运行/,
    )
    await pool.switchSession(firstPath)
    assert.equal(pool.cwd, directory)
    assert.equal((await pool.snapshot()).state.isStreaming, true)
    assert.ok(pool.getRuntimeSessions().some((session) => session.firstMessage === '后台任务 A slow'))
    await pool.abort(pool.connection().sessionKey!)
    await waitFor(() => pool.getRuntimeSessions().filter((session) => session.running).length === 1)
    assert.equal(pool.getRuntimeSessions().find((session) => session.path === secondPath)?.running, true)
    const firstCompletion = pool.getRuntimeSessions().find((session) => session.path === firstPath)?.completedAt
    assert.ok(firstCompletion)
    await pool.switchSession(secondPath)
    assert.equal(pool.cwd, secondDirectory)
    assert.equal((await pool.snapshot()).state.isStreaming, true)
    await pool.abort(pool.connection().sessionKey!)
    await waitFor(() => pool.getRuntimeSessions().every((session) => !session.running))
    await pool.switchSession(firstPath)
    assert.equal(pool.getRuntimeSessions().find((session) => session.path === firstPath)?.completedAt, firstCompletion)
    assert.ok(changes >= 6)
  } finally {
    pool.stop()
    await delay(100)
    await agent.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('权限切换保留实际执行代次，确认请求通过过期过滤且回答后正确关闭', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-pool-dialog-generation-'))
  const agent = await useFakeAgent(directory)
  await installProjectExtension(directory)
  let session!: SdkSession
  let emit!: (event: DesktopEvent) => void
  let highestExecutionGeneration = 0
  const events: DesktopEvent[] = []
  const accepted: DesktopEvent[] = []
  const pool = new PiSessionPool(
    directory,
    {
      connection: () => {},
      event: (event) => {
        events.push(event)
        const executionGeneration = event.executionGeneration ?? event.generation
        if (executionGeneration < highestExecutionGeneration) return
        highestExecutionGeneration = executionGeneration
        accepted.push(event)
      },
      error: () => {},
      sessionsChanged: () => {},
    },
    undefined,
    agent.runtimePaths,
    agent.credentials,
    (cwd, notify, paths, credentials, mcp) => {
      emit = notify.event
      session = new SdkSession(cwd, notify, paths, credentials, mcp)
      return session
    },
  )
  const view = pool.createClientView()
  try {
    await pool.withClientView(view, async () => {
      pool.start(directory)
      await pool.snapshot()
      const key = pool.connection().sessionKey!
      view.generation = 40
      await pool.setAccessMode(key, 'full-access')
      const changed = events.find((event) => event.event.type === 'access_mode_changed')!
      assert.equal(changed.generation, 40)
      assert.equal(changed.executionGeneration, session.connection().generation)
      assert.ok(changed.executionGeneration! < changed.generation)
      const prompting = pool.prompt(key, '扩展任务')
      await waitFor(() => events.some((event) => event.event.type === 'extension_ui_request'))
      const dialog = accepted.find(
        (event): event is DesktopEvent & { event: PiExtensionDialogRequest } =>
          event.event.type === 'extension_ui_request' && event.event.method === 'confirm',
      )
      assert.ok(dialog, '确认请求不能被权限切换事件的界面代次误判为过期')
      assert.equal(dialog.executionGeneration, session.connection().generation)
      view.generation = 80
      await pool.respondExtensionUI(key, dialog.event.id, { confirmed: true })
      const closed = accepted.find(
        (event) => event.event.type === 'extension_ui_closed' && event.event.id === dialog.event.id,
      )!
      assert.equal(closed.generation, 80)
      assert.equal(closed.executionGeneration, dialog.executionGeneration)
      await prompting
      await waitFor(() => pool.getRuntimeSessions().every((record) => !record.running))
      assert.ok(!((await pool.snapshot()).events ?? []).some((event) => event.event.type === 'extension_ui_request'))
      const acceptedCount = accepted.length
      const staleGeneration = dialog.executionGeneration! - 1
      emit({ generation: staleGeneration, event: { type: 'extension_ui_closed', id: '旧请求', reason: 'cancelled' } })
      assert.equal(events.at(-1)?.executionGeneration, staleGeneration)
      assert.equal(accepted.length, acceptedCount)
    })
  } finally {
    await pool.stopAndWait()
    pool.releaseClientView(view)
    await agent.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('后台扩展弹窗保留在所属会话，切回后可以响应，其他会话继续运行', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-pool-dialog-'))
  const agent = await useFakeAgent(directory, { reply: slowReply })
  await installProjectExtension(directory)
  const events: DesktopEvent[] = []
  const pool = new PiSessionPool(
    directory,
    {
      connection: () => {},
      event: (value) => events.push(value),
      error: () => {},
      sessionsChanged: () => {},
    },
    undefined,
    agent.runtimePaths,
    agent.credentials,
  )
  try {
    pool.start(directory)
    await pool.snapshot()
    const key = pool.connection().sessionKey!
    await pool.setAccessMode(key, 'full-access')
    const prompting = pool.prompt(key, '扩展任务')
    await waitFor(() => events.some((record) => record.event.type === 'extension_ui_request'))
    const firstPath = pool.getActiveSession().sessionFile!
    await pool.newSession()
    await pool.snapshot()
    events.length = 0
    const selected = await pool.switchSession(firstPath)
    assert.equal(selected.cancelled, false)
    if (!selected.cancelled) events.push(...(selected.snapshot.events ?? []))
    const dialog = events.find(
      (record): record is DesktopEvent & { event: PiExtensionDialogRequest } =>
        record.sessionKey === key && record.event.type === 'extension_ui_request' && record.event.method === 'confirm',
    )
    assert.ok(dialog)
    await assert.rejects(pool.respondExtensionUI(key, dialog.event.id, { value: '无效首答' }), /响应|参数|确认/)
    const answers = await Promise.allSettled([
      pool.respondExtensionUI(key, dialog.event.id, { confirmed: true }),
      pool.respondExtensionUI(key, dialog.event.id, { confirmed: false }),
    ])
    assert.equal(answers.filter((answer) => answer.status === 'fulfilled').length, 1)
    assert.equal(
      events.filter((record) => record.event.type === 'extension_ui_closed' && record.event.id === dialog.event.id)
        .length,
      1,
    )
    await prompting
    await pool.newSession()
    await pool.snapshot()
    events.length = 0
    const returned = await pool.switchSession(firstPath)
    if (!returned.cancelled) events.push(...(returned.snapshot.events ?? []))
    assert.ok(
      !events.some((record) => record.event.type === 'extension_ui_request' && record.event.id === dialog.event.id),
    )
  } finally {
    pool.stop()
    await delay(100)
    await agent.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('空白会话重复新建不会增加会话，切走后释放，首次发送才进入列表', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-empty-sessions-'))
  const secondDirectory = path.join(directory, 'second')
  await mkdir(secondDirectory)
  const agent = await useFakeAgent(directory)
  const pool = new PiSessionPool(
    directory,
    {
      connection: () => {},
      event: () => {},
      error: () => {},
      sessionsChanged: () => {},
    },
    undefined,
    agent.runtimePaths,
    agent.credentials,
  )
  try {
    pool.start(directory)
    await pool.snapshot()
    const firstKey = pool.connection().sessionKey!
    const generation = pool.connection().generation
    await pool.newSession()
    assert.equal(pool.connection().generation, generation)
    assert.equal(pool.getRuntimeSessions().length, 0)
    pool.newSessionInDirectory(secondDirectory)
    await pool.snapshot()
    assert.equal(pool.getRuntimeHistory(firstKey), null)
    assert.equal(pool.getRuntimeSessions().length, 0)
    await pool.prompt(pool.connection().sessionKey!, '首次发送')
    const sentPath = pool.getActiveSession().sessionFile!
    assert.equal(pool.getRuntimeSessions().length, 1)
    await pool.newSession()
    await pool.snapshot()
    const emptyKey = pool.connection().sessionKey!
    await pool.newSession()
    assert.equal(pool.connection().sessionKey, emptyKey)
    await pool.switchSession(sentPath)
    assert.equal(pool.getRuntimeHistory(emptyKey), null)
    assert.equal(pool.getRuntimeSessions().length, 1)
    await pool.abort(pool.connection().sessionKey!)
  } finally {
    pool.stop()
    await delay(100)
    await agent.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('新建和读取冷会话不启动运行时，发送期间切换仍发送到原会话', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-lazy-sessions-'))
  const agent = await useFakeAgent(directory, {
    reply: slowReply,
    models: [
      { id: 'first', name: '模型 first', reasoning: true },
      { id: 'second', name: '模型 second', reasoning: true },
    ],
  })
  const sessionFile = await appSessionFile(agent, directory, 'saved.jsonl')
  const pool = new PiSessionPool(
    directory,
    {
      connection: () => {},
      event: () => {},
      error: () => {},
      sessionsChanged: () => {},
    },
    undefined,
    agent.runtimePaths,
    agent.credentials,
  )
  await writeFile(
    sessionFile,
    [
      { type: 'session', id: 'saved', version: 3, cwd: directory, timestamp: '2026-09-29T01:00:00Z' },
      {
        type: 'model_change',
        id: 'model',
        parentId: null,
        timestamp: '2026-09-29T01:00:00Z',
        provider: 'fake',
        modelId: 'first',
      },
      {
        type: 'message',
        id: 'user',
        parentId: 'model',
        timestamp: '2026-09-29T01:00:01Z',
        message: userMessage('历史问题', 1),
      },
      {
        type: 'message',
        id: 'answer',
        parentId: 'user',
        timestamp: '2026-09-29T01:00:02Z',
        message: assistantMessage('历史正文', 2),
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n'),
  )
  const original = await readFile(sessionFile, 'utf8')
  try {
    pool.prepare(directory)
    await pool.newSession()
    await pool.switchSession(sessionFile)
    const saved = await pool.snapshot()
    assert.equal(saved.connection.status, 'idle')
    assert.deepEqual(
      dialogue(saved.messages).map((message) => message.role),
      ['user', 'assistant'],
    )
    assert.ok(saved.stats)
    assert.ok(saved.stats.contextUsage)
    assert.equal(typeof saved.stats.contextUsage.tokens, 'number')
    const poolStats = await pool.getSessionStats()
    assert.equal(poolStats.tokens.total, saved.stats.tokens.total)
    assert.equal(await readFile(sessionFile, 'utf8'), original)
    const sending = pool.prompt(pool.connection().sessionKey!, 'background-stream slow')
    await pool.newSession()
    assert.equal(pool.connection().status, 'idle')
    assert.equal(dialogue((await pool.snapshot()).messages).length, 0)
    await sending
    // 后台会话确实拿到消息，空白会话没有被启动
    await pool.switchSession(sessionFile)
    const running = await pool.snapshot()
    assert.ok(
      dialogue(running.messages).some(
        (message) => message.role === 'user' && messageText(message) === 'background-stream slow',
      ),
    )
    assert.equal(pool.getRuntimeSessions().find((session) => session.path === sessionFile)?.running, true)
    await pool.abort(pool.connection().sessionKey!)
    await pool.newSession()
    const blankKey = pool.connection().sessionKey
    await pool.prompt(saved.connection.sessionKey!, '定向发送 slow')
    await pool.followUp(saved.connection.sessionKey!, '定向排队')
    assert.equal(pool.connection().sessionKey, blankKey)
    assert.equal(dialogue((await pool.snapshot()).messages).length, 0)
    await pool.switchSession(sessionFile)
    assert.equal((await pool.snapshot()).state.pendingMessageCount, 1)
    await pool.abort(pool.connection().sessionKey!)
    await pool.newSession()
    await pool.setModel(pool.connection().sessionKey!, { provider: 'fake', id: 'second' })
    await pool.setThinkingLevel(pool.connection().sessionKey!, 'high')
    assert.equal(pool.connection().status, 'idle')
    await pool.prompt(pool.connection().sessionKey!, '新会话任务')
    const fresh = await pool.snapshot()
    assert.equal(fresh.state.model?.id, 'second')
    assert.equal(fresh.state.thinkingLevel, 'high')
    await pool.abort(pool.connection().sessionKey!)
  } finally {
    pool.stop()
    await delay(100)
    await agent.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('冷会话加载损坏项目扩展时保留历史，修复后可继续', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-lazy-failure-'))
  const agent = await useFakeAgent(directory)
  const brokenExtension = await installBrokenProjectExtension(directory)
  const sessionFile = await appSessionFile(agent, directory, 'saved.jsonl')
  await writeFile(
    sessionFile,
    [
      { type: 'session', version: 3, id: 'saved', cwd: directory, timestamp: '2026-09-29T00:00:00Z' },
      {
        type: 'message',
        id: 'user',
        parentId: null,
        timestamp: '2026-09-29T00:00:01Z',
        message: userMessage('历史问题', 1),
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n'),
  )
  const errors: DesktopError[] = []
  const pool = new PiSessionPool(
    directory,
    {
      connection: () => {},
      event: () => {},
      error: (value) => errors.push(value),
      sessionsChanged: () => {},
    },
    undefined,
    agent.runtimePaths,
    agent.credentials,
  )
  try {
    pool.prepare(directory)
    await pool.switchSession(sessionFile)
    const key = pool.connection().sessionKey!
    await pool.setAccessMode(key, 'full-access')
    await pool.prompt(key, '新问题')
    await waitFor(() => errors.some((error) => error.message.includes('Pi 扩展加载失败')))
    await waitFor(() => pool.getRuntimeSessions().every((session) => !session.running))
    assert.deepEqual(
      dialogue((await pool.snapshot()).messages).map((message) => message.role),
      ['user', 'user', 'assistant'],
    )
    assert.equal(pool.connection().status, 'ready')
    await rm(brokenExtension, { force: true })
    await pool.idle(() => pool.reconnectModels(), true)
    assert.equal(pool.connection().error, undefined)
    await pool.prompt(key, '修复后重试')
    await waitFor(() => pool.getRuntimeSessions().every((session) => !session.running))
    assert.deepEqual(
      dialogue((await pool.snapshot()).messages).map((message) => message.role),
      ['user', 'user', 'assistant', 'user', 'assistant'],
    )
  } finally {
    pool.stop()
    await delay(100)
    await agent.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

async function savedSession(agent: Awaited<ReturnType<typeof useFakeAgent>>, directory: string, name: string) {
  const file = await appSessionFile(agent, directory, `${name}.jsonl`)
  await writeFile(
    file,
    [
      { type: 'session', id: name, version: 3, cwd: directory, timestamp: '2026-09-29T00:00:00Z' },
      {
        type: 'model_change',
        id: 'model',
        parentId: null,
        timestamp: '2026-09-29T00:00:00Z',
        provider: 'fake',
        modelId: 'first',
      },
      {
        type: 'message',
        id: 'user',
        parentId: 'model',
        timestamp: '2026-09-29T00:00:01Z',
        message: userMessage(name, 1),
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n'),
  )
  return file
}

test('连续选择只返回最后一次的目标快照，空白页释放后拒绝旧目标操作', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-selection-'))
  const agent = await useFakeAgent(directory)
  const pool = new PiSessionPool(
    directory,
    {
      connection: () => {},
      event: () => {},
      error: () => {},
      sessionsChanged: () => {},
    },
    undefined,
    agent.runtimePaths,
    agent.credentials,
  )
  try {
    const first = await savedSession(agent, directory, 'first')
    const second = await savedSession(agent, directory, 'second')
    pool.prepare(directory)
    const blank = pool.connection().sessionKey!
    const openingFirst = pool.switchSession(first)
    const openingSecond = pool.switchSession(second)
    assert.equal((await openingFirst).cancelled, true)
    const selected = await openingSecond
    assert.equal(selected.cancelled, false)
    if (!selected.cancelled) {
      assert.equal(selected.snapshot.connection.sessionFile, second)
      assert.equal(selected.snapshot.connection.status, 'idle')
      assert.deepEqual(dialogue(selected.snapshot.messages)[0], userMessage('second', 1))
    }
    await assert.rejects(pool.abort(blank), /目标会话已关闭/)
    await assert.rejects(pool.prompt(blank, '不应发送'), /目标会话已关闭/)
  } finally {
    pool.stop()
    await delay(100)
    await agent.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('会话池拒绝加载 Desktop 应用数据目录外的历史会话', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-external-session-'))
  const agent = await useFakeAgent(directory)
  await mkdir(agent.runtimePaths.sessionsDirectory, { recursive: true })
  const externalSession = path.join(directory, 'external.jsonl')
  await writeFile(
    externalSession,
    JSON.stringify({
      type: 'session',
      id: 'external',
      version: 3,
      cwd: directory,
      timestamp: new Date().toISOString(),
    }),
  )
  const pool = new PiSessionPool(
    directory,
    { connection: () => {}, event: () => {}, error: () => {}, sessionsChanged: () => {} },
    undefined,
    agent.runtimePaths,
    agent.credentials,
  )
  try {
    pool.prepare(directory)
    await assert.rejects(pool.switchSession(externalSession), /Desktop 只能打开应用内保存的会话/)
  } finally {
    pool.stop()
    await agent.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('重连报告项目扩展错误时保留会话内容，修复后清除错误', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-pool-restore-'))
  const agent = await useFakeAgent(directory)
  const brokenExtension = await installBrokenProjectExtension(directory)
  const errors: DesktopError[] = []
  const pool = new PiSessionPool(
    directory,
    {
      connection: () => {},
      event: () => {},
      error: (value) => errors.push(value),
      sessionsChanged: () => {},
    },
    undefined,
    agent.runtimePaths,
    agent.credentials,
  )
  try {
    const first = await savedSession(agent, directory, 'first')
    const second = await savedSession(agent, directory, 'second')
    pool.start(directory, first)
    await pool.snapshot()
    const firstKey = pool.connection().sessionKey!
    await pool.setSteeringMode(firstKey, 'all')
    await pool.switchSession(second)
    const secondKey = pool.connection().sessionKey!
    await pool.setThinkingLevel(secondKey, 'high')
    await pool.idle(() => pool.reconnectModels(), true)
    assert.deepEqual(
      pool.getRuntimeSessions().map((session) => session.id),
      [firstKey, secondKey],
    )
    assert.equal((await pool.snapshot()).state.thinkingLevel, 'high')
    await pool.switchSession(first)
    assert.equal(pool.connection().sessionKey, firstKey)
    assert.equal(pool.connection().status, 'idle')
    assert.deepEqual(dialogue((await pool.snapshot()).messages)[0], userMessage('first', 1))
    assert.equal((await pool.snapshot()).state.steeringMode, 'all')
    await pool.prompt(firstKey, 'long-conversation')
    await waitFor(() => pool.getRuntimeSessions().every((session) => !session.running))
    const before = await pool.snapshot()
    // 项目扩展加载错误只报告诊断，不丢弃历史或会话身份
    await pool.setAccessMode(firstKey, 'full-access')
    await pool.idle(() => pool.reconnectModels(), true)
    assert.deepEqual(conversation((await pool.snapshot()).messages), conversation(before.messages))
    assert.equal(pool.connection().sessionKey, firstKey)
    assert.ok(errors.some((error) => error.message.includes('Pi 扩展加载失败')))
    await rm(brokenExtension, { force: true })
    await pool.idle(() => pool.reconnectModels(), true)
    assert.deepEqual(conversation((await pool.snapshot()).messages), conversation(before.messages))
    assert.equal(pool.getRuntimeSessions().length, 2)
    assert.equal(pool.connection().error, undefined)
  } finally {
    pool.stop()
    await delay(100)
    await agent.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('恢复时模型不可用保留原选择，重新选择前禁止发送', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-pool-model-'))
  const agent = await useFakeAgent(directory, {
    models: [
      { id: 'first', name: '模型 first', reasoning: true },
      { id: 'second', name: '模型 second', reasoning: true },
    ],
  })
  const pool = new PiSessionPool(
    directory,
    {
      connection: () => {},
      event: () => {},
      error: () => {},
      sessionsChanged: () => {},
    },
    undefined,
    agent.runtimePaths,
    agent.credentials,
  )
  try {
    const file = await savedSession(agent, directory, 'saved')
    pool.prepare(directory)
    await pool.switchSession(file)
    const key = pool.connection().sessionKey!
    await pool.setModel(key, { provider: 'fake', id: 'removed' })
    await pool.idle(() => pool.reconnectModels(), true)
    const snapshot = await pool.snapshot()
    assert.equal(snapshot.state.modelSelectionRequired, true)
    assert.equal(snapshot.state.model?.id, 'removed')
    await assert.rejects(pool.prompt(key, '不应发送'), /先重新选择模型/)
    await pool.setModel(key, { provider: 'fake', id: 'second' })
    await pool.prompt(key, 'long-conversation')
    await waitFor(() => pool.getRuntimeSessions().every((session) => !session.running))
    assert.equal((await pool.snapshot()).state.model?.id, 'second')
  } finally {
    pool.stop()
    await delay(100)
    await agent.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('后台会话停止只结束一次，后台目标操作不影响当前会话', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-pool-abort-'))
  const agent = await useFakeAgent(directory, { reply: slowReply })
  const events: DesktopEvent[] = []
  const pool = new PiSessionPool(
    directory,
    {
      connection: () => {},
      event: (event) => events.push(event),
      error: () => {},
      sessionsChanged: () => {},
    },
    undefined,
    agent.runtimePaths,
    agent.credentials,
  )
  try {
    pool.start(directory)
    await pool.snapshot()
    const firstKey = pool.connection().sessionKey!
    await pool.prompt(firstKey, 'background-stream slow')
    await waitFor(() => pool.getRuntimeSessions().some((session) => session.running))
    await pool.newSession()
    const currentKey = pool.connection().sessionKey!
    await pool.abort(firstKey)
    assert.equal(pool.connection().sessionKey, currentKey)
    assert.equal(pool.getRuntimeSessions().find((session) => session.id === firstKey)?.running, false)
    await delay(20)
    assert.equal(
      events.filter((event) => event.sessionKey === firstKey && event.event.type === 'agent_settled').length,
      1,
    )
    await pool.prompt(firstKey, 'long-conversation')
    assert.equal(pool.connection().sessionKey, currentKey)
    await pool.abort(firstKey)
  } finally {
    pool.stop()
    await delay(100)
    await agent.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('用户扩展按会话生效，后台扩展异常不污染当前会话，重连后清除', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-extension-pool-'))
  const agent = await useFakeAgent(directory)
  const projectExtension = await installProjectExtension(directory)
  const errors: DesktopError[] = []
  const pool = new PiSessionPool(
    directory,
    {
      connection: () => {},
      event: () => {},
      error: (value) => errors.push(value),
      sessionsChanged: () => {},
    },
    undefined,
    agent.runtimePaths,
    agent.credentials,
  )
  try {
    pool.prepare(directory)
    const key = pool.connection().sessionKey!
    await pool.setAccessMode(key, 'full-access')
    await pool.prompt(key, 'long-conversation')
    await waitFor(() => pool.getRuntimeSessions().every((session) => !session.running))
    await pool.newSession()
    const second = pool.connection().sessionKey!
    await pool.prompt(key, '扩展异常')
    await waitFor(() => errors.some((error) => error.sessionKey === key))
    await waitFor(() => pool.getRuntimeSessions().every((session) => !session.running))
    assert.equal(pool.connection().sessionKey, second)
    assert.equal((await pool.snapshot()).extensionError, undefined)
    assert.match(errors.at(-1)?.message ?? '', /扩展异常|扩展故意失败/)
    const sessions = pool.getRuntimeSessions()
    const first = sessions.find((entry) => entry.id === key)!
    await pool.switchSession(first.path)
    const snapshot = await pool.snapshot()
    assert.equal(snapshot.extensionError?.extension?.path, projectExtension)
    assert.equal(snapshot.extensionError?.generation, snapshot.connection.generation)
    assert.equal(snapshot.connection.error, undefined)
    await pool.idle(() => pool.reconnectModels(), true)
    assert.equal((await pool.snapshot()).extensionError, undefined)
  } finally {
    pool.stop()
    await delay(100)
    await agent.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('历史会话停留与重复快照保持 idle，首次发送才启动运行时', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-warmup-sessions-'))
  const agent = await useFakeAgent(directory)
  const sessionFile = await appSessionFile(agent, directory, 'saved.jsonl')
  const pool = new PiSessionPool(
    directory,
    {
      connection: () => {},
      event: () => {},
      error: () => {},
      sessionsChanged: () => {},
    },
    undefined,
    agent.runtimePaths,
    agent.credentials,
  )
  await writeFile(
    sessionFile,
    [
      { type: 'session', id: 'saved', version: 3, cwd: directory, timestamp: '2026-09-29T01:00:00Z' },
      {
        type: 'model_change',
        id: 'model',
        parentId: null,
        timestamp: '2026-09-29T01:00:00Z',
        provider: 'fake',
        modelId: 'first',
      },
      {
        type: 'message',
        id: 'user',
        parentId: 'model',
        timestamp: '2026-09-29T01:00:01Z',
        message: userMessage('历史问题', 1),
      },
      {
        type: 'message',
        id: 'answer',
        parentId: 'user',
        timestamp: '2026-09-29T01:00:02Z',
        message: assistantMessage('历史正文', 2),
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n'),
  )
  try {
    pool.prepare(directory)
    await pool.switchSession(sessionFile)
    const initial = await pool.snapshot()
    assert.equal(initial.connection.status, 'idle')
    assert.ok(initial.stats)
    assert.ok(initial.stats.contextUsage)

    const before = await readFile(sessionFile, 'utf8')
    await delay(300)
    const retained = await pool.snapshot()
    assert.equal(retained.connection.status, 'idle')
    assert.equal(await readFile(sessionFile, 'utf8'), before)
    await pool.prompt(retained.connection.sessionKey!, '历史之后的新问题')
    const warmed = await pool.snapshot()
    assert.equal(warmed.connection.status, 'ready')
    assert.ok(warmed.stats)
  } finally {
    pool.stop()
    await delay(100)
    await agent.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('迟到模式hook和Plan首次装配不覆盖用户关闭；准备期间第三方扩展不启动', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-pool-mode-race-'))
  const agent = await useFakeAgent(directory, { reply: { text: '完成', holdMs: 50 } })
  const marker = path.join(directory, 'default-extension')
  let release!: () => void
  let enter!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let persistedMode = 'default'
  const pool = new PiSessionPool(
    directory,
    { connection: () => {}, event: () => {}, error: () => {}, sessionsChanged: () => {} },
    undefined,
    agent.runtimePaths,
    agent.credentials,
    (cwd, notify, paths, credentials, mcp) => {
      const session = new SdkSession(cwd, notify, paths, credentials, mcp)
      return session
    },
  )
  pool.configureInlineExtensions([
    {
      name: 'third-party',
      factory: (pi) => {
        pi.on('session_start', async () => {
          await writeFile(marker, '执行第三方')
        })
      },
    },
  ])
  pool.configureCollaboration({
    modeChanged: async (key, mode) => {
      if (mode === 'plan') {
        enter()
        await gate
      }
      persistedMode = pool.getSessionContext(key).state.mode
    },
    beforePrompt: async () => {},
    settled: async () => {},
    failed: async () => {},
    stop: async () => {},
  })
  try {
    pool.prepare(directory)
    const key = pool.connection().sessionKey!
    await pool.setAccessMode(key, 'full-access')
    const prompting = pool.prompt(key, '计划需求', undefined, [], { mode: 'plan' })
    await entered
    await pool.setSessionMode(key, 'default')
    release()
    await prompting
    await assert.rejects(readFile(marker), /ENOENT/)
    await waitFor(() => pool.getRuntimeSessions().every((record) => !record.running))
    assert.equal(persistedMode, 'default')
    assert.equal((await pool.snapshot()).state.mode, 'default')
    const tools = agent.provider.requests[0].tools.map((tool: { function: { name: string } }) => tool.function.name)
    assert.ok(!tools.includes('bash') && !tools.includes('write') && !tools.includes('edit'))
    await pool.prompt(key, '后续普通需求')
    await waitFor(() => pool.getRuntimeSessions().every((record) => !record.running))
    assert.equal(await readFile(marker, 'utf8'), '执行第三方')
  } finally {
    release?.()
    await pool.stopAndWait()
    await agent.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
