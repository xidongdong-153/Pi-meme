import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { PiMessage } from '@pi-meme/contracts/pi'
import type { ToolRun } from '../src/ui/model/types'
import { collectTurnChanges } from '../src/ui/model/turn-changes'
import { assistantMessage, toolResult, userMessage } from '../../../tests/fixtures/messages.mjs'

const firstPatch = '@@ -1 +1 @@\n-old\n+new\n'
const secondPatch = '@@ -2 +2 @@\n-left\n+right\n'
const livePatch = '@@ -3 +3 @@\n-live\n+now\n'

function call(id: string, name: string, path: string | undefined, timestamp: number): PiMessage {
  return assistantMessage([{ type: 'toolCall', id, name, arguments: path === undefined ? {} : { path } }], timestamp)
}

function result(
  id: string,
  name: string,
  timestamp: number,
  details?: Extract<PiMessage, { role: 'toolResult' }>['details'],
  isError = false,
): PiMessage {
  return { ...toolResult(id, 'ok', timestamp, isError), toolName: name, details }
}

test('只保留最后一条用户消息之后的成功 edit，并按调用顺序分组', () => {
  const changes = collectTurnChanges(
    [
      userMessage('上一轮', 1),
      call('old', 'edit', 'src/old.ts', 2),
      result('old', 'edit', 3, { patch: firstPatch }),
      userMessage('这一轮', 4),
      call('second', 'edit', 'src/app.ts', 5),
      call('first', 'edit', 'src/app.ts', 6),
      result('first', 'edit', 7, { patch: firstPatch }),
      result('second', 'edit', 8, { patch: secondPatch }),
      call('bash', 'bash', 'src/app.ts', 9),
      result('bash', 'edit', 10, { patch: firstPatch }),
      call('named', 'edit_file', 'src/other.ts', 11),
      result('named', 'edit_file', 12, { patch: firstPatch }),
      call('failed', 'edit', 'src/failed.ts', 13),
      result('failed', 'edit', 14, { patch: firstPatch }, true),
      call('missing', 'edit', undefined, 15),
      result('missing', 'edit', 16, { patch: firstPatch }),
    ],
    {},
  )
  assert.deepEqual(changes, [
    {
      path: 'src/app.ts',
      entries: [
        { toolCallId: 'second', kind: 'edit', patch: secondPatch },
        { toolCallId: 'first', kind: 'edit', patch: firstPatch },
      ],
    },
  ])
})

test('没有用户消息时统计整段记录，write 只留路径，没有 patch 的 edit 不伪造差异', () => {
  const changes = collectTurnChanges(
    [
      call('write', 'write', 'src/new.ts', 1),
      result('write', 'write', 2),
      call('edit', 'edit', 'src/new.ts', 3),
      result('edit', 'edit', 4, { diff: '+ 1 line' }),
    ],
    {},
  )
  assert.deepEqual(changes, [
    {
      path: 'src/new.ts',
      entries: [
        { toolCallId: 'write', kind: 'write' },
        { toolCallId: 'edit', kind: 'edit', patch: undefined },
      ],
    },
  ])
})

test('已落盘的工具结果优先，运行中的调用不计入', () => {
  const running: ToolRun = { id: 'run', name: 'edit', status: 'running', args: { path: 'src/run.ts' } }
  const settled: ToolRun = {
    id: 'done',
    name: 'edit',
    status: 'success',
    args: { path: 'src/done.ts' },
    result: { details: { patch: livePatch } },
  }
  const overwritten: ToolRun = {
    id: 'saved',
    name: 'edit',
    status: 'success',
    result: { content: [{ type: 'text', text: 'ok' }] },
  }
  const changes = collectTurnChanges(
    [
      userMessage('继续', 1),
      call('saved', 'edit', 'src/saved.ts', 2),
      result('saved', 'edit', 3, { patch: firstPatch }),
      call('done', 'edit', 'src/done.ts', 4),
      call('run', 'edit', 'src/run.ts', 5),
    ],
    { saved: overwritten, done: settled, run: running },
  )
  assert.deepEqual(changes, [
    { path: 'src/saved.ts', entries: [{ toolCallId: 'saved', kind: 'edit', patch: firstPatch }] },
    { path: 'src/done.ts', entries: [{ toolCallId: 'done', kind: 'edit', patch: livePatch }] },
  ])
})
