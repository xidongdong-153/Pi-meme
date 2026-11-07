import { randomBytes } from 'node:crypto'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { ContextPurpose, ContextRuntimeCapture } from '@pi-meme/contracts/context-window'
import type { ProjectRef, SessionRef } from '@pi-meme/contracts/app-host'
import type { AgentExecution } from '@pi-meme/contracts/collaboration'
import { contextCaptureBody, contextCaptureReply } from '@pi-meme/pi-runtime/sdk/context-observer'
import {
  modelBrokerOptions,
  sanitizeBrokerModel,
  type AnyModel,
  type AssistantMessageEvent,
  type ClassifierContext,
  type Context,
  type ImagesContext,
  type ModelBrokerCatalog,
  type ModelBrokerOperation,
  type ModelBrokerReply,
  type ModelBrokerRequest,
  type ModelBrokerTarget,
} from '@pi-meme/pi-runtime/sdk/model-broker-protocol'

export type ModelBrokerCaptureOwner = {
  requestId: string
  /** Host-generated storage identity; Worker request UUIDs can be reused after Worker replacement. */
  captureId: string
  actor: Pick<
    AgentExecution,
    | 'agentId'
    | 'rootAgentId'
    | 'rootSessionKey'
    | 'sessionKey'
    | 'runId'
    | 'rootTaskId'
    | 'epoch'
    | 'executionGeneration'
  >
  session: SessionRef
  rootSession: SessionRef
  project?: ProjectRef
  cwd: string
  generation: number
  nativeSessionId: string
  temporaryRoot?: string
  model?: { provider: string; id: string; api?: string; contextWindow?: number }
  inputLeafId?: string
  purpose?: ContextPurpose
}

export type ModelBrokerActor = {
  /** True Worker/run/epoch/generation policy revision, obtained from the Host, never request input. */
  scopeKey: string
  /** Host observation ownership, captured only at open. Never supplied by the Worker. */
  captureOwner?: ModelBrokerCaptureOwner
  model?: ModelBrokerTarget
  allowedModels?: ModelBrokerTarget[]
  maxOutputTokens?: number
  maxCost?: number
}
export type ModelBrokerCapture = Pick<
  ContextRuntimeCapture,
  | 'id'
  | 'time'
  | 'phase'
  | 'payloadRevision'
  | 'body'
  | 'bodyState'
  | 'reply'
  | 'replyCut'
  | 'usage'
  | 'error'
  | 'servedModel'
  | 'cacheKnowledge'
> & {
  /** Display metadata only. This field never participates in authorization. */
  purpose?: ContextPurpose
  canonicalModel: { provider: string; id: string; api: string; contextWindow?: number }
}
type CaptureFields = Pick<
  ModelBrokerCapture,
  'body' | 'bodyState' | 'reply' | 'replyCut' | 'usage' | 'error' | 'servedModel' | 'cacheKnowledge'
>
type TerminalEvent = Extract<AssistantMessageEvent, { type: 'done' | 'error' }>

function captureReply(event: TerminalEvent): Partial<CaptureFields> {
  const message = event.type === 'done' ? event.message : event.error
  const capture: Partial<CaptureFields> = { replyCut: true }
  try {
    const usage = message.usage
    const count = (value: number) => (Number.isFinite(value) && value >= 0 ? value : 0)
    capture.usage = {
      input: count(usage.input),
      output: count(usage.output),
      cacheRead: count(usage.cacheRead),
      cacheWrite: count(usage.cacheWrite),
    }
    capture.cacheKnowledge = capture.usage.cacheRead > 0 ? 'known' : 'unknown'
  } catch {
    /* Malformed provider metadata cannot affect inference. */
  }
  try {
    Object.assign(capture, contextCaptureReply(message))
  } catch {
    /* Keep the bounded unread marker. */
  }
  try {
    if (typeof message.responseModel === 'string') capture.servedModel = message.responseModel.slice(0, 512)
  } catch {
    /* Routing metadata is optional. */
  }
  return capture
}

type Options = {
  runtime: () => Promise<ModelRuntime>
  context: (capture?: { requestId: string }) => Promise<ModelBrokerActor>
  execute: <T>(
    operation: ModelBrokerOperation,
    input: unknown,
    signal: AbortSignal,
    body: (signal: AbortSignal) => Promise<T>,
  ) => Promise<T>
  /** Host-only request instrumentation; never receives credentials from the Worker. */
  onPayload?: (payload: unknown, model: AnyModel) => void | Promise<void>
  /** Host-only bounded capture. Complete means provider + execute/fee settled, not Worker delivery. Never awaited. */
  onCapture?: (event: ModelBrokerCapture, owner: Readonly<ModelBrokerCaptureOwner> | undefined) => void | Promise<void>
}
type BrokerGeneration = { id: number; controller: AbortController }

type StreamState = {
  controller: AbortController
  scopeKey: string
  events: AssistantMessageEvent[]
  bytes: number
  done: boolean
  error?: string
  reading: boolean
  changed: Set<() => void>
  completed: Promise<void>
}
const maxBytes = 8 * 1024 * 1024
const sameModel = (a: ModelBrokerTarget, b: ModelBrokerTarget) => a.provider === b.provider && a.id === b.id

/** One private Worker audience. It never accepts URLs, headers, environment overrides or provider credentials. */
export function createModelBrokerSession(options: Options) {
  const audience = randomBytes(32).toString('base64url')
  const streams = new Map<string, StreamState>()
  const requests = new Set<AbortController>()
  const tasks = new Set<Promise<unknown>>()
  const captureTasks = new Set<Promise<void>>()
  const deferred = new Set<string>()
  const cancelled = new Map<string, number>()
  const consumedIds = new Set<string>()
  let closed = false
  let generation: BrokerGeneration = { id: 0, controller: new AbortController() }
  let draining: Promise<void> | undefined
  let queuedCaptureBytes = 0
  const assertGeneration = (expected: BrokerGeneration) => {
    if (closed) throw new Error('model-broker-expired: Worker模型通道已释放')
    if (expected !== generation || expected.controller.signal.aborted)
      throw new Error('model-broker-cancelled: 模型请求所属执行代次已结束')
  }
  const notify = (state: StreamState) => {
    for (const wake of state.changed) wake()
    state.changed.clear()
  }
  const actor = async (epoch: BrokerGeneration, scopeKey?: string, capture?: { requestId: string }) => {
    assertGeneration(epoch)
    const current = await options.context(capture)
    assertGeneration(epoch)
    if (!current.scopeKey || (scopeKey !== undefined && current.scopeKey !== scopeKey))
      throw new Error('model-broker-expired: 模型请求的执行轮次已变化')
    return current
  }
  const resolve = async (
    target: ModelBrokerTarget,
    current: ModelBrokerActor,
    kind: 'chat' | 'images' | 'classify',
    epoch: BrokerGeneration,
  ) => {
    if (!target || typeof target.provider !== 'string' || typeof target.id !== 'string')
      throw new Error('model-broker-denied: 模型目标无效')
    const allowed = current.allowedModels ?? (current.model ? [current.model] : [])
    if (!allowed.some((item) => sameModel(item, target))) throw new Error('model-broker-denied: 模型不属于当前执行授权')
    const runtime = await options.runtime()
    assertGeneration(epoch)
    const type = kind === 'images' ? 'image' : kind === 'classify' ? 'classifier' : 'chat'
    const model = runtime
      .getAllModels(target.provider)
      .find((item) => sameModel(item, target) && (item.type ?? 'chat') === type)
    if (!model) throw new Error('model-broker-denied: 模型不在Host配置目录中')
    await actor(epoch, current.scopeKey)
    assertGeneration(epoch)
    return { runtime, model }
  }
  const wait = (state: StreamState, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const done = () => {
        signal.removeEventListener('abort', abort)
        state.changed.delete(done)
        resolve()
      }
      function abort() {
        state.changed.delete(done)
        reject(new Error('model-broker-cancelled: 模型请求已取消'))
      }
      if (signal.aborted) return abort()
      state.changed.add(done)
      signal.addEventListener('abort', abort, { once: true })
    })
  const push = async (state: StreamState, event: AssistantMessageEvent) => {
    const bytes = Buffer.byteLength(JSON.stringify(event))
    if (bytes > maxBytes) throw new Error('model-broker-too-large: 单次模型事件过大')
    while (state.bytes + bytes > maxBytes) await wait(state, state.controller.signal)
    state.controller.signal.throwIfAborted()
    state.events.push(structuredClone(event))
    state.bytes += bytes
    notify(state)
  }
  const track = <T>(promise: Promise<T>) => {
    tasks.add(promise)
    void promise.finally(() => tasks.delete(promise)).catch(() => {})
    return promise
  }
  const beginCancellation = () => {
    if (draining) return draining
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    // Fence first: abort listeners may synchronously re-enter lifecycle operations.
    draining = pending
    const previous = generation
    generation = { id: previous.id + 1, controller: new AbortController() }
    previous.controller.abort()
    for (const state of streams.values()) {
      state.controller.abort()
      notify(state)
    }
    for (const request of requests) request.abort()
    streams.clear()
    // Every admitted dispatcher (including pending context/admission) and provider pump is tracked.
    void Promise.allSettled([...tasks]).then(() => {
      if (draining === pending) draining = undefined
      finish()
    })
    return pending
  }
  const waitForDrain = async (pending: Promise<unknown>) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('model-broker-drain: 模型请求停止结果未知，旧请求仍在结束中')),
            5000,
          )
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  return {
    audience,
    get isDraining(): boolean {
      // The bounded waiter may time out; the actual drain remains live until all old IO settles.
      // Disposal also drains capture IO after inference, so an unknown capture drain must stay fenced.
      return draining !== undefined || (closed && (tasks.size > 0 || captureTasks.size > 0))
    },
    async catalog(): Promise<ModelBrokerCatalog> {
      const runtime = await options.runtime()
      const models = (await runtime.getAllAvailable()).map(sanitizeBrokerModel)
      return {
        audience,
        models,
        auth: Object.fromEntries(
          [...new Set(models.map((model) => model.provider))].map((provider) => [
            provider,
            { oauth: runtime.isUsingOAuth(provider), subscription: runtime.isUsingSubscription(provider) },
          ]),
        ),
      }
    },
    request(input: ModelBrokerRequest, signal: AbortSignal): Promise<ModelBrokerReply> {
      const epoch = generation
      const blocked = Boolean(draining)
      // Return and track this exact Promise, before context/admission callbacks can re-enter cancelAll.
      return track(
        Promise.resolve().then(async (): Promise<ModelBrokerReply> => {
          assertGeneration(epoch)
          if (blocked) throw new Error('model-broker-drain: 上一代模型请求尚未停止，暂不接纳新请求')
          signal = AbortSignal.any([signal, epoch.controller.signal])
          signal.throwIfAborted()
          if (closed || !input || input.audience !== audience)
            throw new Error('model-broker-denied: 私有模型通道身份不匹配')
          if (Buffer.byteLength(JSON.stringify(input)) > 64 * 1024 * 1024)
            throw new Error('model-broker-too-large: 模型输入过大')
          if (input.action === 'cancel') {
            if (!/^[a-f0-9-]{36}$/.test(input.id)) throw new Error('model-broker-denied: 模型请求标识无效')
            for (const [key, until] of cancelled) if (until <= Date.now()) cancelled.delete(key)
            if (cancelled.size >= 1024) throw new Error('model-broker-busy: 取消请求过多')
            cancelled.set(input.id, Date.now() + 60000)
            const state = streams.get(input.id)
            state?.controller.abort()
            if (state) notify(state)
            streams.delete(input.id)
            return { cancelled: true }
          }
          if (input.action === 'next') {
            const state = streams.get(input.id)
            if (!state || state.reading) throw new Error('model-broker-expired: 模型流不存在或已有读取者')
            state.reading = true
            const cancel = () => {
              state.controller.abort()
              notify(state)
            }
            signal.addEventListener('abort', cancel, { once: true })
            try {
              await actor(epoch, state.scopeKey)
              while (!state.events.length && !state.done) await wait(state, signal)
              signal.throwIfAborted()
              state.controller.signal.throwIfAborted()
              await actor(epoch, state.scopeKey)
              assertGeneration(epoch)
              const events = state.events.splice(0, 32)
              state.bytes -= events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0)
              const done = state.done && !state.events.length
              notify(state)
              if (done) streams.delete(input.id)
              return { events, done, error: done ? state.error : undefined }
            } catch (cause) {
              cancel()
              throw cause
            } finally {
              state.reading = false
              signal.removeEventListener('abort', cancel)
            }
          }
          const current = await actor(epoch, undefined, input.action === 'open' ? { requestId: input.id } : undefined)
          assertGeneration(epoch)
          signal.throwIfAborted()
          let ownership: ModelBrokerCaptureOwner | undefined
          try {
            if (current.captureOwner) ownership = structuredClone(current.captureOwner)
          } catch {
            /* An unavailable capture owner must never be inferred later from current selection. */
          }
          if (!/^[a-f0-9-]{36}$/.test(input.id) || consumedIds.has(input.id))
            throw new Error('model-broker-denied: 模型请求标识无效或已兑现')
          if (consumedIds.size >= 65536) throw new Error('model-broker-busy: 当前Worker请求数量已达上限，请重新加载')
          consumedIds.add(input.id)
          const { runtime, model } = await resolve(
            input.model,
            current,
            input.action === 'invoke' ? input.kind : 'chat',
            epoch,
          )
          assertGeneration(epoch)
          signal.throwIfAborted()
          if (input.action === 'cancel-deferred') {
            if (!deferred.has(JSON.stringify(input.handle)))
              throw new Error('model-broker-denied: 延后请求不属于该Worker')
            if (model.type === 'image' || model.type === 'classifier') throw new Error('模型类型不支持延后请求')
            await options.execute({ ...input.model, kind: 'deferred' }, input, signal, async (authorizedSignal) => {
              await actor(epoch, current.scopeKey)
              assertGeneration(epoch)
              const providerSignal = AbortSignal.any([authorizedSignal, signal])
              providerSignal.throwIfAborted()
              await runtime.cancelDeferred(model, input.handle, { signal: providerSignal })
              deferred.delete(JSON.stringify(input.handle))
            })
            return { cancelled: true }
          }
          if (input.action === 'invoke') {
            if (current.maxCost !== undefined && (!Number.isFinite(current.maxCost) || current.maxCost <= 0))
              throw new Error('model-broker-budget: 当前模型费用预算已耗尽')
            const controller = new AbortController()
            requests.add(controller)
            try {
              const result = await track(
                options.execute(
                  { ...input.model, kind: input.kind },
                  input,
                  AbortSignal.any([signal, controller.signal]),
                  async (authorizedSignal) => {
                    await actor(epoch, current.scopeKey)
                    assertGeneration(epoch)
                    const providerSignal = AbortSignal.any([authorizedSignal, signal, controller.signal])
                    providerSignal.throwIfAborted()
                    if (input.kind === 'images' && model.type === 'image')
                      return runtime.generateImages(model, input.context as ImagesContext, { signal: providerSignal })
                    if (input.kind === 'classify' && model.type === 'classifier')
                      return runtime.classify(model, input.context as ClassifierContext, { signal: providerSignal })
                    throw new Error('model-broker-denied: 模型操作类型不匹配')
                  },
                ),
              )
              await actor(epoch, current.scopeKey)
              assertGeneration(epoch)
              if (result.errorMessage) result.errorMessage = '模型服务请求失败或已取消，请检查Host配置与用量'
              if (Buffer.byteLength(JSON.stringify(result)) > 64 * 1024 * 1024)
                throw new Error('model-broker-too-large: 模型结果过大')
              return { result }
            } catch {
              throw new Error('model-broker-request-failed: 模型请求失败、预算耗尽或执行已变化')
            } finally {
              requests.delete(controller)
            }
          }
          if (input.action !== 'open' || model.type === 'image' || model.type === 'classifier')
            throw new Error('model-broker-denied: 模型流操作无效')
          if (!/^[a-f0-9-]{36}$/.test(input.id) || streams.has(input.id))
            throw new Error('model-broker-denied: 模型请求标识无效或已使用')
          if (cancelled.has(input.id)) throw new Error('model-broker-cancelled: 模型请求已取消')
          if (streams.size >= 8) throw new Error('model-broker-busy: 当前Worker模型请求过多')
          if (input.handle && !deferred.has(JSON.stringify(input.handle)))
            throw new Error('model-broker-denied: 延后请求不属于该Worker')
          if (
            current.maxOutputTokens !== undefined &&
            (!Number.isSafeInteger(current.maxOutputTokens) || current.maxOutputTokens <= 0)
          )
            throw new Error('model-broker-budget: 当前输出Token预算已耗尽')
          if (current.maxCost !== undefined && (!Number.isFinite(current.maxCost) || current.maxCost <= 0))
            throw new Error('model-broker-budget: 当前模型费用预算已耗尽')
          const streamOptions = modelBrokerOptions(input.options)
          if (
            streamOptions.maxTokens !== undefined &&
            (!Number.isSafeInteger(streamOptions.maxTokens) || streamOptions.maxTokens <= 0)
          )
            throw new Error('model-broker-denied: 输出Token预算无效')
          const limits = [model.maxTokens, current.maxOutputTokens, streamOptions.maxTokens].filter(
            (value): value is number => value !== undefined && value > 0,
          )
          if (limits.length) streamOptions.maxTokens = Math.min(...limits)
          const state: StreamState = {
            controller: new AbortController(),
            scopeKey: current.scopeKey,
            events: [],
            bytes: 0,
            done: false,
            reading: false,
            changed: new Set(),
            completed: Promise.resolve(),
          }
          const id = input.id
          let payloadRevision = 0
          let captureClosed = false
          const projection = (value: typeof model): ModelBrokerCapture['canonicalModel'] => ({
            provider: value.provider,
            id: value.id,
            api: value.api,
            contextWindow:
              Number.isFinite(value.contextWindow) && value.contextWindow > 0 ? value.contextWindow : undefined,
          })
          let canonicalModel: ModelBrokerCapture['canonicalModel'] = {
            provider: input.model.provider,
            id: input.model.id,
            api: 'unknown',
          }
          try {
            canonicalModel = projection(model)
          } catch {
            /* Optional catalog metadata cannot stop inference. */
          }
          // Capture only scalar Host snapshots. Later actor/selection/ALS changes cannot retarget these events.
          const owner = ownership
            ? Object.freeze({
                ...ownership,
                actor: Object.freeze(ownership.actor),
                session: Object.freeze(ownership.session),
                rootSession: Object.freeze(ownership.rootSession),
                project: ownership.project ? Object.freeze(ownership.project) : undefined,
                model: Object.freeze({ ...canonicalModel }),
              })
            : undefined
          let captureQueue = Promise.resolve()
          let queuedCaptures = 0
          const emitCapture = (phase: ModelBrokerCapture['phase'], fields: Partial<CaptureFields> = {}) => {
            const callback = options.onCapture
            if (!callback || (phase === 'payload' && queuedCaptures >= 64)) return
            try {
              // The ordinal/time/model are fixed now, not when this callback eventually runs.
              const event: ModelBrokerCapture = {
                id,
                time: new Date().toISOString(),
                phase,
                payloadRevision,
                canonicalModel: { ...canonicalModel },
                cacheKnowledge: 'unknown',
                // Untrusted SDK sessionId is display metadata only; ownership always comes from the Host snapshot.
                purpose:
                  owner?.purpose ?? (owner && input.options?.sessionId === owner.nativeSessionId ? 'main' : 'unknown'),
                ...fields,
              }
              let bytes =
                Buffer.byteLength(event.body ?? '') + (event.reply ? Buffer.byteLength(JSON.stringify(event.reply)) : 0)
              if (queuedCaptureBytes + bytes > maxBytes) {
                if (event.body) {
                  event.body = undefined
                  event.bodyState = 'missing'
                }
                if (event.reply) {
                  event.reply = undefined
                  event.replyCut = true
                }
                bytes = 0
              }
              queuedCaptureBytes += bytes
              queuedCaptures++
              // One FIFO per open: a slow archive write cannot let terminal or retry N overtake payload N-1.
              const pending = captureQueue
                .then(() => callback(event, owner))
                .then(
                  () => {},
                  () => {},
                )
                .finally(() => {
                  queuedCaptureBytes -= bytes
                  queuedCaptures--
                })
              captureQueue = pending
              captureTasks.add(pending)
              void pending.finally(() => captureTasks.delete(pending)).catch(() => {})
            } catch {
              /* Serialization and subscribers are never inference failures. */
            }
          }
          // Per-open closure: a shared cached ModelRuntime must not lose concurrent request attribution.
          const onPayload = async (payload: unknown, payloadModel: typeof model) => {
            assertGeneration(epoch)
            state.controller.signal.throwIfAborted()
            try {
              await options.onPayload?.(payload, payloadModel)
            } catch {
              /* Trusted observation is best-effort. */
            }
            assertGeneration(epoch)
            state.controller.signal.throwIfAborted()
            if (captureClosed || !options.onCapture) return
            try {
              canonicalModel = projection(payloadModel)
              payloadRevision++
              emitCapture('payload', contextCaptureBody(payload))
            } catch {
              /* A custom provider payload is not necessarily plain JSON. */
            }
          }
          const finishCapture = (phase: ModelBrokerCapture['phase'], fields?: Partial<CaptureFields>) => {
            if (captureClosed) return
            captureClosed = true
            emitCapture(phase, {
              ...fields,
              ...(phase === 'complete' ? {} : { error: '模型请求失败、已取消或费用确认未完成' }),
            })
          }
          streams.set(id, state)
          const timeout = setTimeout(() => {
            state.controller.abort()
            notify(state)
          }, 10 * 60_000)
          state.completed = track(
            Promise.resolve().then(async () => {
              const terminalState: {
                event?: TerminalEvent
                capture?: Partial<CaptureFields>
                aborted?: boolean
                abortForCleanup?: boolean
              } = {}
              try {
                assertGeneration(epoch)
                signal.throwIfAborted()
                await options.execute(
                  { ...input.model, kind: 'chat' },
                  { ...input, options: streamOptions },
                  AbortSignal.any([state.controller.signal, signal]),
                  async (authorizedSignal) => {
                    await actor(epoch, current.scopeKey)
                    assertGeneration(epoch)
                    const providerSignal = AbortSignal.any([authorizedSignal, signal, state.controller.signal])
                    const abort = () => {
                      state.controller.abort()
                      notify(state)
                    }
                    providerSignal.addEventListener('abort', abort, { once: true })
                    if (providerSignal.aborted) abort()
                    let stream: ReturnType<ModelRuntime['streamSimple']> | undefined
                    try {
                      assertGeneration(epoch)
                      providerSignal.throwIfAborted()
                      stream = input.handle
                        ? runtime.streamDeferred(model, input.handle, { signal: providerSignal })
                        : input.mode === 'api'
                          ? runtime.stream(model, input.context as Context, {
                              ...streamOptions,
                              signal: providerSignal,
                              onPayload,
                            })
                          : runtime.streamSimple(model, input.context as Context, {
                              ...streamOptions,
                              signal: providerSignal,
                              onPayload,
                            })
                      for await (const event of stream) {
                        providerSignal.throwIfAborted()
                        await actor(epoch, current.scopeKey)
                        assertGeneration(epoch)
                        providerSignal.throwIfAborted()
                        if (event.type === 'error')
                          event.error.errorMessage = '模型服务请求失败或已取消；请检查Host模型配置和用量'
                        if (event.type === 'done' || event.type === 'error') {
                          if (terminalState.event) throw new Error('model-broker-provider-duplicate-terminal')
                          terminalState.event = event
                          if (options.onCapture) {
                            try {
                              const message = event.type === 'done' ? event.message : event.error
                              terminalState.aborted = message.stopReason === 'aborted'
                              terminalState.capture = captureReply(event)
                            } catch {
                              terminalState.capture = { replyCut: true }
                            }
                          }
                        }
                        if (event.type === 'done') {
                          if (event.message.deferred) deferred.add(JSON.stringify(event.message.deferred))
                          if (current.maxCost !== undefined && event.message.usage.cost.total > current.maxCost)
                            throw new Error('model-broker-budget: 模型费用超过当前预算')
                        }
                        if (event.type === 'error') throw new Error('model-broker-provider-error')
                        if (event.type !== 'done') await push(state, event)
                      }
                      if (!terminalState.event) throw new Error('model-broker-provider-missing-terminal')
                    } catch (cause) {
                      if (!terminalState.event && !state.controller.signal.aborted) {
                        terminalState.abortForCleanup = true
                        state.controller.abort()
                      }
                      throw cause
                    } finally {
                      try {
                        if (stream) {
                          // Returning the consumer iterator is not provider/fetch termination. Wait for the SDK terminal acknowledgement.
                          // A provider that ignores abort keeps this task live; cancelAll then reports unknown after its deadline.
                          const message = await stream.result()
                          if (options.onCapture && !terminalState.capture) {
                            try {
                              terminalState.capture = captureReply({ type: 'error', reason: 'aborted', error: message })
                              if (!terminalState.abortForCleanup)
                                terminalState.aborted ||= message.stopReason === 'aborted'
                            } catch {
                              /* Best-effort observation never changes provider settlement. */
                            }
                          }
                        }
                      } finally {
                        providerSignal.removeEventListener('abort', abort)
                      }
                    }
                  },
                )
                // execute resolved: provider, fee and audit have settled. Worker delivery is a separate outcome.
                finishCapture(terminalState.aborted ? 'aborted' : 'complete', terminalState.capture)
                await actor(epoch, current.scopeKey)
                assertGeneration(epoch)
                const terminal = terminalState.event
                if (terminal) await push(state, terminal)
              } catch {
                finishCapture(
                  epoch.controller.signal.aborted ||
                    signal.aborted ||
                    terminalState.aborted ||
                    (state.controller.signal.aborted && !terminalState.abortForCleanup)
                    ? 'aborted'
                    : 'failed',
                  terminalState.capture,
                )
                const terminal = terminalState.event
                if (terminal && !state.controller.signal.aborted) {
                  const message = terminal.type === 'done' ? terminal.message : terminal.error
                  message.stopReason = 'error'
                  message.errorMessage = '模型请求结果尚不确定，请检查Host模型连接与用量'
                  await push(state, { type: 'error', reason: 'error', error: message }).catch(() => {})
                }
                // Provider exception text can contain URLs, headers or credentials. It never crosses to the Worker.
                state.error = '模型请求失败、执行已变化或费用预算已耗尽，请检查Host连接与模型配置'
              } finally {
                clearTimeout(timeout)
                state.done = true
                notify(state)
              }
            }),
          )
          return { id }
        }),
      )
    },
    async cancelAll(): Promise<void> {
      // Timeout never releases the fence. It remains until old providers/context actually settle.
      await waitForDrain(beginCancellation())
    },
    async dispose() {
      closed = true
      try {
        await waitForDrain(
          (async () => {
            await beginCancellation()
            await Promise.allSettled([...captureTasks])
          })(),
        )
      } finally {
        streams.clear()
        deferred.clear()
        cancelled.clear()
        consumedIds.clear()
      }
    },
  }
}
