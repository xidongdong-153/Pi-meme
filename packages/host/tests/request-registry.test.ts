import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { RequestRegistry } from '../src/request-registry'

test('连接断开后重复请求返回同一个结果，不重复发送消息', async () => {
  const registry = new RequestRegistry('host')
  let prompts = 0
  const request = {
    requestId: 'one',
    clientId: 'a',
    hostId: 'host',
    sessionId: 'session',
    method: 'pi:prompt',
    args: ['session', 'hello'],
  }
  let finish!: () => void
  const ready = new Promise<void>((resolve) => {
    finish = resolve
  })
  const action = async () => {
    prompts++
    await ready
    return { accepted: true }
  }
  const first = registry.run(request, action)
  const reconnect = registry.run(request, action)
  assert.equal(first, reconnect)
  finish()
  assert.equal((await reconnect).result && prompts, 1)
  assert.equal(
    (await registry.run({ ...request, args: ['session', 'different'] }, action)).error?.code,
    'request-conflict',
  )
})

test('请求去重标记不保存 API key 或提示词正文', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-meme-request-test-'))
  try {
    const registry = new RequestRegistry('host', directory, 1)
    await registry.run(
      {
        requestId: 'secret',
        clientId: 'a',
        method: 'models:save',
        args: [{ apiKey: 'simulated-secret' }, 'private-prompt'],
      },
      async () => undefined,
    )
    const values = await Promise.all(
      (await readdir(directory)).map((file) => readFile(path.join(directory, file), 'utf8')),
    )
    assert.equal(
      values.some((value) => value.includes('simulated-secret') || value.includes('private-prompt')),
      false,
    )
    assert.match(values[0], /^[a-f0-9]{64}$/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('已完成结果淘汰不移除仍执行中的请求，重连仍等待同一次操作', async () => {
  const registry = new RequestRegistry('host', undefined, 1)
  const request = { requestId: 'pending', clientId: 'a', method: 'pi:prompt', args: ['hello'] }
  let finish!: () => void
  const pending = new Promise<void>((resolve) => {
    finish = resolve
  })
  let calls = 0
  const first = registry.run(request, async () => {
    calls++
    await pending
    return 'done'
  })
  await registry.run({ ...request, requestId: 'completed' }, async () => 'other')
  assert.equal(
    registry.run(request, async () => 'duplicate'),
    first,
  )
  finish()
  assert.equal((await first).result, 'done')
  assert.equal(calls, 1)
})
