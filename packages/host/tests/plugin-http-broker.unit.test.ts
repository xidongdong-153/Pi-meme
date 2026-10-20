import { test, vi } from 'vitest'
import assert from 'node:assert/strict'
import { Resolver } from 'node:dns/promises'
import https from 'node:https'
import { EventEmitter } from 'node:events'
import { emptyPluginGrant } from '@pi-meme/plugin-sdk/permissions'
import { PluginHttpBroker, publicPluginAddress } from '../src/plugin-http-broker'

function grant() {
  return {
    ...emptyPluginGrant('test'),
    restricted: {
      maxAccess: 'read-only' as const,
      capabilities: ['http.request' as const],
      network: [{ id: 'search', origin: 'https://search.example.com', methods: ['GET' as const, 'POST' as const] }],
    },
  }
}
test('集中地址分类拒绝内网、本机、CGNAT、metadata、IPv6 mapped/过渡地址', () => {
  for (const ip of [
    '0.0.0.0',
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '224.0.0.1',
    '192.0.2.1',
    '::1',
    'fc00::1',
    'fe80::1',
    'fec0::1',
    '64:ff9b:1::7f00:1',
    '64:ff9b::7f00:1',
    '::ffff:8.8.8.8',
    '2002:0808:0808::1',
  ])
    assert.equal(publicPluginAddress(ip), false, ip)
  assert.equal(publicPluginAddress('8.8.8.8'), true)
  assert.equal(publicPluginAddress('2606:4700:4700::1111'), true)
})
test('网络规则、Plan method和身份头在DNS前拒绝，凭据不能跨origin', async () => {
  const broker = new PluginHttpBroker(() => ({
    origin: 'https://other.example.com',
    header: 'Authorization',
    value: 'DO_NOT_LEAK',
  }))
  for (const input of [
    { url: 'https://127.0.0.1/a', method: 'GET' },
    { url: 'http://search.example.com', method: 'GET' },
    { url: 'https://search.example.com', method: 'DELETE' },
  ])
    await assert.rejects(
      broker.request('a', grant(), 'default', input, AbortSignal.timeout(1000)),
      /network-origin-denied/,
    )
  await assert.rejects(
    broker.request(
      'a',
      grant(),
      'plan',
      { url: 'https://search.example.com', method: 'POST' },
      AbortSignal.timeout(1000),
    ),
    /Plan/,
  )
  await assert.rejects(
    broker.request(
      'a',
      grant(),
      'default',
      { url: 'https://search.example.com', method: 'GET', headers: { Cookie: 'secret' } },
      AbortSignal.timeout(1000),
    ),
    /禁止设置/,
  )
  await assert.rejects(
    broker.request(
      'a',
      grant(),
      'default',
      { url: 'https://search.example.com', method: 'GET', credentialRef: 'other' },
      AbortSignal.timeout(1000),
    ),
    /凭据不属于/,
  )
})
test('混合公开/私网DNS全部拒绝，不开始连接', async () => {
  const v4 = vi.spyOn(Resolver.prototype, 'resolve4').mockResolvedValue(['8.8.8.8', '127.0.0.1'] as never)
  const v6 = vi.spyOn(Resolver.prototype, 'resolve6').mockResolvedValue([] as never)
  const connect = vi.spyOn(https, 'request')
  try {
    await assert.rejects(
      new PluginHttpBroker(() => undefined).request(
        'a',
        grant(),
        'default',
        { url: 'https://search.example.com', method: 'GET' },
        AbortSignal.timeout(1000),
      ),
      /network-address-denied/,
    )
    assert.equal(connect.mock.calls.length, 0)
  } finally {
    v4.mockRestore()
    v6.mockRestore()
    connect.mockRestore()
  }
})
test('连接lookup绑定已校验地址，拒绝跨origin重定向且不泄漏认证', async () => {
  const v4 = vi.spyOn(Resolver.prototype, 'resolve4').mockResolvedValue(['8.8.8.8'] as never)
  const v6 = vi.spyOn(Resolver.prototype, 'resolve6').mockResolvedValue([] as never)
  let pinned = ''
  let injected = ''
  const connect = vi.spyOn(https, 'request').mockImplementation(((
    _url: URL,
    options: https.RequestOptions,
    callback: (response: EventEmitter & { headers: Record<string, string>; statusCode: number }) => void,
  ) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void }
    const lookup = options.lookup as (
      _name: string,
      _opts: object,
      cb: (error: unknown, address: string) => void,
    ) => void
    lookup('ignored-attacker-name', {}, (_error, address) => {
      pinned = address
    })
    injected = String((options.headers as Record<string, string>).Authorization)
    req.end = () => {
      const response = Object.assign(new EventEmitter(), {
        headers: { location: 'https://evil.example.com/private' },
        statusCode: 302,
      })
      callback(response)
      queueMicrotask(() => response.emit('end'))
    }
    return req
  }) as never)
  try {
    const broker = new PluginHttpBroker(() => ({
      origin: 'https://search.example.com',
      header: 'Authorization',
      value: 'PRIVATE',
    }))
    await assert.rejects(
      broker.request(
        'a',
        grant(),
        'default',
        { url: 'https://search.example.com/a', method: 'GET', credentialRef: 'search' },
        AbortSignal.timeout(1000),
      ),
      /network-origin-denied|network-redirect-denied/,
    )
    assert.equal(pinned, '8.8.8.8')
    assert.equal(injected, 'Bearer PRIVATE')
    assert.equal(connect.mock.calls.length, 1)
  } finally {
    v4.mockRestore()
    v6.mockRestore()
    connect.mockRestore()
  }
})
