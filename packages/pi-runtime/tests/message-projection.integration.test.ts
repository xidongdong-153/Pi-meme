import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { SessionEntry, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { projectStableMessages } from '../src/sdk/message-projection'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { SdkSession } from '../src/sdk/session'
import { useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'
import type { DesktopEvent } from '@pi-meme/contracts/desktop'

test('实时完成事件确认原生追加后仅发送一次，身份与快照一致', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'plugin-message-commit-'))
  t.onTestFinished(() => rm(root, { recursive: true, force: true }))
  const fake = await useFakeAgent(root, {
    reply: (_body, index) => (index === 1 ? { tool: { name: 'emit_custom', arguments: '{}' } } : '完成'),
  })
  t.onTestFinished(() => fake.dispose())
  const events: DesktopEvent[] = []
  const session = new SdkSession(
    root,
    { connection: () => {}, event: (event) => events.push(event), error: () => {} },
    fake.runtimePaths,
    fake.credentials,
  )
  t.onTestFinished(() => session.stopAndWait())
  session.configureInlineExtensions([
    {
      name: 'commit-fixture',
      factory(pi) {
        pi.registerTool({
          name: 'emit_custom',
          label: '自定义消息',
          description: '验证消息提交身份',
          parameters: { type: 'object', properties: {} } as ToolDefinition['parameters'],
          async execute() {
            pi.sendMessage({ customType: 'notice', content: '相同正文', display: true })
            pi.sendMessage({ customType: 'notice', content: '相同正文', display: true })
            return { content: [{ type: 'text', text: '已发送' }], details: {} }
          },
        })
      },
    },
  ])
  session.start(root)
  await session.snapshot()
  await session.setModel({ provider: 'fake', id: 'first' })
  await session.prompt('检查稳定消息引用')
  const deadline = Date.now() + 5000
  while ((await session.snapshot()).state.isStreaming) {
    if (Date.now() > deadline) throw new Error('等待假模型结束超时')
    await delay(10)
  }
  const snapshot = await session.snapshot()
  const completed = events.flatMap(({ event }) =>
    event.type === 'message_end' && ['user', 'assistant', 'toolResult', 'custom'].includes(event.message.role)
      ? [event.message]
      : [],
  )
  assert.ok(completed.length >= 5)
  assert.equal(completed.filter((message) => message.role === 'custom').length, 2)
  assert.ok(completed.every((message) => message.sourceEntry?.id))
  const ids = completed.map((message) => message.sourceEntry!.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.deepEqual(
    ids,
    snapshot.messages
      .filter((message) => ['user', 'assistant', 'toolResult', 'custom'].includes(message.role))
      .map((message) => message.sourceEntry?.id),
  )
})

const timestamp = '2026-01-01T00:00:00.000Z'
function user(id: string, parentId: string | null, text: string): SessionEntry {
  return { type: 'message', id, parentId, timestamp, message: { role: 'user', timestamp: 1, content: text } }
}

test('同毫秒消息直接继承原生entry身份，context_edit改变revision但不改ref', async () => {
  const entries: SessionEntry[] = [
    user('one', null, '第一条'),
    user('two', 'one', '第二条'),
    { type: 'context_edit', id: 'edit', parentId: 'two', timestamp, targetId: 'one', replacement: { content: '更新' } },
  ]
  const messages = await projectStableMessages(entries)
  assert.deepEqual(
    messages.map((message) => message.sourceEntry?.id),
    ['one', 'two'],
  )
  assert.notEqual(messages[0].sourceEntry?.revision, 'one')
  assert.equal((await projectStableMessages(entries))[0].sourceEntry?.revision, messages[0].sourceEntry?.revision)
  assert.equal('content' in messages[0] && messages[0].content, '更新')
  const branch = await projectStableMessages(entries, 'one')
  assert.equal(branch.length, 1)
  assert.equal(branch[0].sourceEntry?.revision, 'one')
  entries.push({
    type: 'context_edit',
    id: 'restore',
    parentId: 'edit',
    timestamp,
    targetId: 'one',
    replacement: { content: '第一条' },
  })
  const restored = await projectStableMessages(entries)
  assert.equal(restored[0].sourceEntry?.revision, 'one')
})

test('custom_message一对一，compaction多投影仍display-only不伪造消息ref', async () => {
  const entries: SessionEntry[] = [
    user('one', null, '输入'),
    {
      type: 'custom_message',
      id: 'custom',
      parentId: 'one',
      timestamp,
      customType: 'notice',
      content: '通知',
      display: true,
    },
    {
      type: 'compaction',
      id: 'compact',
      parentId: 'custom',
      timestamp,
      summary: '压缩',
      firstKeptEntryId: 'custom',
      tokensBefore: 10,
      systemMessage: { role: 'system', content: '内部指令' } as never,
    },
  ]
  const messages = await projectStableMessages(entries)
  const summaries = messages.filter((message) => message.role === 'system' || message.role === 'compactionSummary')
  assert.equal(summaries.length, 2)
  assert.ok(summaries.every((message) => !message.sourceEntry))
  assert.equal(messages.find((message) => message.role === 'custom')?.sourceEntry?.id, 'custom')
})
