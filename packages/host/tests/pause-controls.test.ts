import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Snapshot } from '@pi-meme/contracts/desktop'
import { PiSessionPool, type ClientView } from '@pi-meme/pi-runtime/session-pool'
import { MemoryCredentialStorage } from '@pi-meme/pi-runtime/secure-store'
import { createHost } from '../src/service'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('暂停和队列控制不被普通发送阻塞，写操作校验稳定会话标识', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'host-pause-controls-'))
  const entered = deferred()
  const release = deferred()
  const original = PiSessionPool.prototype.prompt
  const originalBegin = PiSessionPool.prototype.beginQueueEdit
  PiSessionPool.prototype.beginQueueEdit = async () => ({ id: 'input-id', text: '排队任务', mode: 'default' })
  PiSessionPool.prototype.prompt = async () => {
    entered.resolve()
    await release.promise
  }
  const host = await createHost({ dataRoot: root, credentials: new MemoryCredentialStorage() })
  const rpc = (method: string, args: unknown[] = [], sessionId?: string) =>
    host.rpc({ requestId: crypto.randomUUID(), clientId: 'client', method, args, sessionId })
  let prompting: ReturnType<typeof rpc> | undefined
  try {
    const key = ((await rpc('pi:snapshot')).result as Snapshot).connection.sessionKey!
    prompting = rpc('pi:prompt', [key, '等待中的发送'], key)
    await entered.promise
    for (const method of [
      'pi:pause',
      'pi:resume',
      'pi:steer-queue-input',
      'pi:delete-queue-input',
      'pi:begin-queue-edit',
      'pi:update-queue-input',
      'pi:cancel-queue-edit',
    ]) {
      const missing = await rpc(method, [key, 'input-id'])
      assert.match(missing.error!.message, /匹配的 sessionId/)
      const mismatched = await rpc(method, [key, 'input-id'], 'another-key')
      assert.match(mismatched.error!.message, /匹配的 sessionId/)
    }
    const paused = await Promise.race([
      rpc('pi:pause', [key], key),
      delay(1000).then(() => {
        throw new Error('暂停被发送阻塞')
      }),
    ])
    assert.equal(paused.error, undefined)
    assert.equal((await rpc('pi:resume', [key], key)).error, undefined)
    const absent = await Promise.race([
      rpc('pi:begin-queue-edit', [key, 'input-id'], key),
      delay(1000).then(() => {
        throw new Error('队列控制被发送阻塞')
      }),
    ])
    assert.equal(absent.error, undefined)
    release.resolve()
    assert.equal((await prompting).error, undefined)
  } finally {
    release.resolve()
    await prompting
    PiSessionPool.prototype.prompt = original
    PiSessionPool.prototype.beginQueueEdit = originalBegin
    await host.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('Host 提供可信编辑身份，选择切换和客户端宽限期释放占位', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'host-edit-owner-'))
  const released: string[] = []
  const owners: string[] = []
  const begin = PiSessionPool.prototype.beginQueueEdit
  const release = PiSessionPool.prototype.releaseQueueEdits
  PiSessionPool.prototype.beginQueueEdit = async function () {
    const context = this as unknown as { viewContext: { getStore: () => ClientView | undefined } }
    owners.push(context.viewContext.getStore()!.clientId!)
    return { id: 'input-id', text: '排队任务', mode: 'default' }
  }
  PiSessionPool.prototype.releaseQueueEdits = async (clientId) => {
    released.push(clientId)
  }
  const host = await createHost({ dataRoot: root, credentials: new MemoryCredentialStorage(), clientGraceMs: 40 })
  const rpc = (method: string, args: unknown[] = [], sessionId?: string) =>
    host.rpc({ requestId: crypto.randomUUID(), clientId: 'trusted-client', method, args, sessionId })
  try {
    const unsubscribe = await host.subscribe('trusted-client', () => {})
    const key = ((await rpc('pi:snapshot')).result as Snapshot).connection.sessionKey!
    assert.equal((await rpc('pi:begin-queue-edit', [key, 'input-id', 'forged-owner'], key)).error, undefined)
    assert.deepEqual(owners, ['trusted-client'])
    const changed = await rpc('pi:new-session')
    assert.equal(changed.error, undefined)
    assert.deepEqual(released, ['trusted-client'])
    unsubscribe()
    await delay(100)
    assert.deepEqual(released, ['trusted-client', 'trusted-client'])
  } finally {
    PiSessionPool.prototype.beginQueueEdit = begin
    PiSessionPool.prototype.releaseQueueEdits = release
    await host.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
