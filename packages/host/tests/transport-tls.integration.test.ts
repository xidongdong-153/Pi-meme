import assert from 'node:assert/strict'
import { test } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

test('HTTPS 认证、远程 HTTP 代理和两类事件在 Host 重启后恢复 Cookie', { timeout: 20000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-host-transport-tls-'))
  const cert = path.join(root, 'cert.pem')
  const key = path.join(root, 'key.pem')
  try {
    await promisify(execFile)('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
      '-keyout',
      key,
      '-out',
      cert,
    ])
    const script = `
      import assert from 'node:assert/strict'
      import { readFile } from 'node:fs/promises'
      import { once } from 'node:events'
      import path from 'node:path'
      import { WebSocket } from 'ws'
      import { startHostServer } from ${JSON.stringify(new URL('../src/server.ts', import.meta.url).href)}
      const root = process.argv[1]
      const tls = { key: await readFile(path.join(root, 'key.pem')), cert: await readFile(path.join(root, 'cert.pem')) }
      const remoteOptions = { dataRoot: path.join(root, 'remote'), testCredentials: true, tls, token: 'remote-token' }
      let remote = await startHostServer(remoteOptions)
      const local = await startHostServer({ dataRoot: path.join(root, 'local'), testCredentials: true, token: 'local-token' })
      const nativeFetch = globalThis.fetch
      let remoteLogins = 0
      try {
        const auth = await fetch(remote.url + '/api/auth', { method: 'POST', body: '{"token":"remote-token"}' })
        assert.equal(auth.status, 200)
        assert.match(auth.headers.get('set-cookie'), /; Secure/)
        const localAuth = await fetch(local.url + '/api/auth', { method: 'POST', body: '{"token":"local-token"}' })
        const cookie = localAuth.headers.get('set-cookie').split(';')[0]
        globalThis.fetch = (input, init) => {
          if (new URL(String(input)).href === remote.url + '/api/auth') remoteLogins++
          return nativeFetch(input, init)
        }
        const registered = await local.remotes.register(remote.url, 'remote-token')
        assert.equal(remoteLogins, 1)
        const hostId = remote.host.hostId
        const port = Number(new URL(remote.url).port)
        await remote.dispose()
        remote = await startHostServer({ ...remoteOptions, port })
        assert.equal(remote.host.hostId, hostId)
        let released = 0
        remote.host.subscribe = async (_clientId, callback) => {
          callback({ hostId, type: 'test-event', value: 'remote' })
          return () => { released++ }
        }
        remote.host.control.subscribe = (_input, callback) => {
          callback({ hostId, type: 'test-control', value: 'remote' })
          return () => { released++ }
        }
        const base = local.url.replace('http:', 'ws:') + '/api/services/' + registered.id + '/api/'
        for (const control of [false, true]) {
          const socket = new WebSocket(base + (control ? 'control/' : '') + 'events?clientId=test', {
            headers: { Cookie: cookie }, handshakeTimeout: 5000,
          })
          try {
            const [message] = await once(socket, 'message')
            assert.deepEqual(JSON.parse(message.toString()), {
              hostId, type: control ? 'test-control' : 'test-event', value: 'remote',
            })
          } finally {
            const closed = once(socket, 'close')
            socket.close()
            await closed
          }
        }
        assert.equal(remoteLogins, 2)
        const proxy = await fetch(local.url + '/api/services/' + registered.id + '/api/control', {
          method: 'POST', headers: { Cookie: cookie },
          body: JSON.stringify({ apiVersion: 2, hostId, clientId: 'test', method: 'capabilities', args: [] }),
        })
        assert.equal(proxy.status, 200)
        const value = await proxy.json()
        assert.equal(value.hostId, hostId)
        assert.equal(value.result.apiVersion, 2)
        await local.dispose()
        await remote.dispose()
        assert.equal(released, 2)
        console.log('HTTPS 与远程代理验证通过')
      } finally {
        globalThis.fetch = nativeFetch
        await local.dispose()
        await remote.dispose()
      }
    `
    const result = await promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script, root],
      {
        env: { ...process.env, NODE_EXTRA_CA_CERTS: cert },
        timeout: 15000,
      },
    )
    assert.match(result.stdout, /HTTPS 与远程代理验证通过/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
