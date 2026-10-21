import assert from 'node:assert/strict'
import { test } from 'vitest'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { importLegacyRequests, RequestRegistry } from '../src/request-registry'

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

test('请求去重标记不保存 API key 或提示词正文，单文件记录哈希', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-meme-request-test-'))
  try {
    const journalFile = path.join(directory, 'requests.jsonl')
    const registry = new RequestRegistry('host', journalFile, 1)
    await registry.run(
      {
        requestId: 'secret',
        clientId: 'a',
        method: 'models:save',
        args: [{ apiKey: 'simulated-secret' }, 'private-prompt'],
      },
      async () => undefined,
    )
    const content = await readFile(journalFile, 'utf8')
    assert.equal(content.includes('simulated-secret') || content.includes('private-prompt'), false)
    const entry = JSON.parse(content.trim())
    assert.match(entry.k, /^[a-f0-9]{64}$/)
    assert.match(entry.i, /^[a-f0-9]{64}$/)

    // 重启后同 key 请求直接被识别为已接纳过期，不重跑
    const restarted = new RequestRegistry('host', journalFile, 1)
    let rerun = false
    const response = await restarted.run(
      {
        requestId: 'secret',
        clientId: 'a',
        method: 'models:save',
        args: [{ apiKey: 'simulated-secret' }, 'private-prompt'],
      },
      async () => {
        rerun = true
      },
    )
    assert.equal(rerun, false)
    assert.equal(response.error?.code, 'request-expired')
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

test('尾部未完成行崩溃容错截断恢复，中段损坏严格拒绝写请求', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-meme-request-corrupt-'))
  try {
    const journalFile = path.join(directory, 'requests.jsonl')
    const validK1 = '1'.repeat(64)
    const validI1 = 'a'.repeat(64)
    // 写入一条完整行，加上一条尾部未完成截断行
    await writeFile(journalFile, `${JSON.stringify({ k: validK1, i: validI1 })}\n{"k":"2222222222`, 'utf8')
    const registry = new RequestRegistry('host', journalFile)
    let executed = false
    const res = await registry.run({ requestId: 'new-req', clientId: 'a', method: 'test', args: [] }, async () => {
      executed = true
    })
    assert.equal(executed, true)
    assert.equal(res.error, undefined)

    // 重启后追加的新请求正常存在，未完成尾行已被截断
    const restarted = new RequestRegistry('host', journalFile)
    let secondExecuted = false
    const res2 = await restarted.run({ requestId: 'new-req-2', clientId: 'a', method: 'test', args: [] }, async () => {
      secondExecuted = true
    })
    assert.equal(secondExecuted, true)
    assert.equal(res2.error, undefined)

    // 现在测试中段损坏：在中间插入破坏数据
    const corruptedFile = path.join(directory, 'corrupted.jsonl')
    await writeFile(
      corruptedFile,
      `{"k":"${validK1}", "i": "${validI1}"}\n{invalid_json_corrupted}\n{"k":"${'3'.repeat(64)}", "i": "${'c'.repeat(64)}"}\n`,
      'utf8',
    )
    const corruptedRegistry = new RequestRegistry('host', corruptedFile)
    let badExecuted = false
    const badRes = await corruptedRegistry.run(
      { requestId: 'any', clientId: 'a', method: 'test', args: [] },
      async () => {
        badExecuted = true
      },
    )
    assert.equal(badExecuted, false)
    assert.equal(badRes.error?.code, 'journal-corrupted')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('importLegacyRequests 一次性导入旧版 requests 目录至新文件', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-legacy-req-'))
  try {
    const legacyDir = path.join(directory, 'legacy-requests')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(legacyDir)
    const hash1 = 'a'.repeat(64)
    const hash2 = 'b'.repeat(64)
    const inputHash1 = '1'.repeat(64)
    const inputHash2 = '2'.repeat(64)
    await writeFile(path.join(legacyDir, hash1), `${inputHash1}\n`, 'utf8')
    await writeFile(path.join(legacyDir, hash2), `${inputHash2}\n`, 'utf8')

    const newJournal = path.join(directory, 'requests.jsonl')
    const count = await importLegacyRequests(legacyDir, newJournal)
    assert.equal(count, 2)

    // 重复导入幂等，不重复追加
    const count2 = await importLegacyRequests(legacyDir, newJournal)
    assert.equal(count2, 0)

    // 模拟重放已导入的请求
    const rawKey = `${'client'}:${'one'}`
    const { createHash } = await import('node:crypto')
    const mockLegacyKeyHash = createHash('sha256').update(rawKey).digest('hex')
    await appendFile(newJournal, `${JSON.stringify({ k: mockLegacyKeyHash, i: '3'.repeat(64) })}\n`)

    const checkRegistry = new RequestRegistry('host', newJournal)
    let rerun = false
    const res = await checkRegistry.run({ requestId: 'one', clientId: 'client', method: 'm', args: [] }, async () => {
      rerun = true
    })
    assert.equal(rerun, false)
    assert.equal(res.error?.code, 'request-expired')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
