import { expect, test, vi } from 'vitest'
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { readSessionHistory, invalidateSessionHistory } from '../src/session-history'
import { markHistoryAppend } from '../src/session-history-index'
import { projectSessionWindow } from '@pi-meme/contracts/session-window'
import { assistantMessage, userMessage } from '../../../tests/fixtures/messages.mjs'

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-index-'))
  const file = path.join(root, 'data/sessions/project/history.jsonl')
  await mkdir(path.dirname(file), { recursive: true })
  const timestamp = '2026-10-27T00:00:00Z'
  const entries = [
    { type: 'session', version: 3, id: 'session', cwd: root, timestamp },
    ...Array.from({ length: 120 }, (_, index) => ({
      type: 'message',
      id: `m${index}`,
      parentId: index ? `m${index - 1}` : null,
      timestamp,
      message: index % 2 ? assistantMessage(`回复${index}`, index) : userMessage(`问题${index}`, index),
    })),
  ]
  await writeFile(file, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`)
  return { root, file, timestamp }
}

test('索引分页与完整投影一致，详情延迟读取且不改原生文件', async () => {
  const { root, file } = await fixture()
  try {
    const original = await readFile(file, 'utf8')
    const full = await readSessionHistory(file)
    for (const options of [{ limit: 10 }, { limit: 10, before: 'm100' }, { limit: 10, from: 'm80' }]) {
      const page = await readSessionHistory(file, { ...options, details: 'deferred' })
      const expected = projectSessionWindow(full, options)
      expect(page.messages).toEqual(expected.messages)
      expect(page.messagePage).toEqual(expected.messagePage)
      expect(page.totalMessages).toBe(120)
      expect(page.historyDetails).toBe('deferred')
      expect(page.sessionEntries!.entries.length).toBeLessThan(full.sessionEntries!.entries.length)
      expect(page.branchAttachments).toBeUndefined()
    }
    expect(await readdir(path.join(root, 'cache/session-history'))).toHaveLength(1)
    expect(await readFile(file, 'utf8')).toBe(original)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('追加编辑、压缩和等长重写使索引失效，仍遵守当前分支语义', async () => {
  const { root, file, timestamp } = await fixture()
  try {
    await readSessionHistory(file, { limit: 10, details: 'deferred' })
    await appendFile(
      file,
      `${JSON.stringify({ type: 'context_edit', id: 'edit', parentId: 'm119', targetId: 'm110', timestamp, replacement: { content: '已更新' } })}\n`,
    )
    let full = await readSessionHistory(file)
    let page = await readSessionHistory(file, { limit: 10, details: 'deferred' })
    expect(page.messages).toEqual(projectSessionWindow(full, { limit: 10 }).messages)
    const edited = page.messages.find((message) => message.sourceEntry?.id === 'm110')
    expect(edited && 'content' in edited ? edited.content : undefined).toBe('已更新')
    await appendFile(
      file,
      `${JSON.stringify({ type: 'compaction', id: 'compact', parentId: 'edit', firstKeptEntryId: 'm100', summary: '之前的摘要', tokensBefore: 1000, timestamp })}\n`,
    )
    full = await readSessionHistory(file)
    page = await readSessionHistory(file, { limit: 10, details: 'deferred' })
    expect(page.messages).toEqual(projectSessionWindow(full, { limit: 10 }).messages)
    await appendFile(
      file,
      `${JSON.stringify({
        type: 'message',
        id: 'branch',
        parentId: 'm80',
        timestamp,
        message: assistantMessage('另一条分支', 122),
      })}\n`,
    )
    full = await readSessionHistory(file)
    page = await readSessionHistory(file, { limit: 10, details: 'deferred' })
    expect(page.messages).toEqual(projectSessionWindow(full, { limit: 10 }).messages)
    expect(page.messages.some((message) => message.sourceEntry?.id === 'm110')).toBe(false)
    const previous = await readFile(file, 'utf8')
    const info = await stat(file)
    await writeFile(file, previous.replace('问题80', '问题99'))
    await utimes(file, info.atime, info.mtime)
    expect((await readSessionHistory(file, { limit: 10, details: 'deferred' })).messages).toEqual(
      projectSessionWindow(await readSessionHistory(file), { limit: 10 }).messages,
    )
    invalidateSessionHistory([file])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('重新打开控制器时复用持久索引，不完整读取原生正文；损坏索引自动重建', async () => {
  const { root, file } = await fixture()
  try {
    const first = await readSessionHistory(file, { limit: 10, details: 'deferred' })
    vi.resetModules()
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs/promises')>()
      return {
        ...actual,
        readFile: (...args: Parameters<typeof actual.readFile>) => {
          if (args[0] === file) throw new Error('索引命中时不得完整读取原生正文')
          return actual.readFile(...args)
        },
      }
    })
    const restored = await import('../src/session-history')
    const page = await restored.readSessionHistory(file, { limit: 10, details: 'deferred' })
    expect(page.messages).toEqual(first.messages)
    vi.doUnmock('node:fs/promises')
    vi.resetModules()
    const [index] = await readdir(path.join(root, 'cache/session-history'))
    await writeFile(path.join(root, 'cache/session-history', index), '{损坏')
    const rebuilt = await import('../src/session-history')
    expect((await rebuilt.readSessionHistory(file, { limit: 10, details: 'deferred' })).messages).toEqual(
      first.messages,
    )
  } finally {
    vi.doUnmock('node:fs/promises')
    vi.resetModules()
    await rm(root, { recursive: true, force: true })
  }
})

test('已确认的普通追加保留旧消息和统计，索引不保存消息正文', async () => {
  const { root, file, timestamp } = await fixture()
  try {
    const before = await readSessionHistory(file, { limit: 10, details: 'deferred' })
    await appendFile(
      file,
      `${JSON.stringify({ type: 'message', id: 'new', parentId: 'm119', timestamp, message: userMessage('追加消息', 121) })}\n`,
    )
    markHistoryAppend(file)
    const page = await readSessionHistory(file, { limit: 10, details: 'deferred' })
    const full = await readSessionHistory(file)
    expect(page.messages).toEqual(projectSessionWindow(full, { limit: 10 }).messages)
    expect(page.stats).toEqual(full.stats)
    expect(page.totalMessages).toBe(before.totalMessages! + 1)
    const [index] = await readdir(path.join(root, 'cache/session-history'))
    const content = await readFile(path.join(root, 'cache/session-history', index), 'utf8')
    expect(content).not.toContain('追加消息')
    expect(content).not.toContain('回复119')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
