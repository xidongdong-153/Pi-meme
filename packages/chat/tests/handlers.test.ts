import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createChatHandlers } from '../src/server/handlers'
import type { PiRuntime } from '@pi-meme/pi-runtime/runtime'

test('发送与编辑操作传递末尾mode，HTTP消息模式无效时拒绝', async () => {
  const calls: unknown[][] = []
  const send = async (...args: unknown[]) => {
    calls.push(args)
  }
  const pi = {
    prompt: send,
    steer: send,
    followUp: send,
    editAndPrompt: send,
    setSessionMode: send,
  } as unknown as PiRuntime
  const handlers = createChatHandlers({ pi, getCwd: () => '/workspace' })
  await handlers['pi:prompt']('session', '任务', undefined, undefined, { mode: 'plan' })
  assert.deepEqual(calls[0]?.at(-1), { mode: 'plan' })
  await handlers['pi:edit-and-prompt']('session', 123, '新任务', undefined, undefined, { mode: 'default' })
  assert.deepEqual(calls[1]?.at(-1), { mode: 'default' })
  assert.throws(() => handlers['pi:prompt']('session', '任务', undefined, undefined, { mode: 'unknown' }), /消息模式/)
  assert.throws(
    () => handlers['pi:prompt']('session', '任务', undefined, undefined, { mode: 'plan', path: '/tmp' }),
    /消息模式参数/,
  )
  await handlers['pi:session-mode']('session', 'plan')
  assert.deepEqual(calls[2], ['session', 'plan'])
})
