import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import path from 'node:path'
import { PiSessionPool } from '../src/session-pool'
import type { PiMessage } from '@pi-meme/contracts/pi'
import { useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'

function text(message: PiMessage): string {
  const content = 'content' in message ? message.content : undefined
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((part) => (part.type === 'text' ? part.text : '')).join('')
  return ''
}

/** SDK 会话会带一条系统提示词，与 Pi CLI 一致；只比对对话消息。 */
function dialogue(messages: PiMessage[]): PiMessage[] {
  return messages.filter((message) => message.role !== 'system')
}

function users(messages: PiMessage[]): string[] {
  return dialogue(messages)
    .filter((message) => message.role === 'user')
    .map(text)
}

function replies(messages: PiMessage[]): number {
  return dialogue(messages).filter((message) => message.role === 'assistant').length
}

async function waitForSettled(pool: PiSessionPool) {
  const deadline = Date.now() + 5000
  while (pool.getRuntimeSessions().some((session) => session.running)) {
    if (Date.now() > deadline) throw new Error('等待会话结束超时')
    await delay(10)
  }
}

async function withPool(run: (pool: PiSessionPool, key: string) => Promise<void>, directory: string) {
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
    await run(pool, pool.connection().sessionKey!)
  } finally {
    pool.stop()
    await delay(100)
    await agent.dispose()
  }
}

test('编辑第一轮后切回旧版本恢复完整后续对话，切回新版本只显示新版本分支', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-session-branch-'))
  try {
    await withPool(async (pool, key) => {
      await pool.prompt(key, '第一轮')
      await waitForSettled(pool)
      await pool.prompt(key, '第二轮')
      await waitForSettled(pool)
      const original = await pool.snapshot()
      assert.deepEqual(users(original.messages), ['第一轮', '第二轮'])

      const firstTimestamp = dialogue(original.messages).find((message) => message.role === 'user')!.timestamp
      await pool.editAndPrompt(key, firstTimestamp, '第一轮编辑版')
      await waitForSettled(pool)
      const edited = await pool.snapshot()
      assert.deepEqual(users(edited.messages), ['第一轮编辑版'])
      assert.ok(edited.sessionEntries)
      assert.equal(edited.sessionEntries.entries.filter((entry) => entry.role === 'user').length, 3)

      // 切回旧版本：必须恢复 A1、B1、A2、B2 的完整后续对话
      assert.equal(await pool.switchMessageVersion(key, firstTimestamp, 0), true)
      const restored = await pool.snapshot()
      assert.deepEqual(users(restored.messages), ['第一轮', '第二轮'])
      assert.equal(replies(restored.messages), 2)

      // 切回新版本：只显示新版本分支
      assert.equal(await pool.switchMessageVersion(key, firstTimestamp, 1), true)
      const latest = await pool.snapshot()
      assert.deepEqual(users(latest.messages), ['第一轮编辑版'])
      assert.equal(replies(latest.messages), 1)
    }, directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('从历史回复 Fork 只复制截至该回复的上下文，原会话保持不变', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-session-fork-'))
  try {
    await withPool(async (pool, key) => {
      await pool.prompt(key, '第一轮')
      await waitForSettled(pool)
      await pool.prompt(key, '第二轮')
      await waitForSettled(pool)
      const before = await pool.snapshot()
      const firstTimestamp = dialogue(before.messages).find((message) => message.role === 'user')!.timestamp

      const result = await pool.forkReply(key, firstTimestamp)
      assert.equal(result.cancelled, false)
      if (result.cancelled) return
      const forked = result.snapshot.messages
      assert.deepEqual(users(forked), ['第一轮'])
      assert.equal(replies(forked), 1)
      assert.notEqual(result.snapshot.connection.sessionKey, key)

      // 原会话内容与 leaf 保持原样
      const original = await pool.switchSession(pool.getRuntimeSessions().find((s) => s.id === key)!.path)
      assert.equal(original.cancelled, false)
      if (original.cancelled) return
      assert.deepEqual(users(original.snapshot.messages), ['第一轮', '第二轮'])
    }, directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
