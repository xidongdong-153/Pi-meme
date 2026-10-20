import assert from 'node:assert/strict'
import { test } from 'vitest'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { readSessionHistory } from '../src/session-history'
import { assistantMessage, userMessage } from '../../../tests/fixtures/messages.mjs'
import { projectMessageSources } from '../src/sdk/ui-source'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'

test('历史回复保留开始时间，以当前分支消息落盘时间投影完成时间且不改写JSONL', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-history-duration-'))
  const file = path.join(directory, 'session.jsonl')
  const startedAt = 1791791839305
  const timestamp = '2026-10-12T07:57:24.763Z'
  const assistant = assistantMessage('历史回复', startedAt)
  const user = userMessage('输入', 1791791839236)
  const entries: SessionEntry[] = [
    { type: 'message', id: 'user', parentId: null, timestamp, message: user },
    { type: 'message', id: 'reply', parentId: 'user', timestamp, message: assistant },
    { type: 'message', id: 'other', parentId: 'user', timestamp: '2026-10-12T08:00:00Z', message: assistant },
    { type: 'session_info', id: 'leaf', parentId: 'reply', timestamp, name: '当前分支' },
  ]
  const content = [{ type: 'session', version: 3, id: 'duration', cwd: directory, timestamp }, ...entries]
    .map((entry) => JSON.stringify(entry))
    .join('\n')
  await writeFile(file, content)
  try {
    const history = await readSessionHistory(file)
    const reply = history.messages.find((message) => message.role === 'assistant')
    assert.equal(reply?.timestamp, startedAt)
    assert.equal(reply?.completedAt, Date.parse(timestamp))
    assert.deepEqual(
      history.messages,
      projectMessageSources(
        entries,
        [
          { ...user, sourceEntry: { id: 'user', type: 'message', revision: 'user' } },
          { ...assistant, sourceEntry: { id: 'reply', type: 'message', revision: 'reply' } },
        ],
        'leaf',
      ),
    )
    assert.equal(await readFile(file, 'utf8'), content)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('历史读取只显示当前分支和压缩后的上下文，追加记录后刷新缓存', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-history-projection-'))
  const file = path.join(directory, 'session.jsonl')
  const timestamp = '2026-09-29T00:00:00Z'
  const content = [
    { type: 'session', version: 3, id: 'session', cwd: directory, timestamp },
    { type: 'message', id: 'old', parentId: null, timestamp, message: userMessage('压缩前的问题', 1) },
    { type: 'message', id: 'abandoned', parentId: 'old', timestamp, message: userMessage('另一条分支', 2) },
    { type: 'message', id: 'current', parentId: 'old', timestamp, message: userMessage('当前问题', 3) },
    {
      type: 'compaction',
      id: 'compact',
      parentId: 'current',
      timestamp,
      firstKeptEntryId: 'current',
      summary: '之前的工作摘要',
      tokensBefore: 100,
    },
    { type: 'model_change', id: 'model', parentId: 'compact', timestamp, provider: 'fake', modelId: 'second' },
    { type: 'thinking_level_change', id: 'thinking', parentId: 'model', timestamp, thinkingLevel: 'high' },
  ]
    .map((entry) => JSON.stringify(entry))
    .join('\n')
  await writeFile(file, content)
  try {
    const history = await readSessionHistory(file)
    assert.equal(history.messages.filter((message) => message.role === 'user').length, 1)
    assert.ok(history.messages.some((message) => message.role === 'user' && message.content === '当前问题'))
    assert.equal(JSON.stringify(history.messages).includes('另一条分支'), false)
    assert.equal(JSON.stringify(history.messages).includes('压缩前的问题'), false)
    assert.deepEqual(history.model, { provider: 'fake', id: 'second' })
    assert.equal(history.thinkingLevel, 'high')
    assert.ok(history.stats)
    assert.ok(history.stats.contextUsage)
    assert.equal(typeof history.stats.contextUsage.tokens, 'number')
    assert.equal(await readFile(file, 'utf8'), content)
    await appendFile(
      file,
      `\n${JSON.stringify({ type: 'session_info', id: 'name', parentId: 'thinking', timestamp, name: '追加后的标题' })}`,
    )
    assert.equal((await readSessionHistory(file)).sessionName, '追加后的标题')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('旧版历史只在内存中迁移，浏览不会改写会话文件', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-history-legacy-'))
  const file = path.join(directory, 'session.jsonl')
  const content = [
    { type: 'session', version: 1, id: 'legacy', cwd: directory, timestamp: '2026-09-29T00:00:00Z' },
    { type: 'message', timestamp: '2026-09-29T00:00:01Z', message: userMessage('旧版历史', 1) },
  ]
    .map((entry) => JSON.stringify(entry))
    .join('\n')
  await writeFile(file, content)
  try {
    assert.equal((await readSessionHistory(file)).messages.length, 1)
    assert.equal(await readFile(file, 'utf8'), content)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
