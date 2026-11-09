import { randomUUID } from 'node:crypto'
import { types } from 'node:util'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai'
import {
  contextCaptureLimits,
  type ContextPiece,
  type ContextPurpose,
  type ContextRuntimeCapture,
} from '@pi-meme/contracts/context-window'

const captureToken = Symbol('pi-meme-context-invocation')
const capturePurpose = Symbol('pi-meme-context-purpose')
type ModelRuntime = AgentSession['modelRuntime']
type StreamOptions = SimpleStreamOptions & { [captureToken]?: Invocation; [capturePurpose]?: ContextPurpose }

export type ContextObserverState = {
  enabled: boolean
  generation: number
  nativeSessionId: string
  inputLeafId?: string
  compactionId?: string
  onPayload: SimpleStreamOptions['onPayload']
  defaultStreamFunction: AgentSession['agent']['streamFunction']
  currentStreamFunction: AgentSession['agent']['streamFunction']
  summarizing: boolean
  resultEntryId: (message: AssistantMessage) => string | undefined
}
export type ContextObserverOptions = {
  state: (runtime: ModelRuntime) => ContextObserverState | undefined
  capture: (event: ContextRuntimeCapture) => void
}
type Invocation = {
  owner: object
  state: ContextObserverState
  event: ContextRuntimeCapture
  terminal: boolean
  capturedPayload: boolean
}

/** Local caller metadata; it never becomes a provider payload field. */
export function contextCaptureOptions<T extends object>(options: T, purpose: 'hint'): T {
  return { ...options, [capturePurpose]: purpose }
}

function plainJson(value: unknown) {
  const pending: unknown[] = [value]
  const seen = new WeakSet<object>()
  let visited = 0
  while (pending.length) {
    const item = pending.pop()
    if (++visited > 1_000_000) return false
    if (typeof item === 'function' || typeof item === 'bigint') return false
    if (!item || typeof item !== 'object') continue
    if (types.isProxy(item)) return false
    if (seen.has(item)) continue
    seen.add(item)
    const prototype = Object.getPrototypeOf(item)
    if (prototype !== null && prototype !== Object.prototype && prototype !== Array.prototype) return false
    const hook =
      Object.getOwnPropertyDescriptor(item, 'toJSON') ??
      (prototype && Object.getOwnPropertyDescriptor(prototype, 'toJSON')) ??
      Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON')
    if (hook && (hook.get || hook.set || typeof hook.value === 'function')) return false
    const keys = Object.keys(item)
    if (Array.isArray(item) && keys.length !== item.length) return false
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!
      if (descriptor.get || descriptor.set) return false
      pending.push(descriptor.value)
    }
  }
  return true
}

function bodyText(value: unknown): Pick<ContextRuntimeCapture, 'body' | 'bodyState'> {
  try {
    // Observing a custom payload must not invoke its getters, proxies or toJSON a second time.
    if (!plainJson(value)) return { bodyState: 'unread' }
    let bytes = 0
    const body = JSON.stringify(value, (_key, item: unknown) => {
      // Bound large strings before JSON.stringify allocates the entire escaped body.
      bytes += typeof item === 'string' ? Buffer.byteLength(item) : 1
      if (bytes > contextCaptureLimits.bodyBytes) throw new RangeError('Context body too large')
      return item
    })
    if (body === undefined) return { bodyState: 'unread' }
    return Buffer.byteLength(body) <= contextCaptureLimits.bodyBytes
      ? { body, bodyState: 'memory' }
      : { bodyState: 'too-large' }
  } catch (cause) {
    return {
      bodyState: cause instanceof RangeError && cause.message === 'Context body too large' ? 'too-large' : 'unread',
    }
  }
}

/** Fit JSON string contents (without quotes), retaining complete UTF-16 pairs. */
function jsonStringPrefix(text: string, budget: number) {
  let end = 0
  let bytes = 0
  while (end < text.length) {
    const code = text.charCodeAt(end)
    const next = text.charCodeAt(end + 1)
    const pair = code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
    const escaped = code === 34 || code === 92 || (code >= 8 && code <= 10) || code === 12 || code === 13
    const size = pair
      ? 4
      : escaped
        ? 2
        : code < 32 || (code >= 0xd800 && code <= 0xdfff)
          ? 6
          : code < 128
            ? 1
            : code < 2048
              ? 2
              : 3
    if (bytes + size > budget) break
    bytes += size
    end += pair ? 2 : 1
  }
  return { text: text.slice(0, end), bytes, cut: end < text.length }
}

function replyPieces(message: AssistantMessage): Pick<ContextRuntimeCapture, 'reply' | 'replyCut'> {
  const reply: ContextPiece[] = []
  let remaining = contextCaptureLimits.bodyBytes - 2 // JSON array brackets
  let replyCut = false
  for (const block of message.content) {
    if (reply.length === 1024) {
      replyCut = true
      break
    }
    let piece: ContextPiece
    if (block.type === 'text') piece = { role: 'assistant', text: block.text }
    else if (block.type === 'thinking')
      piece = block.redacted
        ? { role: 'sealed', text: 'Redacted thinking' }
        : { role: 'thinking', text: block.thinking }
    else if (block.type === 'toolCall') {
      const argumentsText = bodyText(block.arguments).body
      piece = { role: 'call', name: block.name, text: argumentsText ?? '' }
      replyCut ||= argumentsText === undefined
    } else continue
    const text = piece.text ?? ''
    if (piece.name) {
      const name = jsonStringPrefix(piece.name, 4096)
      piece.name = name.text
      replyCut ||= name.cut
    }
    const metadata = { ...piece, text: '', characters: text.length, size: Buffer.byteLength(text) }
    const overhead = Buffer.byteLength(JSON.stringify(metadata)) + (reply.length ? 1 : 0)
    if (overhead > remaining) {
      replyCut = true
      break
    }
    const prefix = jsonStringPrefix(text, remaining - overhead)
    reply.push({ ...metadata, text: prefix.text })
    remaining -= overhead + prefix.bytes
    replyCut ||= prefix.cut
    if (replyCut) break
  }
  return { reply, replyCut }
}

/** Observe the existing consumer. Never drain a second iterator or eagerly request result(). */
function observeStream(
  stream: AssistantMessageEventStream,
  terminal: (message: AssistantMessage) => void,
  failed: (cause: unknown) => void,
  cancelled: () => void,
): AssistantMessageEventStream {
  const observe = (event: AssistantMessageEvent) => {
    if (event.type === 'done') terminal(event.message)
    else if (event.type === 'error') terminal(event.error)
  }
  return new Proxy(stream, {
    get(target, property) {
      if (property === 'result')
        return () => {
          try {
            return target.result().then(
              (message) => {
                terminal(message)
                return message
              },
              (cause: unknown) => {
                failed(cause)
                throw cause
              },
            )
          } catch (cause) {
            failed(cause)
            throw cause
          }
        }
      if (property === Symbol.asyncIterator)
        return () => {
          const iterator = target[Symbol.asyncIterator]()
          const observed: AsyncIterableIterator<AssistantMessageEvent> = {
            async next(value?: unknown) {
              try {
                const next = await iterator.next(value)
                if (!next.done) observe(next.value)
                return next
              } catch (cause) {
                failed(cause)
                throw cause
              }
            },
            [Symbol.asyncIterator]() {
              return observed
            },
          }
          if (iterator.return)
            observed.return = async (value) => {
              try {
                const result = await iterator.return!(value)
                if (!result.done) observe(result.value)
                cancelled()
                return result
              } catch (cause) {
                cancelled()
                throw cause
              }
            }
          if (iterator.throw)
            observed.throw = async (cause) => {
              try {
                const result = await iterator.throw!(cause)
                if (!result.done) observe(result.value)
                else cancelled()
                return result
              } catch (failure) {
                failed(failure)
                throw failure
              }
            }
          return observed
        }
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/** Decorate the same runtime instance, leaving SDK stream-function identity and auth untouched. */
export function observeModelRuntime(runtime: ModelRuntime, options: ContextObserverOptions): void {
  const owner = {}
  const firstContexts = new WeakMap<Context, Invocation>()
  const readState = () => {
    try {
      return options.state(runtime)
    } catch {
      return undefined
    }
  }
  const emit = (invocation: Invocation, event: ContextRuntimeCapture) => {
    try {
      const current = readState()
      const currentTarget =
        current?.enabled &&
        current.generation === invocation.state.generation &&
        current.nativeSessionId === invocation.state.nativeSessionId
      if (invocation.state.enabled && (currentTarget || (event.phase !== 'payload' && invocation.capturedPayload))) {
        options.capture(event)
        if (event.phase === 'payload') invocation.capturedPayload = true
      }
    } catch {
      // Capture is best-effort; neither serialization nor subscribers may affect inference.
    }
  }
  const wrap =
    <Options extends SimpleStreamOptions>(
      original: (model: Model<Api>, context: Context, options?: Options) => AssistantMessageEventStream,
    ) =>
    (model: Model<Api>, context: Context, input?: Options): AssistantMessageEventStream => {
      const incoming = input as (Options & StreamOptions) | undefined
      // Virtual routing calls this.streamSimple again with the same original Context.
      if (incoming?.[captureToken]?.owner === owner) return original(model, context, input)
      const state = readState()
      if (!state) return original(model, context, input)
      const first = firstContexts.get(context)
      const native = input?.sessionId === state.nativeSessionId
      const callback = typeof input?.onPayload === 'function' && input.onPayload === state.onPayload
      let purpose: ContextPurpose = 'unknown'
      if (incoming?.[capturePurpose] === 'hint') purpose = 'hint'
      else if (
        first?.event.purpose === 'main' &&
        first.state.generation === state.generation &&
        first.state.nativeSessionId === state.nativeSessionId &&
        native &&
        callback &&
        state.currentStreamFunction === state.defaultStreamFunction
      )
        purpose = 'cache_warm'
      else if (!first && native && callback && state.currentStreamFunction === state.defaultStreamFunction)
        purpose = 'main'
      else if (!input?.onPayload && state.summarizing) purpose = 'summary'
      const invocation: Invocation = {
        owner,
        state,
        terminal: false,
        capturedPayload: false,
        event: {
          id: randomUUID(),
          generation: state.generation,
          nativeSessionId: state.nativeSessionId,
          time: new Date().toISOString(),
          phase: 'payload',
          payloadRevision: 0,
          purpose,
          api: model.api,
          model: `${model.provider}/${model.id}`,
          window: model.contextWindow > 0 ? model.contextWindow : undefined,
          inputLeafId: state.inputLeafId,
          compactionId: state.compactionId,
          cacheKnowledge: 'unknown',
        },
      }
      if (!first) firstContexts.set(context, invocation)
      const finish = (message?: AssistantMessage, cause?: unknown, cancelled = false) => {
        if (invocation.terminal) return
        invocation.terminal = true
        if (!state.enabled) return
        const aborted = cancelled || message?.stopReason === 'aborted' || input?.signal?.aborted === true
        // The SDK appends the native message after its public message_end boundary.
        setImmediate(() => {
          try {
            const event: ContextRuntimeCapture = {
              ...invocation.event,
              phase: aborted
                ? 'aborted'
                : cause !== undefined || message?.stopReason === 'error'
                  ? 'failed'
                  : 'complete',
              body: undefined,
              bodyState: undefined,
              resultEntryId: undefined,
              error: message?.errorMessage ?? (cause === undefined ? undefined : String(cause).slice(0, 2000)),
            }
            if (message) {
              event.usage = {
                input: message.usage.input,
                output: message.usage.output,
                cacheRead: message.usage.cacheRead,
                cacheWrite: message.usage.cacheWrite,
              }
              // A positive SDK cache-read count establishes a hit; its normalized zero does not prove presence.
              if (Number.isFinite(message.usage.cacheRead) && message.usage.cacheRead > 0)
                event.cacheKnowledge = 'known'
              try {
                event.resultEntryId = state.resultEntryId(message)
              } catch {
                // A disposed old session may no longer resolve native entries.
              }
              try {
                Object.assign(event, replyPieces(message))
              } catch {
                event.replyCut = true
              }
              event.servedModel ??= message.responseModel
            }
            emit(invocation, event)
          } catch {
            // Malformed custom-provider output is not an inference failure of the observer.
          }
        })
      }
      const originalPayload = input?.onPayload
      const originalResponse = input?.onResponse
      const observedOptions = {
        ...input,
        [captureToken]: invocation,
        onPayload: async (payload: unknown, payloadModel: Model<Api>) => {
          const replacement = await originalPayload?.(payload, payloadModel)
          if (!state.enabled || invocation.terminal) return replacement
          try {
            invocation.event = {
              ...invocation.event,
              api: payloadModel.api,
              model: `${payloadModel.provider}/${payloadModel.id}`,
              window: payloadModel.contextWindow > 0 ? payloadModel.contextWindow : undefined,
              payloadRevision: invocation.event.payloadRevision + 1,
              ...bodyText(replacement === undefined ? payload : replacement),
            }
            emit(invocation, { ...invocation.event })
            // The body belongs to the payload event, not the retained invocation or terminal IPC.
            invocation.event = { ...invocation.event, body: undefined, bodyState: undefined }
          } catch {
            // The original hook's replacement (including undefined/null) must remain unchanged.
          }
          return replacement
        },
        onResponse: async (
          response: Parameters<NonNullable<SimpleStreamOptions['onResponse']>>[0],
          responseModel: Model<Api>,
        ) => {
          await originalResponse?.(response, responseModel)
          try {
            // Only these explicit non-secret routing headers are retained.
            const headers = Object.fromEntries(
              Object.entries(response.headers)
                .map(([key, value]) => [key.toLowerCase(), value] as const)
                .filter(([key]) => key === 'x-magpie-provider' || key === 'x-magpie-model'),
            )
            const served = headers['x-magpie-model']
            if (served)
              invocation.event.servedModel =
                headers['x-magpie-provider'] && !served.includes('/')
                  ? `${headers['x-magpie-provider']}/${served}`
                  : served
          } catch {
            // Optional routing metadata cannot alter the provider response.
          }
        },
      } as unknown as Options
      try {
        return observeStream(
          original(model, context, observedOptions),
          (message) => finish(message),
          (cause) => finish(undefined, cause),
          () => finish(undefined, undefined, true),
        )
      } catch (cause) {
        finish(undefined, cause)
        throw cause
      }
    }
  runtime.stream = wrap(runtime.stream.bind(runtime)) as ModelRuntime['stream']
  runtime.streamSimple = wrap(runtime.streamSimple.bind(runtime))
}
