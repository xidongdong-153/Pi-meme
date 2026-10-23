import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import type { SshTunnel } from '../src/ssh-tunnels'
import { SshError } from '../src/ssh-tunnels'
import { RemoteServices } from '../src/remote-services'
import { SshConnections } from '../src/ssh-connections'
import { ConnectionCredentialStore } from '../src/connection-credentials'
import type { SshHostPreparer } from '../src/ssh-host-bootstrap'

async function fixture(prepare?: SshHostPreparer) {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-ssh-services-'))
  const values = new Map<string, string>()
  let failFlush = false
  const credentials = new ConnectionCredentialStore(
    {
      get: (key) => values.get(key),
      set: (key, value) => {
        values.set(key, value)
      },
      delete: (key) => values.delete(key),
      entries: (prefix = '') => [...values].filter(([key]) => key.startsWith(prefix)),
    },
    async () => {
      if (failFlush) throw new Error('凭据写入失败')
    },
  )
  let starts = 0
  let stops = 0
  let stopGate: Promise<void> | undefined
  let endpoint = 'http://127.0.0.1:45321'
  const remotes = new RemoteServices(credentials, root, {
    available: async () => true,
    prepare:
      prepare ??
      (async (_connection, signal, onStep) => {
        signal.throwIfAborted()
        onStep('checking')
        onStep('installing')
        onStep('starting')
        return { port: 31415, hostId: 'ssh-host', token: 'private-token' }
      }),
    startTunnel: async (_connection, remotePort, signal) => {
      assert.equal(remotePort, 31415)
      starts++
      let finish!: (cause: SshError) => void
      const closed = new Promise<SshError>((resolve) => {
        finish = resolve
      })
      let stopping: Promise<void> | undefined
      const stop = () =>
        (stopping ??= (async () => {
          stops++
          await stopGate
          finish(new SshError('stopped', '已停止'))
        })())
      signal.addEventListener('abort', () => void stop(), { once: true })
      return { endpoint, closed, stop } satisfies SshTunnel
    },
  })
  await remotes.initialize()
  return {
    root,
    values,
    credentials,
    remotes,
    get failCredentialFlush() {
      return failFlush
    },
    set failCredentialFlush(value: boolean) {
      failFlush = value
    },
    get stopGate() {
      return stopGate
    },
    set stopGate(value: Promise<void> | undefined) {
      stopGate = value
    },
    get starts() {
      return starts
    },
    get stops() {
      return stops
    },
    get endpoint() {
      return endpoint
    },
    set endpoint(value: string) {
      endpoint = value
    },
    async dispose() {
      remotes.dispose()
      await remotes.flush()
      await rm(root, { recursive: true, force: true })
    },
  }
}
function auth(hostId = 'ssh-host') {
  return new Response(JSON.stringify({ hostId, authMode: 'token-required', capabilities: { sshTunnelAuthV1: true } }), {
    headers: { 'Set-Cookie': 'pi_meme_session=private-cookie; HttpOnly' },
  })
}

test('SSH 添加后自动准备并隔离凭据，首次认证后才发布服务，暂停与换端口保留稳定身份', async () => {
  const f = await fixture()
  const original = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input))
    requests.push(url.href)
    if (url.pathname === '/api/auth') {
      assert.equal(JSON.parse(String(init?.body)).token, 'private-token')
      return auth()
    }
    assert.equal((init?.headers as Record<string, string>).Origin, url.origin)
    return new Response(JSON.stringify({ hostId: 'ssh-host', result: [] }))
  }) as typeof fetch
  try {
    const connection = await f.remotes.ssh.save({
      name: '工作站',
      target: 'work',
    })
    assert.match(connection.id, /^[a-f0-9]{24}$/)
    assert.equal(connection.enabled, true)
    assert.equal(connection.phase, 'connecting')
    assert.equal(connection.step, 'checking')
    assert.ok(!('hostPort' in connection) && !('token' in connection) && !('hasToken' in connection))
    assert.deepEqual(f.remotes.list(), [])
    const config = await readFile(path.join(f.root, 'config/ssh-connections.json'), 'utf8')
    assert.ok(!config.includes('private-token'))
    await vi.waitFor(() => assert.equal(f.remotes.ssh.list()[0].phase, 'connected'))
    assert.equal(f.values.get(`ssh-host:${connection.id}`), 'private-token')
    const first = f.remotes.list()[0]
    assert.equal(first.hostId, 'ssh-host')
    assert.equal(first.local, false)
    assert.equal(first.transport, 'ssh')
    const body = JSON.stringify({ method: 'workspace:projects', args: [] })
    await f.remotes.request(first.id, '/api/rpc', 'POST', body)
    await f.remotes.ssh.setEnabled(first.id, false)
    await assert.rejects(f.remotes.request(first.id, '/api/rpc', 'POST', body), /暂停/)
    assert.equal(f.starts, 1)
    assert.equal(f.stops, 1)
    f.endpoint = 'http://127.0.0.1:45322'
    await f.remotes.ssh.setEnabled(first.id, true)
    await vi.waitFor(() => assert.equal(f.remotes.ssh.list()[0].phase, 'connected'))
    await f.remotes.request(first.id, '/api/rpc', 'POST', body)
    assert.equal(f.remotes.list()[0].id, first.id)
    assert.equal(f.remotes.list()[0].address, first.address)
    assert.ok(requests.some((url) => url.startsWith('http://127.0.0.1:45322/')))
    await assert.rejects(f.remotes.retry(first.id), /SSH 管理/)
    await assert.rejects(f.remotes.remove(first.id), /SSH 管理/)
    const before = requests.length
    await assert.rejects(
      f.remotes.request(first.id, '/api/rpc', 'POST', JSON.stringify({ method: 'host:ssh:discover' })),
      /不允许转发/,
    )
    assert.equal(requests.length, before)
    await f.remotes.ssh.setEnabled(first.id, false)
    const saved = JSON.parse(await readFile(path.join(f.root, 'config/ssh-connections.json'), 'utf8'))
    assert.equal(saved[0].hostId, 'ssh-host')
    assert.equal(saved[0].enabled, false)
    assert.ok(!JSON.stringify(f.remotes.list()).includes('private-token'))
  } finally {
    globalThis.fetch = original
    await f.dispose()
  }
})

for (const kind of ['old-host', 'auto-login', 'host-identity'] as const) {
  test(`SSH 拒绝 ${kind}，不发布未认证服务或保留隧道`, async () => {
    const f = await fixture()
    const original = globalThis.fetch
    let change = false
    globalThis.fetch = (async () => {
      if (kind === 'old-host')
        return new Response('{"hostId":"old"}', { headers: { 'Set-Cookie': 'pi_meme_session=c' } })
      if (kind === 'auto-login')
        return new Response('{"hostId":"old","authMode":"local-auto-login","capabilities":{"sshTunnelAuthV1":true}}', {
          headers: { 'Set-Cookie': 'pi_meme_session=c' },
        })
      return auth(change ? 'changed-host' : 'ssh-host')
    }) as typeof fetch
    try {
      const profile = await f.remotes.ssh.save({ name: '测试', target: 'work' })
      if (kind === 'host-identity') {
        await vi.waitFor(() => assert.equal(f.remotes.ssh.list()[0].phase, 'connected'))
        await f.remotes.ssh.setEnabled(profile.id, false)
        change = true
        await f.remotes.ssh.setEnabled(profile.id, true)
      }
      await vi.waitFor(() => assert.equal(f.remotes.ssh.list()[0].phase, 'action-required'))
      assert.equal(
        f.remotes.ssh.list()[0].errorCode,
        kind === 'old-host' ? 'host-upgrade' : kind === 'auto-login' ? 'host-auth-mode' : 'host-identity',
      )
      if (kind !== 'host-identity') assert.deepEqual(f.remotes.list(), [])
      else assert.equal(f.remotes.list()[0].hostId, 'ssh-host')
      assert.ok(f.stops >= 1)
    } finally {
      globalThis.fetch = original
      await f.dispose()
    }
  })
}

test('认证期间暂停取消旧代次，不发布过期服务身份', async () => {
  const f = await fixture()
  const original = globalThis.fetch
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  let release!: () => void
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  globalThis.fetch = (async () => {
    entered()
    await waiting
    return auth()
  }) as typeof fetch
  try {
    const profile = await f.remotes.ssh.save({ name: '测试', target: 'work' })
    await started
    const paused = f.remotes.ssh.setEnabled(profile.id, false)
    await vi.waitFor(() => assert.equal(f.remotes.ssh.list()[0].enabled, false))
    release()
    await paused
    assert.equal(f.remotes.ssh.list()[0].phase, 'paused')
    assert.deepEqual(f.remotes.list(), [])
    const saved = JSON.parse(await readFile(path.join(f.root, 'config/ssh-connections.json'), 'utf8'))
    assert.equal(saved[0].hostId, undefined)
  } finally {
    release()
    globalThis.fetch = original
    await f.dispose()
  }
})

test('SSH 事件使用内部 WS endpoint，保留 Host 身份与 Origin 校验', async () => {
  const f = await fixture()
  const original = globalThis.fetch
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  f.endpoint = `http://127.0.0.1:${address.port}`
  globalThis.fetch = (async () => auth()) as typeof fetch
  const messages: string[] = []
  const downstream = Object.assign(new EventEmitter(), {
    readyState: WebSocket.OPEN,
    send: (data: string) => messages.push(data),
    close() {
      downstream.emit('close')
    },
  }) as unknown as WebSocket
  server.on('connection', (socket, request) => {
    assert.equal(request.headers.origin, `http://127.0.0.1:${address.port}`)
    assert.equal(request.headers.cookie, 'pi_meme_session=private-cookie')
    assert.match(request.url!, /^\/api\/events\?clientId=client/)
    socket.send(JSON.stringify({ hostId: 'ssh-host', type: 'sessions-changed' }))
  })
  try {
    const profile = await f.remotes.ssh.save({ name: '测试', target: 'work' })
    await vi.waitFor(() => assert.equal(f.remotes.ssh.list()[0].phase, 'connected'))
    await f.remotes.events(profile.id, 'client', downstream)
    await vi.waitFor(() => assert.equal(messages.length, 1))
    assert.equal(JSON.parse(messages[0]).hostId, 'ssh-host')
    const internal = f.remotes as unknown as { sockets: Map<string, Set<WebSocket>>; cookies: Map<string, string> }
    const old = [...internal.sockets.get(profile.id)!][0]
    await f.remotes.ssh.setEnabled(profile.id, false)
    await f.remotes.ssh.setEnabled(profile.id, true)
    await vi.waitFor(() => assert.equal(f.remotes.ssh.list()[0].phase, 'connected'))
    const nextEvents = new EventEmitter()
    const nextDownstream = Object.assign(nextEvents, {
      readyState: WebSocket.OPEN,
      send: (data: string) => messages.push(data),
      close() {
        nextEvents.emit('close')
      },
    }) as unknown as WebSocket
    await f.remotes.events(profile.id, 'client', nextDownstream)
    await vi.waitFor(() => assert.equal(messages.length, 2))
    const current = [...internal.sockets.get(profile.id)!][0]
    const cookie = internal.cookies.get(profile.id)
    old.emit('unexpected-response', undefined, { resume() {}, statusCode: 401 })
    old.emit('message', Buffer.from(JSON.stringify({ hostId: 'ssh-host', type: 'sessions-changed' })))
    assert.equal(internal.cookies.get(profile.id), cookie)
    assert.equal(current.readyState, WebSocket.OPEN)
  } finally {
    globalThis.fetch = original
    await f.dispose()
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('SSH 删除凭据失败时保留配对资料，可再次删除', async () => {
  const f = await fixture()
  const original = globalThis.fetch
  globalThis.fetch = (async () => auth()) as typeof fetch
  try {
    const profile = await f.remotes.ssh.save({ name: '测试', target: 'work' })
    await vi.waitFor(() => assert.equal(f.remotes.ssh.list()[0].phase, 'connected'))
    f.failCredentialFlush = true
    await assert.rejects(f.remotes.ssh.remove(profile.id), /凭据写入失败/)
    assert.equal(f.remotes.ssh.list()[0].id, profile.id)
    assert.equal(f.credentials.readSsh(profile.id), 'private-token')
    const saved = JSON.parse(await readFile(path.join(f.root, 'config/ssh-connections.json'), 'utf8'))
    assert.equal(saved[0].id, profile.id)
    f.failCredentialFlush = false
    await f.remotes.ssh.remove(profile.id)
    assert.equal(f.credentials.readSsh(profile.id), undefined)
    assert.deepEqual(f.remotes.ssh.list(), [])
  } finally {
    globalThis.fetch = original
    await f.dispose()
  }
})

test('SSH 在线仅改名称不废弃在途业务请求，也不创建新隧道', async () => {
  const f = await fixture()
  const original = globalThis.fetch
  let release!: () => void
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  globalThis.fetch = (async (url) => {
    if (String(url).endsWith('/api/auth')) return auth()
    entered()
    await waiting
    return new Response(JSON.stringify({ hostId: 'ssh-host', result: [] }))
  }) as typeof fetch
  try {
    const profile = await f.remotes.ssh.save({ name: '旧名称', target: 'work' })
    await f.remotes.ssh.setEnabled(profile.id, true)
    await vi.waitFor(() => assert.equal(f.remotes.ssh.list()[0].phase, 'connected'))
    const pending = f.remotes.request(profile.id, '/api/rpc', 'POST', JSON.stringify({ method: 'workspace:projects' }))
    await started
    await f.remotes.ssh.save({ id: profile.id, name: '新名称', target: 'work' })
    release()
    assert.equal((await pending).status, 200)
    assert.equal(f.remotes.list()[0].name, '新名称')
    assert.equal(f.starts, 1)
  } finally {
    release()
    globalThis.fetch = original
    await f.dispose()
  }
})

for (const attachment of [false, true]) {
  test(`SSH ${attachment ? '附件' : 'RPC'}身份错误直接要求处理，不启动重连`, async () => {
    const f = await fixture()
    const original = globalThis.fetch
    globalThis.fetch = (async (url) =>
      String(url).endsWith('/api/auth') ? auth() : new Response('{"hostId":"other-host"}')) as typeof fetch
    try {
      const profile = await f.remotes.ssh.save({ name: '测试', target: 'work' })
      await vi.waitFor(() => assert.equal(f.remotes.ssh.list()[0].phase, 'connected'))
      const operation = attachment
        ? f.remotes.uploadAttachment(profile.id, new URLSearchParams({ hostId: 'ssh-host' }), null)
        : f.remotes.request(profile.id, '/api/rpc', 'POST', JSON.stringify({ method: 'workspace:projects' }))
      await assert.rejects(operation, /身份已变化/)
      assert.equal(f.remotes.ssh.list()[0].phase, 'action-required')
      assert.equal(f.remotes.ssh.list()[0].errorCode, 'host-identity')
      assert.equal(f.starts, 1)
      assert.equal(f.remotes.ssh.list()[0].nextRetryAt, undefined)
    } finally {
      globalThis.fetch = original
      await f.dispose()
    }
  })
}

test('延迟停止旧隧道时，新代次和 flush 都等待进程退出', async () => {
  const f = await fixture()
  const original = globalThis.fetch
  let release!: () => void
  let secondRelease!: () => void
  globalThis.fetch = (async (url) => {
    if (String(url).endsWith('/api/auth')) return auth()
    throw new Error('网络中断')
  }) as typeof fetch
  try {
    const profile = await f.remotes.ssh.save({ name: '测试', target: 'work' })
    await vi.waitFor(() => assert.equal(f.remotes.ssh.list()[0].phase, 'connected'))
    f.stopGate = new Promise<void>((resolve) => {
      release = resolve
    })
    await assert.rejects(f.remotes.request(profile.id, '/api/rpc', 'POST', '{}'), /网络中断/)
    const retrying = f.remotes.ssh.retry(profile.id)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(f.starts, 1)
    release()
    await retrying
    f.stopGate = undefined
    await vi.waitFor(() => assert.equal(f.remotes.ssh.list()[0].phase, 'connected'))
    assert.equal(f.starts, 2)
    f.stopGate = new Promise<void>((resolve) => {
      secondRelease = resolve
    })
    await assert.rejects(f.remotes.request(profile.id, '/api/rpc', 'POST', '{}'), /网络中断/)
    f.remotes.dispose()
    let finished = false
    const flushing = f.remotes.flush().then(() => {
      finished = true
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(finished, false)
    secondRelease()
    await flushing
    assert.equal(finished, true)
  } finally {
    release?.()
    secondRelease?.()
    globalThis.fetch = original
    await f.dispose()
  }
})

for (const operation of ['pause', 'remove', 'dispose'] as const) {
  test(`准备期间${operation}取消旧代次，不创建隧道或发布凭据`, async () => {
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    let signal!: AbortSignal
    const f = await fixture(async (_connection, currentSignal, onStep) => {
      signal = currentSignal
      onStep('installing')
      entered()
      await waiting
      onStep('starting')
      return { port: 31415, hostId: 'ssh-host', token: 'late-token' }
    })
    try {
      const profile = await f.remotes.ssh.save({ target: 'work', name: '' })
      await started
      assert.equal(profile.enabled, true)
      assert.equal(profile.name, 'work')
      assert.equal(f.remotes.ssh.list()[0].step, 'installing')
      const pending =
        operation === 'pause'
          ? f.remotes.ssh.setEnabled(profile.id, false)
          : operation === 'remove'
            ? f.remotes.ssh.remove(profile.id)
            : (f.remotes.dispose(), f.remotes.flush())
      await vi.waitFor(() => assert.ok(signal.aborted))
      release()
      await pending
      assert.equal(f.starts, 0)
      assert.equal(f.credentials.readSsh(profile.id), undefined)
      assert.deepEqual(f.remotes.list(), [])
      if (operation === 'remove') assert.deepEqual(f.remotes.ssh.list(), [])
      else {
        assert.equal(f.remotes.ssh.list()[0].phase, 'paused')
        assert.equal(f.remotes.ssh.list()[0].step, undefined)
      }
    } finally {
      release?.()
      await f.dispose()
    }
  })
}

test('准备失败保留可重试连接，阶段变化通过服务事件发布', async () => {
  let attempts = 0
  const f = await fixture(async (_connection, signal, onStep) => {
    signal.throwIfAborted()
    onStep('installing')
    if (++attempts === 1) throw new SshError('package-download', 'Host 安装包下载失败')
    onStep('starting')
    return { port: 31415, hostId: 'ssh-host', token: 'private-token' }
  })
  const original = globalThis.fetch
  globalThis.fetch = (async () => auth()) as typeof fetch
  const steps: (string | undefined)[] = []
  const unsubscribe = f.remotes.onChanged(() => {
    steps.push(f.remotes.ssh.list()[0]?.step)
  })
  try {
    const profile = await f.remotes.ssh.save({ target: 'work' })
    await vi.waitFor(() => assert.equal(f.remotes.ssh.list()[0].phase, 'action-required'))
    assert.equal(f.remotes.ssh.list()[0].errorCode, 'package-download')
    assert.equal(f.remotes.ssh.list()[0].enabled, true)
    assert.equal(f.starts, 0)
    assert.equal(f.credentials.readSsh(profile.id), undefined)
    await f.remotes.ssh.retry(profile.id)
    await vi.waitFor(() => assert.equal(f.remotes.ssh.list()[0].phase, 'connected'))
    assert.equal(attempts, 2)
    assert.equal(f.starts, 1)
    for (const step of ['checking', 'installing', 'starting', 'authenticating']) assert.ok(steps.includes(step))
  } finally {
    unsubscribe()
    globalThis.fetch = original
    await f.dispose()
  }
})

test('重启入口后启用记录即使没有旧凭据也重新准备，连接身份保持稳定', async () => {
  const f = await fixture(async () => {
    throw new SshError('package-download', 'Host 安装包下载失败')
  })
  let restarted: SshConnections | undefined
  try {
    const profile = await f.remotes.ssh.save({ target: 'work' })
    await vi.waitFor(() => assert.equal(f.remotes.ssh.list()[0].phase, 'action-required'))
    assert.equal(f.credentials.readSsh(profile.id), undefined)
    f.remotes.dispose()
    await f.remotes.flush()
    let preparations = 0
    restarted = new SshConnections(
      f.root,
      f.credentials,
      {
        login: async (connection) => {
          assert.equal(connection.hostId, 'ssh-host')
          assert.equal(f.credentials.readSsh(profile.id), 'private-token')
          return { hostId: 'ssh-host', cookie: 'private-cookie' }
        },
        changed: () => {},
        removed: () => {},
      },
      {
        prepare: async () => {
          preparations++
          return { port: 31415, hostId: 'ssh-host', token: 'private-token' }
        },
        startTunnel: async (_connection, remotePort) => {
          assert.equal(remotePort, 31415)
          let end!: (cause: SshError) => void
          const closed = new Promise<SshError>((resolve) => {
            end = resolve
          })
          return {
            endpoint: 'http://127.0.0.1:45321',
            closed,
            stop: async () => {
              end(new SshError('stopped', '已停止'))
            },
          }
        },
      },
    )
    await restarted.initialize()
    await vi.waitFor(() => assert.equal(restarted!.list()[0].phase, 'connected'))
    assert.equal(preparations, 1)
    assert.equal(restarted.list()[0].id, profile.id)
    assert.equal(restarted.list()[0].enabled, true)
    assert.equal(restarted.list()[0].hostId, 'ssh-host')
  } finally {
    restarted?.dispose()
    await restarted?.flush()
    await f.dispose()
  }
})

test('准备结果身份变化时不覆盖已有凭据，也不建立新隧道', async () => {
  let preparations = 0
  const f = await fixture(async () =>
    ++preparations === 1
      ? { port: 31415, hostId: 'ssh-host', token: 'private-token' }
      : { port: 31415, hostId: 'other-host', token: 'other-token' },
  )
  const original = globalThis.fetch
  globalThis.fetch = (async () => auth()) as typeof fetch
  try {
    const profile = await f.remotes.ssh.save({ target: 'work' })
    await vi.waitFor(() => assert.equal(f.remotes.ssh.list()[0].phase, 'connected'))
    await f.remotes.ssh.setEnabled(profile.id, false)
    await f.remotes.ssh.setEnabled(profile.id, true)
    await vi.waitFor(() => assert.equal(f.remotes.ssh.list()[0].phase, 'action-required'))
    assert.equal(f.remotes.ssh.list()[0].hostId, 'ssh-host')
    assert.equal(f.remotes.ssh.list()[0].errorCode, 'host-identity')
    assert.equal(f.credentials.readSsh(profile.id), 'private-token')
    assert.equal(f.starts, 1)
  } finally {
    globalThis.fetch = original
    await f.dispose()
  }
})

test('自动准备的凭据写入失败时不创建隧道，不泄漏令牌', async () => {
  const f = await fixture()
  f.failCredentialFlush = true
  try {
    const profile = await f.remotes.ssh.save({ target: 'work' })
    await vi.waitFor(() => assert.equal(f.remotes.ssh.list()[0].phase, 'action-required'))
    assert.equal(f.remotes.ssh.list()[0].errorCode, 'storage')
    assert.equal(f.credentials.readSsh(profile.id), undefined)
    assert.equal(f.starts, 0)
    assert.ok(!JSON.stringify(f.remotes.ssh.list()).includes('private-token'))
  } finally {
    f.failCredentialFlush = false
    await f.dispose()
  }
})

test('启用时只允许改名，暂停编辑保留启用状态与已认证身份', async () => {
  const f = await fixture()
  const original = globalThis.fetch
  globalThis.fetch = (async () => auth()) as typeof fetch
  try {
    const profile = await f.remotes.ssh.save({ target: 'work' })
    await vi.waitFor(() => assert.equal(f.remotes.ssh.list()[0].phase, 'connected'))
    for (const change of [{ target: 'other' }, { port: 2222 }, { identityFile: '~/.ssh/other' }])
      await assert.rejects(f.remotes.ssh.save({ id: profile.id, target: 'work', ...change }), /请先暂停/)
    await assert.rejects(f.remotes.ssh.save({ target: 'work' }), /已经添加/)
    assert.equal(f.starts, 1)
    await f.remotes.ssh.setEnabled(profile.id, false)
    const edited = await f.remotes.ssh.save({ id: profile.id, target: 'other' })
    assert.equal(edited.enabled, false)
    assert.equal(edited.phase, 'paused')
    assert.equal(edited.hostId, 'ssh-host')
    assert.equal(f.starts, 1)
  } finally {
    globalThis.fetch = original
    await f.dispose()
  }
})
