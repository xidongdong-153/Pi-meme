import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import type { Context } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { BotApp, BotStore } from './contracts.js'
import { BotError, text } from './errors.js'

const scrypt = promisify(scryptCallback)
const cookieName = 'pi_bot_session'
export const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export interface Principal {
  id: string
  write: boolean
  kind: 'cookie' | 'token'
}

export function authenticate(c: Context, store: BotStore): Principal | undefined {
  const state = store.read()
  const authorization = c.req.header('Authorization')
  if (authorization) {
    if (!authorization.startsWith('Bearer ')) return undefined
    const digest = hash(authorization.slice(7))
    const token = Object.values(state.tokens).find((item) => !item.revokedAt && item.hash === digest)
    return token?.scopes.includes('read')
      ? { id: token.id, write: token.scopes.includes('write'), kind: 'token' }
      : undefined
  }
  const session = state.sessions[hash(getCookie(c, cookieName) ?? '')]
  if (
    session &&
    session.credentialGeneration === state.credentialGeneration &&
    Date.parse(session.expiresAt) > Date.now()
  ) {
    return { id: 'owner', write: true, kind: 'cookie' }
  }
  return undefined
}

export function checkOrigin(c: Context, publicOrigin?: string) {
  const origin = c.req.header('Origin')
  const expected = publicOrigin ?? new URL(c.req.url).origin
  if (origin && origin !== expected) throw new BotError(403, 'forbidden', '请求来源不被允许')
  if (c.req.header('Sec-Fetch-Site') === 'cross-site') throw new BotError(403, 'forbidden', '不接受跨站请求')
}

async function passwordHash(password: string) {
  const salt = randomBytes(24).toString('hex')
  const derived = (await scrypt(password, salt, 64)) as Buffer
  return `${salt}:${derived.toString('hex')}`
}
async function verify(password: string, stored: string) {
  const [salt, value] = stored.split(':')
  if (!salt || !value) return false
  const derived = (await scrypt(password, salt, 64)) as Buffer
  const expected = Buffer.from(value, 'hex')
  return expected.length === derived.length && timingSafeEqual(expected, derived)
}

export async function changeOwnerPassword(store: BotStore, input: Record<string, unknown>) {
  const currentPassword = text(input.currentPassword, '当前密码', 256)
  const password = text(input.password, '新密码', 256)
  const verifiedState = store.read()
  if (
    password.length < 12 ||
    !verifiedState.ownerPasswordHash ||
    !(await verify(currentPassword, verifiedState.ownerPasswordHash))
  )
    throw new BotError(400, 'invalid-input', '当前密码不正确，或新密码不足12个字符')
  const digest = await passwordHash(password)
  await store.update((state) => {
    if (
      state.ownerPasswordHash !== verifiedState.ownerPasswordHash ||
      state.credentialGeneration !== verifiedState.credentialGeneration
    )
      throw new BotError(409, 'revision-conflict', '访问凭据已改变，请重新登录')
    state.ownerPasswordHash = digest
    state.credentialGeneration++
    state.sessions = {}
  })
  return { digest, generation: verifiedState.credentialGeneration + 1 }
}

export function registerAuth(app: BotApp, store: BotStore, publicOrigin?: string) {
  const failures = new Map<string, { count: number; until: number }>()
  const session = async (c: Context, expectedHash: string, expectedGeneration: number) => {
    const raw = randomBytes(32).toString('base64url')
    const digest = hash(raw)
    await store.update((state) => {
      if (state.ownerPasswordHash !== expectedHash || state.credentialGeneration !== expectedGeneration)
        throw new BotError(409, 'revision-conflict', '访问凭据已改变，请重新登录')
      for (const [key, value] of Object.entries(state.sessions))
        if (Date.parse(value.expiresAt) <= Date.now()) delete state.sessions[key]
      state.sessions[digest] = {
        hash: digest,
        expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
        credentialGeneration: state.credentialGeneration,
      }
    })
    setCookie(c, cookieName, raw, {
      httpOnly: true,
      sameSite: 'Strict',
      secure: (publicOrigin ?? c.req.url).startsWith('https:'),
      path: '/',
      maxAge: 7 * 86400,
    })
    return c.json({ authenticated: true })
  }
  app.get('/api/auth/status', (c) =>
    c.json({ initialized: !!store.read().ownerPasswordHash, authenticated: !!authenticate(c, store) }),
  )
  app.post('/api/auth/setup', async (c) => {
    checkOrigin(c, publicOrigin)
    if (store.read().ownerPasswordHash) throw new BotError(409, 'already-initialized', '已设置访问密码，请登录')
    const input = await c.req.json<Record<string, unknown>>()
    const password = text(input.password, '密码', 256)
    if (password.length < 12) throw new BotError(400, 'invalid-input', '密码至少12个字符')
    const digest = await passwordHash(password)
    await store.update((state) => {
      if (state.ownerPasswordHash) throw new BotError(409, 'already-initialized', '已设置访问密码，请登录')
      state.ownerPasswordHash = digest
    })
    return session(c, digest, 1)
  })
  app.post('/api/auth/login', async (c) => {
    checkOrigin(c, publicOrigin)
    const current = failures.get('owner')
    if (current && current.until > Date.now() && current.count >= 8)
      throw new BotError(429, 'rate-limited', '尝试次数过多，请稍后登录')
    const input = await c.req.json<Record<string, unknown>>()
    const password = text(input.password, '密码', 256)
    const verifiedState = store.read()
    const stored = verifiedState.ownerPasswordHash
    if (!stored || !(await verify(password, stored))) {
      const latest = failures.get('owner')
      failures.set('owner', {
        count: (latest && latest.until > Date.now() ? latest.count : 0) + 1,
        until: Date.now() + 60_000,
      })
      throw new BotError(401, 'unauthenticated', '密码不正确')
    }
    failures.delete('owner')
    return session(c, stored, verifiedState.credentialGeneration)
  })
  app.post('/api/auth/logout', async (c) => {
    checkOrigin(c, publicOrigin)
    const digest = hash(getCookie(c, cookieName) ?? '')
    await store.update((state) => {
      delete state.sessions[digest]
    })
    deleteCookie(c, cookieName, { path: '/' })
    return c.json({ authenticated: false })
  })
  app.post('/api/auth/password', async (c) => {
    checkOrigin(c, publicOrigin)
    if (authenticate(c, store)?.kind !== 'cookie') throw new BotError(403, 'forbidden', '请使用网页登录修改密码')
    const input = await c.req.json<Record<string, unknown>>()
    const changed = await changeOwnerPassword(store, input)
    return session(c, changed.digest, changed.generation)
  })
}
