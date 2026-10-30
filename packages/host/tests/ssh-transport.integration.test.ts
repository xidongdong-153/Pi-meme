import assert from 'node:assert/strict'
import { request } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { test, vi } from 'vitest'
import { WebSocket } from 'ws'
import { startHostServer } from '../src/server'

async function fixture(available = true) {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-ssh-transport-'))
  const server = await startHostServer({
    dataRoot: root,
    testCredentials: true,
    token: 'test-token',
    localAutoLogin: false,
    ssh: {
      available: async () => available,
      prepare: async (_connection, signal, onStep) => {
        onStep('checking')
        signal.throwIfAborted()
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      },
    },
  })
  const login = await fetch(`${server.url}/api/auth`, { method: 'POST', body: '{"token":"test-token"}' })
  const cookie = login.headers.get('set-cookie')!.split(';')[0]
  return {
    server,
    cookie,
    async dispose() {
      await server.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}

test('Windows SSH 能力接口返回平台限制和 HTTPS 连接提示', async () => {
  const f = await fixture(false)
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  try {
    const response = await fetch(`${f.server.url}/api/rpc`, {
      method: 'POST',
      headers: { Cookie: f.cookie },
      body: JSON.stringify({
        requestId: 'windows-ssh',
        clientId: 'windows-ssh',
        method: 'host:ssh:capabilities',
        args: [],
      }),
    })
    assert.equal(response.status, 200)
    const { result } = await response.json()
    assert.equal(result.canManage, true)
    assert.equal(result.available, false)
    assert.match(result.reason, /Windows.*HTTPS/)
    assert.doesNotMatch(result.reason, /未找到|请安装/)
  } finally {
    vi.unstubAllGlobals()
    await f.dispose()
  }
})

test('token-required 实际能力与认证一致，loopback来源也拒绝空令牌', async () => {
  const f = await fixture()
  try {
    const empty = await fetch(`${f.server.url}/api/auth`, {
      method: 'POST',
      headers: { Origin: f.server.url },
      body: '{}',
    })
    assert.equal(empty.status, 401)
    const valid = await fetch(`${f.server.url}/api/auth`, {
      method: 'POST',
      headers: { Origin: f.server.url },
      body: '{"token":"test-token"}',
    })
    const body = await valid.json()
    assert.equal(body.authMode, 'token-required')
    assert.equal(body.capabilities.sshTunnelAuthV1, true)
    const unicode = await fetch(`${f.server.url}/api/auth`, {
      method: 'POST',
      body: JSON.stringify({ token: '测'.repeat(10) }),
    })
    assert.equal(unicode.status, 401)
  } finally {
    await f.dispose()
  }
})

test('SSH管理要求认证与本机来源，通用接口不能绕过，状态变更经入口事件发布', async () => {
  const f = await fixture()
  const rpc = (method: string, args: unknown[] = [], remote = false) =>
    new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
      const req = request(
        `${f.server.url}/api/rpc`,
        {
          method: 'POST',
          headers: { Cookie: f.cookie, ...(remote ? { Host: 'remote.example', Origin: 'http://remote.example' } : {}) },
        },
        (response) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => chunks.push(chunk))
          response.on('end', () =>
            resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }),
          )
        },
      )
      req.on('error', reject)
      req.end(JSON.stringify({ requestId: 'ssh-test', clientId: 'ssh-test', method, args }))
    })
  const socket = new WebSocket(`${f.server.url.replace('http:', 'ws:')}/api/events?clientId=ssh-management`, {
    headers: { Cookie: f.cookie },
  })
  const opened = once(socket, 'open')
  const events: string[] = []
  socket.on('message', (value) => {
    events.push(JSON.parse(value.toString()).type)
  })
  try {
    const unauthorized = await fetch(`${f.server.url}/api/rpc`, {
      method: 'POST',
      body: JSON.stringify({ method: 'host:ssh:list', args: [], clientId: 'test', requestId: 'test' }),
    })
    assert.equal(unauthorized.status, 401)
    const local = await rpc('host:ssh:capabilities')
    assert.deepEqual(local.body.result, { canManage: true, available: true })
    const remote = await rpc('host:ssh:capabilities', [], true)
    assert.equal((remote.body.result as { canManage: boolean }).canManage, false)
    for (const method of ['list', 'discover', 'save', 'enabled', 'retry', 'remove'])
      assert.equal((await rpc(`host:ssh:${method}`, [], true)).status, 403)
    await opened
    const saved = await rpc('host:ssh:save', [{ target: 'fixture' }])
    assert.equal(saved.status, 200)
    const profile = saved.body.result as { id: string; name: string; phase: string; enabled: boolean; step: string }
    assert.equal(profile.phase, 'connecting')
    assert.equal(profile.enabled, true)
    assert.equal(profile.step, 'checking')
    assert.equal(profile.name, 'fixture')
    for (const field of ['hostPort', 'token', 'hasToken']) assert.ok(!(field in profile))
    assert.deepEqual((await rpc('host:services:list', [], true)).body.result, [])
    await vi.waitFor(() => assert.ok(events.includes('services-changed')))
    for (const method of ['host:services:retry', 'host:services:remove']) {
      const result = await rpc(method, [profile.id], true)
      assert.equal(result.status, 400)
      assert.match(String(result.body.error), /SSH 管理/)
    }
    assert.equal((await rpc('host:services:register', [{ url: 'http://127.0.0.1:31415', token: 'token' }])).status, 400)
    assert.equal((await rpc('host:ssh:remove', [profile.id])).status, 200)
    assert.deepEqual((await rpc('host:ssh:list')).body.result, [])
  } finally {
    socket.terminate()
    await f.dispose()
  }
})
