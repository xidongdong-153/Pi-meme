import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import { projectBranchEntries } from '../src/session-tree-entries'
import { assistantMessage, toolResult, userMessage } from '../../../tests/fixtures/messages.mjs'

function assistant(id: string, parentId: string | null, message: unknown) {
  return { type: 'message' as const, id, parentId, timestamp: id, message }
}

test('工具结果按 toolCallId 还原成 [read: path:行号] 摘要', () => {
  const entries = [
    {
      type: 'message',
      id: 'a1',
      parentId: null,
      timestamp: 'a1',
      message: assistantMessage(
        [
          {
            type: 'toolCall',
            id: 'c1',
            name: 'read',
            arguments: { path: '/tmp/project/src/main.ts', offset: 50, limit: 100 },
          },
        ],
        1,
      ),
    },
    {
      type: 'message',
      id: 'r1',
      parentId: 'a1',
      timestamp: 'r1',
      message: { ...toolResult('c1', '文件内容', 2), toolName: 'read' },
    },
  ] as unknown as SessionEntry[]

  const [caller, result] = projectBranchEntries(entries)
  // 只有工具调用、没有正文的助手条目没有摘要，渲染层据此隐藏整行
  assert.equal(caller.preview, undefined)
  assert.equal(result.preview, '[read: /tmp/project/src/main.ts:50-149]')
  assert.equal(result.toolName, 'read')
})

test('bash 工具调用压成一行命令摘要', () => {
  const entries = [
    {
      type: 'message',
      id: 'a1',
      parentId: null,
      timestamp: 'a1',
      message: assistantMessage(
        [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'pnpm lint\n&& pnpm format' } }],
        1,
      ),
    },
    {
      type: 'message',
      id: 'r1',
      parentId: 'a1',
      timestamp: 'r1',
      message: { ...toolResult('c1', '', 2), toolName: 'bash' },
    },
  ] as unknown as SessionEntry[]

  const result = projectBranchEntries(entries)[1]
  assert.equal(result.preview, '[bash: pnpm lint && pnpm format]')
})

test('消息正文摘要保留换行，用户条目的结构字段不丢', () => {
  const entries = [
    assistant('u1', null, userMessage('第一行\n第二行', 42)),
    assistant('a1', 'u1', assistantMessage('已完成的回复', 43)),
  ] as unknown as SessionEntry[]

  const [user, reply] = projectBranchEntries(entries)
  assert.equal(user.preview, '第一行\n第二行')
  assert.equal(user.role, 'user')
  assert.equal(user.messageTimestamp, 42)
  assert.equal(reply.preview, '已完成的回复')
})

test('恢复后隐藏被当前分支省略的错误，保留树结构与成功消息', () => {
  const entries = [
    assistant('u1', null, userMessage('继续任务', 1)),
    assistant('a1', 'u1', assistantMessage('已完成的工作', 2)),
    assistant('e1', 'a1', assistantMessage('', 3, { stopReason: 'error', errorMessage: 'Connection error.' })),
    { type: 'context_edit', id: 'omit', parentId: 'e1', timestamp: '4', targetId: 'e1', replacement: null },
    { type: 'context_edit', id: 'other', parentId: 'e1', timestamp: '5', targetId: 'a1', replacement: null },
  ] as unknown as SessionEntry[]

  const recovered = projectBranchEntries(entries, 'omit')
  assert.equal(recovered.find((entry) => entry.id === 'e1')?.display, false)
  assert.equal(recovered.find((entry) => entry.id === 'a1')?.display, undefined)
  assert.equal(recovered.find((entry) => entry.id === 'omit')?.parentId, 'e1')
  assert.equal(projectBranchEntries(entries, 'other').find((entry) => entry.id === 'e1')?.display, undefined)
  assert.equal(projectBranchEntries(entries, 'e1').find((entry) => entry.id === 'e1')?.display, undefined)
})

test('中止的助手消息给出可读占位摘要', () => {
  const entries = [
    assistant('a1', null, assistantMessage('', 1, { stopReason: 'aborted' })),
  ] as unknown as SessionEntry[]

  assert.equal(projectBranchEntries(entries)[0].preview, '(已中止)')
})
