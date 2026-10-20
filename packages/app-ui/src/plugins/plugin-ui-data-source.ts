import type { HostApi } from '@pi-meme/contracts/app-host'
import type { PiMessage } from '@pi-meme/contracts/pi'
import type {
  MessageRef,
  UiMessageBody,
  UiMessageMetadata,
  UiMessagePage,
  UiReactiveMetadata,
  UiReactiveState,
} from '@pi-meme/contracts/plugin-ui-data'
import { freezeUiValue, messageRefKey, sameUiTarget } from '@pi-meme/contracts/plugin-ui-data'
import { uiMessageBody, uiMessageMetadata } from '@pi-meme/contracts/plugin-ui-message'
import type { UiDataSource, UiExternalStore, UiMessagesApi, UiReactiveApi } from '@pi-meme/plugin-sdk/reactive'
import type { ChatStream } from '@pi-meme/chat/ui/model/chat-stream'

function equalJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right)
}

export class PluginUiDataSource implements UiDataSource {
  private state: UiReactiveState = freezeUiValue({ target: { hostId: '' }, session: null, messages: [] })
  private metadata: UiReactiveMetadata = freezeUiValue({ target: this.state.target, session: null })
  private readonly listeners = new Set<() => void>()
  private readonly bodyListeners = new Set<() => void>()
  private readonly raw = new Map<string, PiMessage>()
  private readonly bodies = new Map<string, { raw?: PiMessage; revision?: string; body: UiMessageBody }>()
  private readonly pages = new Map<string, UiMessagePage>()
  private readonly transient = new WeakMap<object, string>()
  private readonly pending = new Map<string, Promise<unknown>>()
  private sequence = 0
  private liveId: string | undefined
  private stop?: () => void
  private stream?: ChatStream
  private frame: number | undefined
  private disposed = false
  readonly reactive: UiReactiveApi
  readonly messages: UiMessagesApi

  constructor(private readonly host: HostApi) {
    this.reactive = {
      getSnapshot: () => this.state,
      subscribe: (listener) => this.listen(this.listeners, listener),
      metadata: this.selection(() => this.metadata),
      select: (selector, equal = Object.is) => this.selection(() => selector(this.state), equal),
      message: (id) => this.selection(() => this.state.messages.find((message) => message.id === id)),
      body: (id) => this.bodyStore(id),
    }
    this.messages = {
      page: async (session, input) => {
        // 先由 Host 校验游标和分支，缓存只复用同修订响应，不绕过 stale-cursor 检查。
        const page = await this.request(`page:${JSON.stringify([session, input])}`, () =>
          host.sessions.messages(session, input),
        )
        const key = JSON.stringify([session, page.branchRevision, input])
        const cached = this.pages.get(key)
        if (cached) {
          this.pages.delete(key)
          this.pages.set(key, cached)
          return cached
        }
        this.pages.set(key, page)
        while (this.pages.size > 32) this.pages.delete(this.pages.keys().next().value!)
        return page
      },
      getMessage: (ref) => this.getMessage(ref),
      body: (ref) => {
        const store = this.bodyStore(messageRefKey(ref))
        return {
          getSnapshot: store.getSnapshot,
          subscribe: (listener) => {
            let active = true
            const stop = store.subscribe(listener)
            if (!this.raw.has(messageRefKey(ref)))
              void this.getMessage(ref)
                .then(() => {
                  if (active) listener()
                })
                .catch(() => {})
            return () => {
              active = false
              stop()
            }
          },
        }
      },
    }
  }

  private listen(listeners: Set<() => void>, listener: () => void) {
    if (this.disposed) return () => {}
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  private selection<T>(read: () => T, equal: (left: T, right: T) => boolean = Object.is): UiExternalStore<T> {
    let value = read()
    return {
      getSnapshot: () => {
        const next = read()
        if (!equal(value, next)) value = next
        return value
      },
      subscribe: (listener) =>
        this.listen(this.listeners, () => {
          try {
            const next = read()
            if (equal(value, next)) return
            value = next
            listener()
          } catch {
            // 单个插件 selector 出错不能中断其他订阅。
          }
        }),
    }
  }

  private bodyStore(id: string): UiExternalStore<UiMessageBody | undefined> {
    const read = () => {
      const raw = this.raw.get(id)
      const cached = this.bodies.get(id)
      if (cached) {
        this.bodies.delete(id)
        this.bodies.set(id, cached)
      }
      if (!raw) return cached?.body
      const metadata = this.state.messages.find((message) => message.id === id)
      if (!metadata) return undefined
      if (cached && (cached.raw === raw || (metadata.ref && cached.revision === metadata.revision))) return cached.body
      const body = uiMessageBody(raw, metadata)
      this.bodies.set(id, { raw, body, revision: metadata.ref ? metadata.revision : undefined })
      while (this.bodies.size > 200) this.bodies.delete(this.bodies.keys().next().value!)
      return body
    }
    let value = read()
    return {
      getSnapshot: () => {
        value = read()
        return value
      },
      subscribe: (listener) =>
        this.listen(this.bodyListeners, () => {
          const next = read()
          if (next === value) return
          value = next
          listener()
        }),
    }
  }

  private request<T>(key: string, work: () => Promise<T>): Promise<T> {
    const existing = this.pending.get(key)
    if (existing) return existing as Promise<T>
    const epoch = this.state.targetEpoch
    const request = work()
      .then((value) => {
        if (this.disposed || epoch !== this.state.targetEpoch) throw new Error('stale-target：插件数据目标已变化')
        return freezeUiValue(structuredClone(value))
      })
      .finally(() => {
        if (this.pending.get(key) === request) this.pending.delete(key)
      })
    this.pending.set(key, request)
    return request
  }

  private async getMessage(ref: MessageRef) {
    const id = messageRefKey(ref)
    const metadata = this.state.messages.find((message) => message.id === id)
    const raw = this.raw.get(id)
    if (metadata && raw) return freezeUiValue({ ...metadata, ...uiMessageBody(raw, metadata) })
    const message = await this.request(`message:${id}`, () =>
      this.host.sessions.message(ref.session, { entryId: ref.entryId }),
    )
    // 共享缓存只保留有界的正文，不把历史大消息加入当前索引。
    if (this.bodies.get(id)?.revision !== message.revision)
      this.bodies.set(id, {
        body: freezeUiValue({ text: message.text, images: message.images, data: message.data }),
        revision: message.revision,
      })
    while (this.bodies.size > 200) this.bodies.delete(this.bodies.keys().next().value!)
    for (const listener of this.bodyListeners) listener()
    return message
  }

  setEnvironment(environment: UiReactiveMetadata) {
    if (this.disposed) return
    const changedTarget = !sameUiTarget(this.state.target, environment.target)
    const next = {
      ...structuredClone(environment),
      targetEpoch: changedTarget ? (this.state.targetEpoch ?? 0) + 1 : (this.state.targetEpoch ?? 0),
    }
    if (!equalJson(this.metadata, next)) {
      this.metadata = freezeUiValue(next)
      this.state = freezeUiValue({ ...next, messages: changedTarget ? [] : this.state.messages })
      if (changedTarget) {
        this.raw.clear()
        this.bodies.clear()
        this.liveId = undefined
      }
      this.publish()
    }
    this.refresh()
  }

  attach(stream: ChatStream) {
    this.stop?.()
    this.stream = stream
    this.stop = stream.subscribe(() => this.refresh())
    this.refresh()
    return () => {
      if (this.stream !== stream) return
      this.stop?.()
      this.stop = undefined
      this.stream = undefined
    }
  }

  private refresh() {
    const chat = this.stream?.getSnapshot()
    const session = this.state.target.session
    if (!chat || !session || this.disposed) return
    const runtime = this.metadata.session
    if (runtime) {
      const metrics = chat.generationMetrics
      const next = {
        ...runtime,
        running: chat.running,
        paused: chat.paused,
        queuePaused: chat.queuePaused,
        effectiveMode: chat.activeMode ?? runtime.requestedMode ?? runtime.mode,
        queue: { steering: chat.steering.length, followUp: chat.followUp.length },
        generation: metrics
          ? {
              outputTokens: metrics.outputTokens,
              elapsedMs: metrics.elapsedMs,
              phase: metrics.phase,
              estimated: metrics.estimated,
            }
          : runtime.generation,
      }
      if (!equalJson(runtime, next)) {
        this.metadata = freezeUiValue({ ...this.metadata, session: next })
        this.state = freezeUiValue({ ...this.state, ...this.metadata })
        this.publish()
      }
    }
    if (chat.live) this.liveId ??= `stream:${++this.sequence}`
    else this.liveId = undefined
    const recent: PiMessage[] = []
    for (let index = chat.messages.length - 1; index >= 0 && recent.length < 100; index--) {
      const message = chat.messages[index]!
      if (['user', 'assistant', 'toolResult', 'custom'].includes(message.role)) recent.push(message)
    }
    recent.reverse()
    const input = chat.live ? [...recent, chat.live] : recent
    const previous = new Map(this.state.messages.map((message) => [message.id, message]))
    const nextRaw = new Map<string, PiMessage>()
    const messages: UiMessageMetadata[] = []
    for (const message of input) {
      let transientId = message === chat.live ? this.liveId : this.transient.get(message)
      if (!message.sourceEntry && !transientId) {
        transientId = `stream:${++this.sequence}`
        this.transient.set(message, transientId)
      }
      const metadata = uiMessageMetadata(message, session, transientId)
      if (!metadata) continue
      const old = previous.get(metadata.id)
      messages.push(old && equalJson(old, metadata) ? old : metadata)
      nextRaw.set(metadata.id, message)
    }
    const changed =
      messages.length !== this.state.messages.length ||
      messages.some((message, index) => message !== this.state.messages[index])
    this.raw.clear()
    for (const [id, message] of nextRaw) this.raw.set(id, message)
    for (const id of this.bodies.keys()) if (!nextRaw.has(id)) this.bodies.delete(id)
    if (changed) {
      this.state = freezeUiValue({ ...this.metadata, messages })
      this.publish()
    }
    if (!chat.live) this.flushBodies()
    else if (this.frame === undefined) {
      if (typeof requestAnimationFrame === 'function') this.frame = requestAnimationFrame(() => this.flushBodies())
      else this.flushBodies()
    }
  }

  private publish() {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        /* 不让一个订阅阻断其他消费者。 */
      }
    }
  }

  private flushBodies() {
    if (this.frame !== undefined && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.frame)
    this.frame = undefined
    for (const listener of this.bodyListeners) {
      try {
        listener()
      } catch {
        /* 继续通知其他正文订阅。 */
      }
    }
  }

  dispose() {
    this.disposed = true
    this.stop?.()
    if (this.frame !== undefined && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.frame)
    this.listeners.clear()
    this.bodyListeners.clear()
    this.pending.clear()
    this.pages.clear()
    this.raw.clear()
    this.bodies.clear()
  }
}
