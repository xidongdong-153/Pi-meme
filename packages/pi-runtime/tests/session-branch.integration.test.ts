import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import path from 'node:path'
import { PiSessionPool } from '../src/session-pool'
import { loadPiSdk } from '../src/sdk/load'
import type { PiMessage } from '@pi-meme/contracts/pi'
import { useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'
import type { InlineExtension } from '@earendil-works/pi-coding-agent'
import { skillUsageEntry } from '../src/extensions/skill-usage'

function text(message: PiMessage): string {
  const content = 'content' in message ? message.content : undefined
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((part) => (part.type === 'text' ? part.text : '')).join('')
  return ''
}

/** SDK 会话会带一条系统提示词，与 Pi CLI 一致；只比对对话消息。 */
function dialogue(messages: PiMessage[]): PiMessage[] {
  return messages.filter((message) => message.role !== 'system' && message.role !== 'custom')
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

async function withPool(
  run: (pool: PiSessionPool, key: string) => Promise<void>,
  directory: string,
  extensions: InlineExtension[] = [],
) {
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
    pool.configureInlineExtensions([
      {
        name: 'edit-test',
        factory: (pi) => {
          pi.on('input', (event) => (event.text === '编辑被接管' ? { action: 'handled' } : undefined))
          pi.registerCommand('edit-test-command', {
            description: '编辑不能执行此命令',
            handler: async () => assert.fail('编辑时不应执行扩展命令'),
          })
        },
      },
      ...extensions,
    ])
    pool.start(directory)
    await pool.snapshot()
    await run(pool, pool.connection().sessionKey!)
  } finally {
    pool.stop()
    await delay(100)
    await agent.dispose()
  }
}

test('编辑第一轮覆盖原消息及后续，不保留旧版本', async () => {
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
      assert.equal(pool.getRuntimeSessions().find((session) => session.id === key)?.firstMessage, '第一轮编辑版')
      assert.ok(edited.sessionEntries)
      assert.equal(edited.sessionEntries.entries.filter((entry) => entry.role === 'user').length, 1)
      assert.equal(replies(edited.messages), 1)
      const sessionFile = pool.getActiveSession().sessionFile!
      const stored = await readFile(sessionFile, 'utf8')
      assert.doesNotMatch(stored, /"text":"第一轮"|第二轮/)
      assert.equal(edited.connection.sessionKey, key)
      const { SessionManager } = await loadPiSdk()
      assert.deepEqual(users(SessionManager.open(sessionFile).buildSessionContext().messages), ['第一轮编辑版'])
      pool.start(directory, sessionFile)
      const reopened = await pool.snapshot()
      assert.deepEqual(users(reopened.messages), ['第一轮编辑版'])
      assert.equal(SessionManager.open(sessionFile).getSessionId(), JSON.parse(stored.split('\n')[0]).id)
    }, directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('中间轮次可反复覆盖，保留前文和名称，图片及旧后续从原文件移除', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-session-edit-'))
  try {
    await withPool(async (pool, key) => {
      for (const message of ['保留前文', '要修改的第二轮', '要删除的第三轮']) {
        await pool.prompt(key, message)
        await waitForSettled(pool)
      }
      await pool.prompt(key, '/name 保留会话名称')
      const before = await pool.snapshot()
      const prior = dialogue(before.messages).slice(0, 2)
      const originalId = pool.getActiveSession().sessionId
      const sessionFile = pool.getActiveSession().sessionFile!
      const timestamp = dialogue(before.messages).filter((message) => message.role === 'user')[1].timestamp
      const image = {
        type: 'image' as const,
        mimeType: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      }
      await pool.editAndPrompt(key, timestamp, '带图片的新输入', [image])
      await waitForSettled(pool)
      const edited = await pool.snapshot()
      assert.deepEqual(dialogue(edited.messages).slice(0, 2), prior)
      assert.deepEqual(users(edited.messages), ['保留前文', '带图片的新输入'])
      assert.equal(pool.getRuntimeSessions().find((session) => session.id === key)?.firstMessage, '保留前文')
      assert.equal(edited.state.sessionName, '保留会话名称')
      assert.equal(pool.getActiveSession().sessionFile, sessionFile)
      assert.equal(pool.getActiveSession().sessionId, originalId)
      assert.match(await readFile(sessionFile, 'utf8'), new RegExp(image.data.replace(/\+/g, '\\+')))
      const nextTimestamp = dialogue(edited.messages).filter((message) => message.role === 'user')[1].timestamp
      await pool.editAndPrompt(key, nextTimestamp, '第二次修改')
      await waitForSettled(pool)
      const stored = await readFile(sessionFile, 'utf8')
      assert.doesNotMatch(stored, /要修改的第二轮|要删除的第三轮|带图片的新输入|iVBOR/)
      assert.deepEqual(
        (await readdir(path.dirname(sessionFile))).filter((file) => file.endsWith('.jsonl')),
        [path.basename(sessionFile)],
      )
      pool.start(directory, sessionFile)
      const reopened = await pool.snapshot()
      assert.deepEqual(users(reopened.messages), ['保留前文', '第二次修改'])
      assert.deepEqual(dialogue(reopened.messages).slice(0, 2), prior)
      assert.equal(reopened.state.sessionName, '保留会话名称')
      assert.equal(reopened.sessionEntries?.entries.filter((entry) => entry.role === 'user').length, 2)
    }, directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('编辑预检、原子替换和 manager 重载失败均保留原对话并允许重试', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-session-edit-failure-'))
  try {
    await withPool(async (pool, key) => {
      await pool.prompt(key, '不能丢失的原输入')
      await waitForSettled(pool)
      const before = await pool.snapshot()
      const timestamp = dialogue(before.messages).find((message) => message.role === 'user')!.timestamp
      const sessionFile = pool.getActiveSession().sessionFile!
      const original = await readFile(sessionFile, 'utf8')
      const unchanged = async () => {
        assert.equal(await readFile(sessionFile, 'utf8'), original)
        assert.deepEqual(dialogue((await pool.snapshot()).messages), dialogue(before.messages))
      }
      await assert.rejects(pool.editAndPrompt(key, timestamp, '编辑被接管'), /已保留原对话/)
      await unchanged()
      await assert.rejects(pool.editAndPrompt(key, timestamp, '/name 不应改名'), /不能执行内置命令/)
      await unchanged()
      await assert.rejects(pool.editAndPrompt(key, timestamp, '/edit-test-command'), /不能执行扩展命令/)
      await unchanged()
      const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
        throw new Error('模拟原子替换失败')
      })
      syncBuiltinESMExports()
      try {
        await assert.rejects(pool.editAndPrompt(key, timestamp, '写入失败的新输入'), /模拟原子替换失败/)
      } finally {
        rename.mockRestore()
        syncBuiltinESMExports()
      }
      await unchanged()
      const { SessionManager } = await loadPiSdk()
      const reload = vi.spyOn(SessionManager.prototype, 'setSessionFile').mockImplementationOnce(() => {
        throw new Error('模拟 manager 重载失败')
      })
      try {
        await assert.rejects(pool.editAndPrompt(key, timestamp, '重载失败的新输入'), /模拟 manager 重载失败/)
      } finally {
        reload.mockRestore()
      }
      await unchanged()
      assert.equal(
        (await readdir(path.dirname(sessionFile))).some((file) => file.endsWith('.tmp')),
        false,
      )
      await pool.editAndPrompt(key, timestamp, '重试成功的新输入')
      await waitForSettled(pool)
      assert.deepEqual(users((await pool.snapshot()).messages), ['重试成功的新输入'])
    }, directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('编辑等待新用户消息持久化才删除旧记录，并清除被编辑消息自己的技能引用', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-session-edit-admission-'))
  const blocked = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let editing = false
  try {
    await withPool(
      async (pool, key) => {
        await pool.prompt(key, '带技能的旧输入')
        await waitForSettled(pool)
        const before = await pool.snapshot()
        assert.equal(before.state.skillUsages?.length, 1)
        const timestamp = dialogue(before.messages).find((message) => message.role === 'user')!.timestamp
        const sessionFile = pool.getActiveSession().sessionFile!
        const original = await readFile(sessionFile, 'utf8')
        editing = true
        let returned = false
        const sending = pool.editAndPrompt(key, timestamp, '去掉技能的新输入').then(() => {
          returned = true
        })
        await blocked.promise
        await delay(10)
        assert.equal(returned, false)
        assert.equal(await readFile(sessionFile, 'utf8'), original)
        release.resolve()
        await sending
        const accepted = await readFile(sessionFile, 'utf8')
        assert.match(accepted, /去掉技能的新输入/)
        assert.doesNotMatch(accepted, /带技能的旧输入|pi-meme.skill-use/)
        await waitForSettled(pool)
        assert.deepEqual((await pool.snapshot()).state.skillUsages, [])
      },
      directory,
      [
        {
          name: 'edit-admission-test',
          factory: (pi) => {
            pi.on('message_end', (event) => {
              if (event.message.role !== 'user' || editing) return
              pi.appendEntry(skillUsageEntry, {
                id: 'test-skill',
                revision: '1',
                name: 'skill:test-skill',
                path: path.join(directory, 'SKILL.md'),
                source: 'explicit',
                messageTimestamp: event.message.timestamp,
              })
            })
            pi.on('agent_start', async () => {
              if (!editing) return
              blocked.resolve()
              await release.promise
            })
          },
        },
      ],
    )
  } finally {
    release.resolve()
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
