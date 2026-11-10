import { createHash, createHmac } from 'node:crypto'
import type { AppState, ApiError } from '../shared/types.js'
import type { BotApp, BotServices } from './contracts.js'
import type { DurableBotStore } from './store.js'
import { BotError, canonicalJson, requireItem } from './errors.js'
import { assertTaskAuthorized } from './task-interactions.js'

function configurationRevision(state: AppState, path: string): number | undefined {
  const segments = path.split('/')
  if (path.startsWith('/settings/models')) return state.modelSettings.revision
  if (path.startsWith('/channels/qq')) return state.qq.revision
  const collection = segments[1]
  const id = segments[2]
  if (!id) return undefined
  switch (collection) {
    case 'bots':
    case 'conversations':
    case 'models':
    case 'hosts':
    case 'schedules':
    case 'memories':
      return requireItem(state[collection][id], '配置').revision
    default:
      return undefined
  }
}

/** In-process requests reuse the same validation, persistence and receipts as the owner-facing API. */
export function createConfigurationAccess(app: BotApp, store: DurableBotStore, origin: string) {
  const requests = new WeakMap<Request, string>()
  const configure: BotServices['configure'] = async (input) => {
    const { taskId, callId, step, method, path, signal } = input
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('#'))
      throw new BotError(400, 'invalid-input', '配置路径无效')
    signal.throwIfAborted()
    assertTaskAuthorized(store.read(), requireItem(store.read().tasks[taskId], '任务'))
    return store.withTask(taskId, signal, async () => {
      const key = createHash('sha256').update(`${taskId}:${callId}:${step}`).digest('hex')
      let body = input.body
      if (method !== 'GET') {
        const hash = createHmac('sha256', store.read().epoch)
          .update(canonicalJson({ method, path, body }))
          .digest('hex')
        // Persist only revision metadata. Tool arguments supply secrets again if a Durable call resumes.
        const prepared = await store.update((state) => {
          const operationId = `configuration:${key}`
          const existing = state.operations[operationId]
          if (existing) {
            if (existing.hash !== hash) throw new BotError(409, 'idempotency-conflict', '配置调用的内容已经变化')
            return existing.result as { revision?: number }
          }
          const result = { revision: configurationRevision(state, path) }
          state.operations[operationId] = { hash, result, createdAt: new Date().toISOString() }
          return result
        })
        body = { ...prepared, ...body }
      }
      const request = new Request(new URL(`/api/v1${path}`, origin), {
        method,
        signal,
        headers: {
          'Content-Type': 'application/json',
          Origin: origin,
          'Idempotency-Key': `configuration-${key}`,
        },
        ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
      })
      requests.set(request, taskId)
      try {
        const response = await app.fetch(request)
        const result: unknown = await response.json()
        if (!response.ok) {
          const error = (result as ApiError).error
          throw new BotError(response.status, error.code, error.message, error.details)
        }
        return result
      } finally {
        requests.delete(request)
      }
    })
  }
  return { configure, taskForRequest: (request: Request) => requests.get(request) }
}
