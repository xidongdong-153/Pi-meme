import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import path from 'node:path'
import { PiSessionPool } from '../src/session-pool'
import { assistantMessage, userMessage } from '../../../tests/fixtures/messages.mjs'
import { useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'

const notify = { connection: () => {}, event: () => {}, error: () => {}, sessionsChanged: () => {} }

/** SDK 会话会带系统提示词和自定义上下文消息；断言对话内容时忽略它们。 */
function dialogue(messages: readonly { role: string }[]) {
  return messages.filter((message) => message.role !== 'system' && message.role !== 'custom')
}

/** 预检完成即返回，整轮运行通过事件推送，需要轮询等待消息落盘。 */
async function waitForDialogue(pool: PiSessionPool, length: number) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (dialogue((await pool.snapshot()).messages).length >= length) return
    await delay(10)
  }
}

test('选择项目不启动运行时，快照和技能读取失败保留原空白会话身份', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-workspace-selection-'))
  const target = path.join(directory, 'target')
  await mkdir(target)
  const agent = await useFakeAgent(directory)
  const pool = new PiSessionPool(directory, notify, undefined, agent.runtimePaths, agent.credentials)
  try {
    pool.prepare(directory)
    const original = await pool.snapshot()
    const getCommands = pool.getCommands.bind(pool)
    pool.getCommands = async () => {
      throw new Error('技能读取失败')
    }
    await assert.rejects(pool.selectWorkspaceDirectory(target), /技能读取失败/)
    assert.equal(pool.connection().sessionKey, original.connection.sessionKey)
    assert.equal(pool.cwd, directory)
    pool.getCommands = getCommands
    const snapshot = pool.snapshot.bind(pool)
    pool.snapshot = async () => {
      throw new Error('快照读取失败')
    }
    await assert.rejects(pool.selectWorkspaceDirectory(target), /快照读取失败/)
    assert.equal(pool.connection().sessionKey, original.connection.sessionKey)
    pool.snapshot = snapshot
    const selected = await pool.selectWorkspaceDirectory(target)
    assert.equal(selected.cancelled, false)
    if (selected.cancelled) return
    assert.equal(selected.snapshot.connection.cwd, target)
    assert.equal(selected.snapshot.connection.workspaceKind, 'project')
    assert.equal(selected.snapshot.connection.status, 'idle')
    assert.deepEqual(selected.snapshot.messages, [])
    assert.ok(selected.commands)
    // 发送时才创建运行时
    await pool.prompt(pool.connection().sessionKey!, '首次发送')
    await waitForDialogue(pool, 2)
    assert.equal(dialogue((await pool.snapshot()).messages).length, 2)
  } finally {
    pool.stop()
    await delay(100)
    await agent.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('快速选择只提交最后目标，无效目录保留当前会话', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-workspace-race-'))
  const first = path.join(directory, 'first')
  const second = path.join(directory, 'second')
  await mkdir(first)
  await mkdir(second)
  const agent = await useFakeAgent(directory)
  const pool = new PiSessionPool(directory, notify, undefined, agent.runtimePaths, agent.credentials)
  try {
    pool.prepare(directory)
    const [a, b] = await Promise.all([pool.selectWorkspaceDirectory(first), pool.selectWorkspaceDirectory(second)])
    assert.equal(a.cancelled, true)
    assert.equal(b.cancelled, false)
    assert.equal(pool.cwd, second)
    const key = pool.connection().sessionKey
    await assert.rejects(pool.selectWorkspaceDirectory(path.join(directory, 'missing')))
    assert.equal(pool.connection().sessionKey, key)
  } finally {
    pool.stop()
    await delay(100)
    await agent.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('无项目新聊天分配独立目录，恢复历史不启动运行时，缺失目录不重建', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-standalone-session-'))
  const root = path.join(directory, 'workspaces')
  await mkdir(root)
  let count = 0
  const allocate = async () => {
    const cwd = path.join(root, String(++count))
    await mkdir(cwd)
    return cwd
  }
  const initial = await allocate()
  const agent = await useFakeAgent(directory)
  const pool = new PiSessionPool(initial, notify, undefined, agent.runtimePaths, agent.credentials)
  pool.configureWorkspaces({
    kind: (cwd) => (cwd.startsWith(`${root}/`) ? 'standalone' : 'project'),
    createStandaloneDirectory: allocate,
  })
  try {
    pool.prepare(initial)
    assert.equal(pool.connection().workspaceKind, 'standalone')
    const next = await pool.newSession()
    assert.equal(next.cancelled, false)
    assert.notEqual(pool.cwd, initial)
    const file = path.join(agent.runtimePaths.sessionDirectory(initial), 'saved.jsonl')
    await mkdir(path.dirname(file), { recursive: true })
    const timestamp = '2026-09-29T00:00:00Z'
    await writeFile(
      file,
      [
        { type: 'session', id: 'saved', version: 3, cwd: initial, timestamp },
        { type: 'message', id: 'user', parentId: null, timestamp, message: userMessage('独立会话', 1) },
        { type: 'message', id: 'answer', parentId: 'user', timestamp, message: assistantMessage('独立正文', 2) },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n'),
    )
    const before = await readFile(file, 'utf8')
    const restored = await pool.switchSession(file)
    assert.equal(restored.cancelled, false)
    if (!restored.cancelled) {
      assert.equal(restored.snapshot.connection.workspaceKind, 'standalone')
      assert.equal(restored.snapshot.connection.status, 'idle')
      assert.equal(dialogue(restored.snapshot.messages).length, 2)
    }
    assert.equal(await readFile(file, 'utf8'), before)
    await pool.newSession()
    await rm(initial, { recursive: true })
    const key = pool.connection().sessionKey
    await assert.rejects(pool.switchSession(file), /无项目会话目录不可用/)
    assert.equal(pool.connection().sessionKey, key)
  } finally {
    pool.stop()
    await delay(100)
    await agent.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
