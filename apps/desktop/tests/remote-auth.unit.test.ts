import assert from 'node:assert/strict'
import { test } from 'vitest'
import { authenticateRemoteHost } from '../src/main/remote-auth'

function session(status: number, value: unknown) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  return {
    calls,
    fetch: (async (url: string | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify(value), { status })
    }) as typeof fetch,
  }
}

test('远程登录使用窗口 Session，禁止重定向并确认 Host 身份', async () => {
  const target = session(200, { hostId: 'saved-host' })
  assert.equal(
    await authenticateRemoteHost(target, 'https://host.example/path', 'test-token', 'saved-host'),
    'saved-host',
  )
  assert.equal(target.calls[0].url, 'https://host.example/api/auth')
  assert.equal(target.calls[0].init?.credentials, 'include')
  assert.equal(target.calls[0].init?.redirect, 'error')
  assert.deepEqual(JSON.parse(String(target.calls[0].init?.body)), { token: 'test-token' })
})

test('错误令牌、非法地址、缺失身份和身份变化拒绝登录', async () => {
  const unauthorized = session(401, {})
  await assert.rejects(authenticateRemoteHost(unauthorized, 'https://host.example', 'wrong'), /认证失败/)
  const invalid = session(200, {})
  await assert.rejects(authenticateRemoteHost(invalid, 'https://host.example', 'token'), /有效身份/)
  const changed = session(200, { hostId: 'different' })
  await assert.rejects(authenticateRemoteHost(changed, 'https://host.example', 'token', 'saved'), /身份已变化/)
  await assert.rejects(authenticateRemoteHost(changed, 'http://host.example', 'token'), /HTTPS/)
  await assert.rejects(authenticateRemoteHost(changed, 'https://user:secret@host.example', 'token'), /凭据/)
})
