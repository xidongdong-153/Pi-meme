import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'
import { startHostServer } from '../src/server'
import { MemoryCredentialStorage } from '@pi-meme/pi-runtime/secure-store'
import { lockDataRoot } from '../src/data-root'
import type { HostRpcResponse } from '@pi-meme/contracts/host'
import { setTimeout as delay } from 'node:timers/promises'
import type { Snapshot } from '@pi-meme/contracts/desktop'
import { setup, selectAgentPlugins, installAgentFixture } from './host-server-fixture'

test('HttpOnly 认证、一次性握手、未认证 WebSocket与远程HTTP拒绝', async () => {
  const fixture = await setup()
  try {
    assert.equal((await fetch(`${fixture.server.url}/api/rpc`, { method: 'POST' })).status, 401)
    const ticket = fixture.server.createBootstrapTicket()
    const auth = () =>
      fetch(`${fixture.server.url}/api/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: ticket }),
      })
    const first = await auth()
    assert.equal(first.status, 200)
    assert.match(first.headers.get('set-cookie')!, /HttpOnly/)
    assert.equal((await auth()).status, 401)
    const socket = new WebSocket(`${fixture.server.url.replace('http:', 'ws:')}/api/events?clientId=a`)
    await new Promise<void>((resolve) => socket.once('error', () => resolve()))
    const result = await fixture.rpc('a', 'pi:snapshot')
    assert.equal(result.hostId, fixture.server.host.hostId)
    await assert.rejects(startHostServer({ hostname: '0.0.0.0' }), /HTTPS/)
  } finally {
    await fixture.dispose()
  }
})

test('内置交互不能被停用，弹框仍能回答，基础 UI 始终可用', async () => {
  const fixture = await setup(true)
  let pending: Promise<HostRpcResponse> | undefined
  try {
    const pluginId = 'interaction-fixture'
    await installAgentFixture(
      fixture.server.host,
      path.join(fixture.root, pluginId),
      pluginId,
      `export function activate(context) { context.commands.register({ name: 'lease-question', description: '交互验收', execute: async (_args, execution) => { await context.interaction.request([{ id: 'confirm', question: '请确认', options: [{ label: '确认' }, { label: '取消' }] }], execution.signal) } }); context.commands.register({ name: 'ui-availability', description: '检查交互', execute: async () => { context.interaction.notify('交互可用') } }) }\n`,
    )
    const initial = (await fixture.rpc('a', 'pi:snapshot')).result as Snapshot
    const key = initial.connection.sessionKey!
    await selectAgentPlugins(fixture.server.host, key, [pluginId])
    await fixture.rpc('a', 'pi:access-mode', [key, 'full-access'], key)
    pending = fixture.rpc('a', 'pi:prompt', [key, '/lease-question', [], []], key)
    let id: string | undefined
    for (let count = 0; count < 200 && !id; count++) {
      const snapshot = (await fixture.rpc('b', 'pi:snapshot', [], key)).result as Snapshot
      const request = snapshot.events
        ?.map((value) => value.event)
        .find((event) => event.type === 'extension_ui_request' && event.method === 'questions')
      if (request?.type === 'extension_ui_request') id = request.id
      if (!id) await delay(25)
    }
    assert.ok(id)
    const disabling = await fixture.rpc('b', 'plugins:disable', ['@pi-meme/interaction'], key)
    assert.match(disabling.error?.message ?? '', /内置模块/)
    const oldSnapshot = (await fixture.rpc('a', 'pi:snapshot', [], key)).result as Snapshot
    assert.equal(
      oldSnapshot.uiPlugins?.some((descriptor) => descriptor.id === '@pi-meme/interaction'),
      false,
    )
    const git = await fixture.rpc('b', 'plugins:disable', ['@pi-meme/git'], key)
    assert.match(git.error?.message ?? '', /内置模块/)
    const invalid = await fixture.rpc('b', 'pi:extension-ui-response', [key, id, { value: '无效确认' }], key)
    assert.ok(invalid.error)
    const answers = await Promise.all([
      fixture.rpc('a', 'pi:extension-ui-response', [key, id, { answers: [{ id: 'confirm', value: '确认' }] }], key),
      fixture.rpc('b', 'pi:extension-ui-response', [key, id, { answers: [{ id: 'confirm', value: '取消' }] }], key),
    ])
    assert.equal(answers.filter((answer) => !answer.error).length, 1)
    assert.equal((await pending).error, undefined)
    pending = undefined
    const next = await fixture.rpc('a', 'pi:prompt', [key, '/ui-availability', [], []], key)
    assert.equal(next.error, undefined)
    const snapshot = (await fixture.rpc('a', 'pi:snapshot', [], key)).result as Snapshot
    assert.equal(
      snapshot.events?.some(
        (value) => value.event.type === 'extension_ui_request' && value.event.method === 'questions',
      ),
      false,
    )
  } finally {
    await fixture.server.host.pi.stopAndWait()
    await pending?.catch(() => {})
    await fixture.dispose()
  }
})

test('并发启动只有一个 Host 取得数据目录写锁', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-meme-lock-test-'))
  try {
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => lockDataRoot(root)))
    const acquired = results.filter(
      (result): result is PromiseFulfilledResult<() => Promise<void>> => result.status === 'fulfilled',
    )
    assert.equal(acquired.length, 1)
    await acquired[0].value()
    const unlock = await lockDataRoot(root)
    await unlock()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Host 关闭等待凭据落盘，期间不能释放数据目录写锁', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-meme-close-test-'))
  let closingCredentials = false
  let finish!: () => void
  let flushing!: () => void
  const started = new Promise<void>((resolve) => {
    flushing = resolve
  })
  const pending = new Promise<void>((resolve) => {
    finish = resolve
  })
  const credentials = Object.assign(new MemoryCredentialStorage(), {
    flush: async () => {
      if (!closingCredentials) return
      flushing()
      await pending
    },
  })
  const server = await startHostServer({ dataRoot: root, credentials })
  try {
    closingCredentials = true
    const closing = server.dispose()
    await started
    await assert.rejects(lockDataRoot(root), /已有服务/)
    finish()
    await closing
    const unlock = await lockDataRoot(root)
    await unlock()
  } finally {
    finish()
    await server.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('客户端短暂断开保留选择，超过宽限期回收空白视图', async () => {
  const fixture = await setup(false, 80)
  try {
    const initial = (await fixture.rpc('a', 'pi:snapshot')).result as Snapshot
    const unsubscribe = await fixture.server.host.subscribe('a', () => {})
    unsubscribe()
    const reconnect = await fixture.server.host.subscribe('a', () => {})
    assert.equal(
      ((await fixture.rpc('a', 'pi:snapshot')).result as Snapshot).connection.sessionKey,
      initial.connection.sessionKey,
    )
    reconnect()
    await delay(180)
    const returned = (await fixture.rpc('a', 'pi:snapshot')).result as Snapshot
    assert.notEqual(returned.connection.sessionKey, initial.connection.sessionKey)
    assert.equal(returned.state.isStreaming, false)
  } finally {
    await fixture.dispose()
  }
})
