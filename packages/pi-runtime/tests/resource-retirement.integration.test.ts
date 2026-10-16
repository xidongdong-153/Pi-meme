import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { PiSessionPool } from '../src/session-pool'
import type { SdkSession } from '../src/sdk/session'
import type { Snapshot, DesktopEvent, DesktopError } from '@pi-meme/contracts/desktop'
import { skillMarker } from '@pi-meme/contracts/skills'
import type { PiExtensionDialogRequest } from '@pi-meme/contracts/pi'
import { userMessage } from '../../../tests/fixtures/messages.mjs'
import { useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'
import {
  createTestSession,
  installProjectExtension,
  installBrokenProjectExtension,
  appSessionFile,
  slowReply,
  waitFor,
  dialogue,
  conversation,
  messageText,
  savedSession,
} from './session-pool-fixture'

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
    createTestSession,
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
      session = createTestSession(cwd, notify, paths, credentials, mcp)
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
  const extensions = path.join(directory, 'test-native-agents')
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
      const session = createTestSession(cwd, notify, paths, credentials, mcp)
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
      session = createTestSession(cwd, notify, paths, credentials, mcp)
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

test('资源退役等待暂停队列，保留提交时的技能修订直到用户删除输入', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-retire-queue-'))
  const agent = await useFakeAgent(directory, { reply: () => ({ text: '完成', holdMs: 80 }) })
  let session!: SdkSession
  let stops = 0
  const events: DesktopEvent[] = []
  const pool = new PiSessionPool(
    directory,
    {
      connection: () => {},
      error: () => {},
      sessionsChanged: () => {},
      event: (event) => events.push(event),
    },
    undefined,
    agent.runtimePaths,
    agent.credentials,
    (...args) => {
      session = createTestSession(...args)
      return session
    },
  )
  let retiring: Promise<boolean> | undefined
  try {
    pool.start(directory)
    const key = pool.connection().sessionKey!
    await pool.prompt(key, '初始任务')
    const reference = { id: 'submitted-skill', revision: 'old-revision', name: 'skill:queued' }
    await pool.followUp(key, '保留原引用', undefined, [reference])
    const queued = events.findLast((value) => value.event.type === 'queue_update')!.event
    assert.ok(queued.type === 'queue_update')
    const input = queued.followUp[0]!
    await session.beginQueueEdit(input.id, 'client')
    await waitFor(() => pool.getRuntimeSessions().every((record) => !record.running))
    const prompt = session.prompt.bind(session)
    session.prompt = async () => {
      throw new Error('测试排队准入失败')
    }
    await session.releaseQueueEdits('client')
    await waitFor(() => events.some((value) => value.event.type === 'pause_update' && value.event.queuePaused))
    session.prompt = prompt
    const stop = session.stopAndWait.bind(session)
    session.stopAndWait = async () => {
      stops++
      await stop()
    }
    retiring = pool.retireSessions((id) => id === key)
    await delay(30)
    assert.equal(stops, 0)
    const snapshot = await pool.snapshot()
    const queue = snapshot.events!.findLast((value) => value.event.type === 'queue_update')!.event
    assert.ok(queue.type === 'queue_update')
    assert.deepEqual(queue.followUp[0]?.skills, [reference])
    await pool.deleteQueueInput(key, input.id)
    await retiring
    assert.equal(stops, 1)
  } finally {
    await pool.stopAndWait()
    await retiring
    await agent.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('排队输入出队后仍在展开技能时，资源退役等待准入和本轮结束', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-retire-prepare-'))
  const agent = await useFakeAgent(directory, { reply: () => ({ text: '完成', holdMs: 60 }) })
  const skill = path.join(directory, 'SKILL.md')
  await writeFile(skill, '---\nname: queued\ndescription: 排队技能\n---\n排队正文')
  let session!: SdkSession
  let held = false
  let release!: () => void
  let stops = 0
  const pool = new PiSessionPool(
    directory,
    { connection: () => {}, event: () => {}, error: () => {}, sessionsChanged: () => {} },
    undefined,
    agent.runtimePaths,
    agent.credentials,
    (...args) => {
      session = createTestSession(...args)
      return session
    },
  )
  let retiring: Promise<boolean> | undefined
  try {
    pool.start(directory)
    const key = pool.connection().sessionKey!
    await pool.prompt(key, '初始任务')
    session.getCommands = async () => {
      held = true
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return [
        {
          name: 'skill:queued',
          resourceId: 'queued',
          resourceRevision: 'submitted',
          source: 'skill',
          sourceInfo: { path: skill, baseDir: directory, scope: 'user', source: 'host', origin: 'top-level' },
        },
      ]
    }
    const stop = session.stopAndWait.bind(session)
    session.stopAndWait = async () => {
      stops++
      await stop()
    }
    await pool.followUp(key, `${skillMarker} 使用原技能`, undefined, [
      { id: 'queued', revision: 'submitted', name: 'skill:queued' },
    ])
    await waitFor(() => held)
    retiring = pool.retireSessions((id) => id === key)
    await delay(30)
    assert.equal(stops, 0)
    release()
    await retiring
    assert.equal(stops, 1)
    assert.equal(agent.provider.requests.length, 2)
  } finally {
    release?.()
    await pool.stopAndWait()
    await retiring
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
    createTestSession,
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
    createTestSession,
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
    createTestSession,
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
    createTestSession,
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
    assert.equal(snapshot.extensionError?.extension?.path, `<inline:test-native:${projectExtension}>`)
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
      const session = createTestSession(cwd, notify, paths, credentials, mcp)
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
