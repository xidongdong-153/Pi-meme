import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { PiSessionPool } from '../src/session-pool'
import type { DesktopEvent } from '@pi-meme/contracts/desktop'
import { assistantMessage, userMessage } from '../../../tests/fixtures/messages.mjs'
import { useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'
import {
  createTestSession,
  appSessionFile,
  slowReply,
  waitFor,
  dialogue,
  messageText,
  savedSession,
} from './session-pool-fixture'

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
    createTestSession,
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
    createTestSession,
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
    createTestSession,
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
    createTestSession,
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
    createTestSession,
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
    createTestSession,
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
    createTestSession,
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
