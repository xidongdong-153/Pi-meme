import { createHash, createHmac, randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { bodyLimit } from 'hono/body-limit'
import { createRegistry } from '@earendil-works/pi-durable'
import type { BotServices } from './contracts.js'
import { DurableBotStore } from './store.js'
import { authenticate, checkOrigin, registerAuth } from './auth.js'
import { BotError } from './errors.js'
import { createBotModels } from './models.js'
import { BotRuntime } from './runtime.js'
import { createAttachmentServices, registerCoreRoutes } from './routes.js'
import { registerHostRoutes } from './hosts.js'
import { registerQqRoutes } from './qq.js'
import { registerCapabilityRoutes } from './capabilities.js'

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  return JSON.stringify(value)
}

async function inputDigest(request: Request, epoch: string) {
  const url = new URL(request.url)
  url.searchParams.sort()
  const digest = createHmac('sha256', epoch).update(request.method).update(url.pathname).update(url.search)
  if (request.headers.get('Content-Type')?.startsWith('multipart/form-data')) {
    const form = await request.clone().formData()
    const fields: [string, unknown][] = []
    for (const [name, value] of form)
      fields.push([
        name,
        typeof value === 'string'
          ? value
          : {
              name: value.name,
              type: value.type,
              size: value.size,
              sha256: createHash('sha256')
                .update(new Uint8Array(await value.arrayBuffer()))
                .digest('hex'),
            },
      ])
    digest.update(canonical(fields.sort(([a], [b]) => a.localeCompare(b))))
  } else {
    const raw = await request.clone().text()
    if (request.headers.get('Content-Type')?.includes('application/json')) {
      try {
        digest.update(canonical(JSON.parse(raw)))
      } catch {
        digest.update(raw)
      }
    } else digest.update(raw)
  }
  return digest.digest('hex')
}

export async function createBotService(options: { publicOrigin?: string; port?: number } = {}) {
  const models = createBotModels()
  const registry = createRegistry()
  const store = await DurableBotStore.open(models, registry)
  const app = new Hono()
  let ready = false
  let runtime: BotRuntime
  const services: BotServices = {
    store,
    ...createAttachmentServices(store),
    acceptMessage: (input) => runtime.acceptMessage(input),
    stopTask: (id) => runtime.stopTask(id),
  }
  runtime = new BotRuntime(store, models, registry, services)
  const inFlight = new Map<
    string,
    { hash: string; promise: Promise<{ status: number; body: string; contentType: string }> }
  >()
  app.use('*', async (c, next) => {
    const requestId = randomUUID()
    c.header('X-Request-Id', requestId)
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Referrer-Policy', 'same-origin')
    c.header('X-Frame-Options', 'DENY')
    if (c.req.path.startsWith('/api/')) c.header('Cache-Control', 'no-store')
    const host = new URL(c.req.url).host
    const port = options.port ?? 4310
    const ports = process.env.NODE_ENV === 'production' ? [port] : [port, 4311]
    const allowedHosts = ports.flatMap((value) => [`127.0.0.1:${value}`, `localhost:${value}`, `[::1]:${value}`])
    if (options.publicOrigin) allowedHosts.push(new URL(options.publicOrigin).host)
    if (!allowedHosts.includes(host)) throw new BotError(403, 'forbidden', '服务地址不被允许')
    await next()
  })
  app.use(
    '/api/*',
    bodyLimit({
      maxSize: 22 * 1024 * 1024,
      onError: () => {
        throw new BotError(413, 'invalid-input', '请求不能超过22MiB')
      },
    }),
  )
  app.onError((cause, c) => {
    const error =
      cause instanceof BotError
        ? cause
        : cause instanceof HTTPException
          ? new BotError(cause.status, 'request-failed', cause.message)
          : cause instanceof SyntaxError
            ? new BotError(400, 'invalid-input', '请求内容无效')
            : new BotError(500, 'internal-error', '请求未完成，请保留请求ID并检查配置')
    return c.json(
      {
        error: {
          code: error.code,
          message: error.message,
          retryable: error.status === 429 || error.status === 503,
          requestId: c.res.headers.get('X-Request-Id') ?? randomUUID(),
          details: error.details,
        },
      },
      error.status as 400,
    )
  })
  app.get('/api/health', (c) => c.json({ ready, application: 'pi-meme-bot' }, ready ? 200 : 503))
  registerAuth(app, store, options.publicOrigin)
  app.use('/api/v1/*', async (c, next) => {
    const principal = authenticate(c, store)
    if (!principal) throw new BotError(401, 'unauthenticated', '请先登录或提供有效API凭据')
    if (!['GET', 'HEAD'].includes(c.req.method)) {
      if (!principal.write) throw new BotError(403, 'forbidden', 'API凭据没有写入权限')
      checkOrigin(c, options.publicOrigin)
      if (principal.kind === 'cookie' && !c.req.header('Origin'))
        throw new BotError(403, 'forbidden', '网页登录写操作须提供同源Origin')
      const key = c.req.header('Idempotency-Key')
      if (!key || key.length > 200 || !/^[\w:.-]+$/.test(key))
        throw new BotError(400, 'invalid-input', '写入请求须带有效Idempotency-Key')
      const digest = await inputDigest(c.req.raw, store.read().epoch)
      const state = store.read()
      const operationId = `${principal.id}:${c.req.method}:${c.req.path}:${key}`
      const existing = state.operations[operationId]
      if (existing && existing.hash !== digest)
        throw new BotError(409, 'idempotency-conflict', '同一请求键已用于不同参数')
      const pending = inFlight.get(operationId)
      if (pending && pending.hash !== digest)
        throw new BotError(409, 'idempotency-conflict', '同一请求键已用于不同参数')
      if (pending) {
        const result = await pending.promise
        return new Response(result.body, {
          status: result.status,
          headers: { 'Content-Type': result.contentType, 'Cache-Control': 'no-store' },
        })
      }
      if (existing) {
        const result = existing.result as { status?: number; body?: string; contentType?: string }
        if (!result.status || result.body === undefined)
          throw new BotError(409, 'outcome-unknown', '上次请求结果待核对，请查询资源；不会自动重做')
        return new Response(result.body, {
          status: result.status,
          headers: { 'Content-Type': result.contentType ?? 'application/json', 'Cache-Control': 'no-store' },
        })
      }
      let resolve!: (result: { status: number; body: string; contentType: string }) => void
      let reject!: (error: unknown) => void
      const promise = new Promise<{ status: number; body: string; contentType: string }>((yes, no) => {
        resolve = yes
        reject = no
      })
      inFlight.set(operationId, { hash: digest, promise })
      void promise.catch(() => {})
      try {
        await store.update((draft) => {
          if (Object.keys(draft.operations).length >= 100000)
            throw new BotError(507, 'storage-limit', '操作回执已达容量上限，请备份后维护')
          draft.operations[operationId] = {
            hash: digest,
            result: { pending: true },
            createdAt: new Date().toISOString(),
          }
        })
        await next()
        const result = {
          status: c.res.status,
          body: await c.res.clone().text(),
          contentType: c.res.headers.get('Content-Type') ?? 'application/json',
        }
        const receipt =
          c.req.path === '/api/v1/tokens' || c.req.path.endsWith('/binding')
            ? {
                status: 409,
                body: JSON.stringify({
                  error: {
                    code: 'one-time-result',
                    message: '凭据只显示一次，请重新创建或重新生成绑定码',
                    retryable: false,
                    requestId: randomUUID(),
                  },
                }),
                contentType: 'application/json',
              }
            : result
        await store.update((draft) => {
          draft.operations[operationId].result = receipt
        })
        resolve(result)
      } catch (cause) {
        reject(cause)
        throw cause
      } finally {
        inFlight.delete(operationId)
      }
    } else await next()
  })
  registerCoreRoutes(app, services, runtime)
  const hosts = registerHostRoutes(app, services)
  const qq = registerQqRoutes(app, services)
  const capabilities = registerCapabilityRoutes(app, services)
  runtime.hosts = hosts
  runtime.capabilities = capabilities
  app.notFound((c) =>
    c.json({ error: { code: 'not-found', message: '接口不存在', retryable: false, requestId: randomUUID() } }, 404),
  )
  try {
    await capabilities.start()
    await runtime.start()
    await qq.start()
    ready = true
  } catch (cause) {
    await runtime.close()
    await qq.close()
    await capabilities.close()
    await hosts.close()
    await store.close()
    throw cause
  }
  return {
    app,
    store,
    async close() {
      ready = false
      await runtime.close()
      await qq.close()
      await capabilities.close()
      await hosts.close()
      await store.close()
    },
  }
}
