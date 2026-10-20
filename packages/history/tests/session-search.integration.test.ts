import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { BuiltinModuleContext } from '@pi-meme/contracts/builtin-module'
import { create } from '../src/server/entry'
import { searchSessionFile, sessionSearchExcerpt } from '../src/server/session-search'
import { assistantMessage, userMessage } from '../../../tests/fixtures/messages.mjs'

test('正文检索忽略大小写，返回命中附近摘要，不包含工具输出、思考或图片', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'history-search-'))
  t.onTestFinished(() => rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'session.jsonl')
  const messages = [
    { role: 'toolResult', content: [{ type: 'text', text: '只有工具的秘密' }] },
    assistantMessage([{ type: 'thinking', thinking: '只有思考的秘密' }]),
    userMessage('第一条输入'),
    assistantMessage(`前文${'说明'.repeat(80)} NEEDLE ${'后文'.repeat(100)}`),
  ]
  await writeFile(
    file,
    [
      JSON.stringify({ type: 'session', id: 'session', cwd: root }),
      '{损坏的记录',
      ...messages.map((message) => JSON.stringify({ type: 'message', message })),
    ].join('\n'),
  )
  const excerpt = await searchSessionFile(file, 'needle')
  assert.ok(excerpt)
  assert.ok(excerpt.includes('NEEDLE'))
  assert.ok(excerpt.startsWith('…') && excerpt.endsWith('…'))
  assert.ok(excerpt.length < 180)
  assert.equal(await searchSessionFile(file, '秘密'), undefined)
  assert.equal(
    sessionSearchExcerpt({ role: 'user', content: [{ type: 'image', data: 'needle' }] }, 'needle'),
    undefined,
  )
})

test('搜索仅读取显式目标，拒绝越界和外部链接，支持运行中历史，不改变选择', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'history-search-handler-'))
  t.onTestFinished(() => rm(root, { recursive: true, force: true }))
  const directory = path.join(root, 'sessions')
  await mkdir(directory)
  const file = path.join(directory, 'saved.jsonl')
  const outside = path.join(root, 'outside.jsonl')
  const contents = [
    { type: 'session', id: 'saved', cwd: root },
    { type: 'message', message: userMessage('需要找到的正文') },
  ]
    .map((entry) => JSON.stringify(entry))
    .join('\n')
  await writeFile(file, contents)
  await writeFile(outside, contents)
  await symlink(outside, path.join(directory, 'escape.jsonl'))
  let handlers!: Record<string, (...args: unknown[]) => unknown>
  create({
    services: {
      require: () => ({
        sessions: { getSessionsDirectory: async () => directory },
        pi: { getActiveSession: () => assert.fail('搜索不读取或修改当前会话选择') },
        getRuntimeHistory: (value: string) =>
          value === 'runtime:active' ? { messages: [userMessage('运行中的正文')] } : null,
      }),
    },
    registerHandlers: (value: typeof handlers) => {
      handlers = value
    },
  } as unknown as BuiltinModuleContext)
  assert.deepEqual(await handlers['session:search']('正文', [file, file, 'runtime:active']), [
    { path: file, excerpt: '需要找到的正文' },
    { path: 'runtime:active', excerpt: '运行中的正文' },
  ])
  assert.deepEqual(await handlers['session:search']('正文', [path.join(directory, 'deleted.jsonl')]), [])
  for (const target of [outside, path.join(directory, 'escape.jsonl')])
    await assert.rejects(
      Promise.resolve().then(() => handlers['session:search']('正文', [target])),
      /会话目录/,
    )
  for (const args of [
    ['', [file]],
    ['x'.repeat(1025), [file]],
    ['正文', Array.from({ length: 101 }).fill(file)],
    ['正文', [1]],
  ])
    await assert.rejects(Promise.resolve().then(() => handlers['session:search'](...args)))
})
