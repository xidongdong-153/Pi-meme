import { createHash } from 'node:crypto'
import type { AppSession, SessionRef } from '@pi-meme/contracts/app-host'
import type {
  MemoryLearningSource,
  MemoryServiceOptions,
  MemorySource,
  MemoryTurnTicket,
} from '@pi-meme/contracts/memory'
import type { TaskMode } from '@pi-meme/contracts/plan'
import type { PiMessage } from '@pi-meme/contracts/pi'
import type { PiSessionPool } from '@pi-meme/pi-runtime/session-pool'
import { activePathIds } from '@pi-meme/contracts/session-tree'
import { readSessionHistory } from '@pi-meme/pi-runtime/session-history'
import { createDesktopModelRuntime } from '@pi-meme/pi-runtime/sdk/model-runtime'
import { loadPiSdk } from '@pi-meme/pi-runtime/sdk/load'
import type { SecureCredentialStorage } from '@pi-meme/contracts/secure-storage'
import type { MemoryService } from '@pi-meme/memory/server/service'

type PendingTurn = {
  ticket: MemoryTurnTicket
  before: Set<string>
  modeRevision: number
  userText: string
}
type Options = {
  hostId: string
  service: () => MemoryService | undefined
  pi: () => PiSessionPool
  resolve: (key: string) => Promise<AppSession>
  get: (ref: SessionRef) => Promise<AppSession>
}

function textOf(message: PiMessage): string {
  if (!('content' in message)) return ''
  if (typeof message.content === 'string') return message.content
  return message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
}

/** Remove known harness payloads, keeping source identity tied to the untouched native entry. */
function learningText(input: string): string {
  let value = input
  for (const tag of ['skill', 'system-reminder', 'environment_context', 'app_memory', 'app_runtime', 'app_output']) {
    const lower = value.toLowerCase()
    const start = lower.search(new RegExp(`<${tag}(?:\\s|>)`))
    if (start < 0) continue
    const closing = `</${tag}>`
    const end = lower.lastIndexOf(closing)
    if (end < start) return ''
    // Greedy removal is deliberate: nested examples cannot leak the remainder of a skill into learning.
    value = value.slice(0, start) + value.slice(end + closing.length)
  }
  return value.replaceAll('\uFFFC', '').trim()
}

/** Links learning to admitted user turns, never to a scan of imported or copied history. */
export class MemoryCoordinator {
  private turns = new Map<string, PendingTurn>()
  private activeSessions = new Map<string, string>()
  private lastActivity = new Map<string, number>()
  private sessionByKey = new Map<string, string>()
  private busyKeys = new Set<string>()

  constructor(private readonly options: Options) {}

  async begin(
    key: string,
    message: string,
    mode: TaskMode,
    eligible: boolean,
    selectedModel?: { provider: string; id: string },
  ) {
    await this.cancel(key)
    const service = this.options.service()
    const binding = this.options.pi().readSessionBinding(key)
    const session = await this.options.resolve(key)
    this.activeSessions.set(key, session.sessionId)
    this.sessionByKey.set(key, session.sessionId)
    this.lastActivity.set(session.sessionId, Date.now())
    const userText = learningText(message)
    if (!service || !eligible || mode !== 'default' || !userText) return
    const model = selectedModel ?? binding.state.model
    if (binding.accessMode !== 'full-access' || binding.temporary || !model || !session.project || session.temporary)
      return
    const history =
      binding.historySaved && binding.sessionFile ? await readSessionHistory(binding.sessionFile) : undefined
    const before = new Set(history?.sessionEntries?.entries.map((entry) => entry.id) ?? [])
    const current = this.options.pi().readSessionBinding(key)
    if (current.modeRevision !== binding.modeRevision || current.sessionFile !== binding.sessionFile) return
    const ticket = await service.beginTurn({
      session: { hostId: this.options.hostId, sessionId: session.sessionId },
      projectId: session.project.projectId,
      model: { provider: model.provider, id: model.id },
      mode,
      accessMode: binding.accessMode,
      eligible: true,
    })
    if (ticket) this.turns.set(key, { ticket, before, modeRevision: binding.modeRevision, userText })
  }

  observeState(key: string, busy: boolean) {
    const sessionId = this.sessionByKey.get(key)
    if (!sessionId) return
    const wasBusy = this.busyKeys.has(key)
    if (busy) this.busyKeys.add(key)
    else this.busyKeys.delete(key)
    if (busy || wasBusy) this.lastActivity.set(sessionId, Date.now())
  }

  idleSince(sessionId: string): number | null {
    if ([...this.activeSessions.values()].includes(sessionId)) return null
    if ([...this.busyKeys].some((key) => this.sessionByKey.get(key) === sessionId)) return null
    return this.lastActivity.get(sessionId) ?? 0
  }

  async settled(session: AppSession, key: string, aborted: boolean) {
    try {
      await this.collectTurn(session, key, aborted)
    } finally {
      this.activeSessions.delete(key)
      this.lastActivity.set(session.sessionId, Date.now())
    }
  }

  private async collectTurn(session: AppSession, key: string, aborted: boolean) {
    const pending = this.turns.get(key)
    this.turns.delete(key)
    const service = this.options.service()
    if (!pending || !service) return
    let consumed = false
    try {
      if (aborted || !session.sessionFile) return
      const binding = this.options.pi().readSessionBinding(key)
      if (
        binding.modeRevision !== pending.modeRevision ||
        binding.accessMode !== 'full-access' ||
        binding.state.mode !== 'default' ||
        session.project?.projectId !== pending.ticket.projectId
      )
        return
      const history = await readSessionHistory(session.sessionFile)
      if (!history.sessionEntries) return
      const active = activePathIds(history.sessionEntries.entries, history.sessionEntries.leafId)
      const messages = history.messages.filter(
        (message) =>
          message.sourceEntry && active.has(message.sourceEntry.id) && !pending.before.has(message.sourceEntry.id),
      )
      // A command, continuation, or synthesized completion is not an admitted user message.
      if (
        !messages.some((message) => message.role === 'user' && learningText(textOf(message)).includes(pending.userText))
      )
        return
      const sources: MemoryLearningSource[] = []
      for (const message of messages) {
        if (message.role !== 'user' && message.role !== 'assistant') continue
        if (message.role === 'assistant' && !['stop', 'length'].includes(message.stopReason)) continue
        const text = message.role === 'user' ? learningText(textOf(message)) : textOf(message).trim()
        const entry = message.sourceEntry!
        if (!text) continue
        sources.push({
          role: message.role,
          text,
          source: {
            id: createHash('sha256')
              .update(JSON.stringify([session.hostId, session.sessionId, entry.id]))
              .digest('hex'),
            session: { hostId: session.hostId, sessionId: session.sessionId },
            entryId: entry.id,
            revision: entry.revision,
            excerpt: text.slice(0, 400),
          },
        })
      }
      if (sources.some((source) => source.role === 'user')) {
        await service.settleTurn(pending.ticket, sources)
        consumed = true
      }
    } finally {
      if (!consumed) await service.settleTurn(pending.ticket, [])
    }
  }

  async cancel(key: string) {
    const pending = this.turns.get(key)
    this.turns.delete(key)
    const sessionId = this.activeSessions.get(key)
    this.activeSessions.delete(key)
    this.busyKeys.delete(key)
    if (sessionId) this.lastActivity.set(sessionId, Date.now())
    if (pending) await this.options.service()?.settleTurn(pending.ticket, [])
  }

  async validateSources(sources: MemorySource[]): Promise<boolean> {
    const histories = new Map<string, Awaited<ReturnType<typeof readSessionHistory>>>()
    try {
      for (const source of sources) {
        if (source.session.hostId !== this.options.hostId) return false
        let history = histories.get(source.session.sessionId)
        if (!history) {
          const session = await this.options.get(source.session)
          if (!session.sessionFile || session.temporary) return false
          history = await readSessionHistory(session.sessionFile)
          histories.set(source.session.sessionId, history)
        }
        const entry = history.messages.find((message) => message.sourceEntry?.id === source.entryId)?.sourceEntry
        if (!entry || entry.revision !== source.revision) return false
        if (
          !history.sessionEntries ||
          !activePathIds(history.sessionEntries.entries, history.sessionEntries.leafId).has(source.entryId)
        )
          return false
      }
      return true
    } catch {
      return false
    }
  }

  async historyEdited(key: string) {
    await this.cancel(key)
    const service = this.options.service()
    if (!service) return
    const session = await this.options.resolve(key)
    await service.invalidateSessionHistory(session.sessionId)
  }
}

/** Uses the app's configured credential store and provider runtime, with no tools or agent session. */
export function memoryModelCompletion(
  agentDir: string,
  credentials: SecureCredentialStorage,
): MemoryServiceOptions['complete'] {
  return async ({ model: selected, system, prompt, maxTokens, signal }) => {
    signal.throwIfAborted()
    const runtime = await createDesktopModelRuntime(await loadPiSdk(), agentDir, credentials)
    const model = runtime.getModel(selected.provider, selected.id)
    if (
      !model ||
      !runtime.getAvailableSnapshot().some((entry) => entry.provider === model.provider && entry.id === model.id)
    )
      throw new Error('记忆模型当前不可用，请重新选择模型')
    const estimate = Math.ceil(Buffer.byteLength(system + prompt, 'utf8') / 2)
    if (model.contextWindow > 0 && estimate + maxTokens > model.contextWindow * 0.85)
      throw new Error('记忆输入超过所选模型的上下文预算')
    const result = await runtime.completeSimple(
      model,
      {
        systemPrompt: system,
        messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
        tools: [],
      },
      { signal, maxTokens: Math.min(maxTokens, model.maxTokens || maxTokens), temperature: 0, reasoning: 'low' },
    )
    const usage = result.usage
    const hasPricing = Object.values(model.cost ?? {}).some(
      (value) => typeof value === 'number' && Number.isFinite(value) && value > 0,
    )
    const cost = usage?.cost?.total
    return {
      text: result.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join(''),
      usage: usage && {
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        totalTokens: usage.totalTokens,
      },
      // SDK fills absent pricing with zero; preserve unknown cost instead of reporting a free call.
      cost: typeof cost === 'number' && (cost > 0 || hasPricing) ? cost : undefined,
    }
  }
}
