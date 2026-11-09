import { randomUUID } from 'node:crypto'
import type { ContextWithSystemEvent, InlineExtension } from '@earendil-works/pi-coding-agent'
import type { MemoryRuntimeBridge, MemorySnapshot } from '@pi-meme/contracts/memory'

type Context = { requestMemory: MemoryRuntimeBridge }
type Admission = { epoch: number; scopeRevision: string; hasMemory: boolean }
const customType = 'pi-meme-memory'
const maxAdmissionHistory = 64

function snapshot(value: unknown): value is MemorySnapshot {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<MemorySnapshot>
  return (
    typeof item.enabled === 'boolean' &&
    Number.isSafeInteger(item.epoch) &&
    Number(item.epoch) >= 0 &&
    typeof item.scopeRevision === 'string' &&
    typeof item.content === 'string' &&
    Buffer.byteLength(item.content) <= 8192 &&
    Array.isArray(item.entryIds) &&
    item.entryIds.every((id) => typeof id === 'string')
  )
}

function query(messages: ContextWithSystemEvent['messages']) {
  const message = messages.findLast((item) => item.role === 'user')
  if (!message || message.role !== 'user') return ''
  const text =
    typeof message.content === 'string'
      ? message.content
      : message.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('\n')
  return text.slice(0, 6000)
}

function requestSignal(signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(5000)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

/** Request-only context; neither the transcript nor the SDK session manager is mutated. */
export function create({ requestMemory }: Context): InlineExtension[] {
  return [
    {
      name: 'pi-meme-memory',
      factory: (pi) => {
        const owner = randomUUID()
        const marker = new RegExp(`\\[pi-meme-memory:${owner}:([a-f0-9-]{36})\\]`, 'g')
        // Retain admission metadata, never memory bodies. This also gates retries/cache warming.
        const admissions = new Map<string, Admission>()
        let current: Admission | undefined
        const reset = () => {
          admissions.clear()
          current = undefined
        }
        pi.on('session_start', reset)
        pi.on('context_with_system', async (event, ctx) => {
          const messages = event.messages.filter(
            (message) => message.role !== 'custom' || message.customType !== customType,
          )
          current = undefined
          try {
            const value = await requestMemory({ kind: 'snapshot', query: query(messages) }, requestSignal(ctx.signal))
            if (!snapshot(value)) throw new Error('记忆快照格式无效')
            current = {
              epoch: value.epoch,
              scopeRevision: value.scopeRevision,
              hasMemory: value.enabled && Boolean(value.content.trim()),
            }
            if (!current.hasMemory) {
              admissions.clear()
              return { messages }
            }
            const requestId = randomUUID()
            admissions.set(requestId, current)
            if (admissions.size > maxAdmissionHistory) admissions.delete(admissions.keys().next().value!)
            messages.splice(messages[0]?.role === 'system' ? 1 : 0, 0, {
              role: 'custom',
              customType,
              display: false,
              content: `<app_memory>\n[pi-meme-memory:${owner}:${requestId}]\n${value.content}\n</app_memory>`,
              details: { epoch: value.epoch, scopeRevision: value.scopeRevision, entryIds: value.entryIds },
              timestamp: Date.now(),
            })
          } catch {
            // SDK catches handler failures and continues; returning the clean baseline is essential.
            reset()
          }
          return { messages }
        })
        pi.on('before_provider_request', async (event, ctx) => {
          try {
            const payload = JSON.stringify(event.payload)
            const ids = payload ? [...payload.matchAll(marker)].map((match) => match[1]) : []
            const checks: Admission[] = []
            if (ids.length) {
              for (const id of new Set(ids)) {
                const admission = admissions.get(id)
                if (!admission) throw new Error('记忆请求快照已失效')
                checks.push(admission)
              }
            } else if (current) {
              // This provider payload contains no injected memory, including summary calls.
              checks.push({ ...current, hasMemory: false })
            }
            for (const admission of checks) {
              const result = await requestMemory({ kind: 'admit', ...admission }, requestSignal(ctx.signal))
              if (!('allowed' in result) || result.allowed !== true) throw new Error('记忆已变更，请继续对话')
            }
          } catch (cause) {
            // Throw alone would be swallowed by ExtensionRunner, allowing a stale payload through.
            ctx.abort()
            throw cause
          }
        })
      },
    },
  ]
}
