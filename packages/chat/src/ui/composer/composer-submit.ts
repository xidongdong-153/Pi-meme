import type {
  BeforeSendHook,
  ComposerIntent,
  ComposerProcessingFailure,
  ComposerProcessingRecord,
  ComposerRef,
  PreparedComposerInput,
  RegisteredBeforeSendHook,
} from '@pi-meme/plugin-sdk/composer'

export type ProcessingState = {
  status: 'idle' | 'preparing' | 'blocked'
  failure?: ComposerProcessingFailure
  records: readonly ComposerProcessingRecord[]
}
type Attempt = {
  id: string
  ref: ComposerRef
  intent: ComposerIntent
  input: PreparedComposerInput
  hooks: RegisteredBeforeSendHook[]
  index: number
  records: ComposerProcessingRecord[]
  controller: AbortController
  startedAt: number
  invocation: number
  validate: (input: PreparedComposerInput) => void
}
export class ComposerPipeline {
  private state: ProcessingState = { status: 'idle', records: [] }
  private attempt?: Attempt
  private readonly listeners = new Set<() => void>()
  getSnapshot = () => this.state
  getFailureSignal = (attemptId: string): AbortSignal | undefined => {
    const attempt = this.attempt
    return this.state.status === 'blocked' &&
      this.state.failure?.attemptId === attemptId &&
      attempt?.id === attemptId &&
      !attempt.controller.signal.aborted
      ? attempt.controller.signal
      : undefined
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private publish(state: ProcessingState) {
    this.state = state
    for (const listener of this.listeners) listener()
  }
  cancel = (reason = '草稿已变化，尚未发送') => {
    this.attempt?.controller.abort(new Error(reason))
    this.attempt = undefined
    this.publish({ status: 'idle', records: [] })
  }
  prepare = async (input: {
    ref: ComposerRef
    intent: ComposerIntent
    draft: PreparedComposerInput
    hooks: readonly RegisteredBeforeSendHook[]
    signal: AbortSignal
    validate: (input: PreparedComposerInput) => void
  }) => {
    this.cancel()
    const controller = new AbortController()
    const abort = () => controller.abort(input.signal.reason)
    input.signal.addEventListener('abort', abort, { once: true })
    if (input.signal.aborted) abort()
    const attempt: Attempt = {
      id: crypto.randomUUID(),
      ref: input.ref,
      intent: input.intent,
      input: structuredClone(input.draft),
      hooks: [...input.hooks]
        .filter((hook) => (hook.intents ?? ['message']).includes(input.intent))
        .sort(
          (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.pluginId.localeCompare(b.pluginId) || a.id.localeCompare(b.id),
        ),
      index: 0,
      records: [],
      controller,
      startedAt: Date.now(),
      invocation: 0,
      validate: input.validate,
    }
    this.attempt = attempt
    try {
      return await this.run(attempt)
    } finally {
      input.signal.removeEventListener('abort', abort)
    }
  }
  retry = async () => {
    const attempt = this.attempt
    if (!attempt || this.state.status !== 'blocked') return null
    attempt.startedAt = Date.now()
    return this.run(attempt)
  }
  skip = async () => {
    const attempt = this.attempt
    if (!attempt || this.state.status !== 'blocked' || attempt.controller.signal.aborted) return null
    const hook = attempt.hooks[attempt.index]!
    attempt.records.push({
      attemptId: attempt.id,
      pluginId: hook.pluginId,
      generation: hook.generation,
      hookId: hook.id,
      outcome: 'skipped',
      userConfirmedAt: new Date().toISOString(),
    })
    attempt.index++
    attempt.startedAt = Date.now()
    return this.run(attempt)
  }
  private async run(
    attempt: Attempt,
  ): Promise<{ input: PreparedComposerInput; records: readonly ComposerProcessingRecord[] } | null> {
    if (this.attempt !== attempt || attempt.controller.signal.aborted) return null
    this.publish({ status: 'preparing', records: [...attempt.records] })
    while (attempt.index < attempt.hooks.length) {
      const hook = attempt.hooks[attempt.index]!
      const controller = new AbortController()
      const abort = () => controller.abort(attempt.controller.signal.reason)
      attempt.controller.signal.addEventListener('abort', abort, { once: true })
      let timer: ReturnType<typeof setTimeout> | undefined
      let result: Awaited<ReturnType<BeforeSendHook['process']>>
      let failureOutcome: 'error' | 'block' = 'error'
      try {
        const remaining = Math.min(10_000, 30_000 - (Date.now() - attempt.startedAt))
        const aborted = new Promise<never>((_, reject) => {
          controller.signal.addEventListener(
            'abort',
            () => reject(controller.signal.reason ?? new Error('发送前处理已取消')),
            { once: true },
          )
          timer = setTimeout(() => controller.abort(new Error('发送前处理超时')), Math.max(0, remaining))
        })
        result = await Promise.race([
          Promise.resolve().then(() =>
            hook.process({
              attemptId: attempt.id,
              invocationId: `${attempt.id}:${++attempt.invocation}`,
              ref: structuredClone(attempt.ref),
              intent: attempt.intent,
              draft: structuredClone(attempt.input),
              signal: controller.signal,
            }),
          ),
          aborted,
        ])
        if (attempt.controller.signal.aborted || this.attempt !== attempt) return null
        if (!result || !['pass', 'replace', 'block'].includes(result.kind))
          throw new Error('插件返回了无效的发送前处理结果')
        if (result.kind === 'replace') {
          attempt.validate(result.input)
          attempt.input = structuredClone(result.input)
        }
        if (result.kind === 'block') {
          failureOutcome = 'block'
          throw new Error(result.reason || '插件阻止了发送')
        }
        attempt.records.push({
          attemptId: attempt.id,
          pluginId: hook.pluginId,
          generation: hook.generation,
          hookId: hook.id,
          outcome: result.kind,
        })
        attempt.index++
      } catch (cause) {
        if (attempt.controller.signal.aborted || this.attempt !== attempt) return null
        const reason = cause instanceof Error ? cause.message : String(cause)
        attempt.records.push({
          attemptId: attempt.id,
          pluginId: hook.pluginId,
          generation: hook.generation,
          hookId: hook.id,
          outcome: reason.includes('超时') ? 'timeout' : failureOutcome,
          reason: reason.includes('超时')
            ? 'processor-timeout'
            : failureOutcome === 'block'
              ? 'processor-blocked'
              : 'processor-error',
        })
        this.publish({
          status: 'blocked',
          failure: { attemptId: attempt.id, pluginId: hook.pluginId, hookId: hook.id, title: hook.title, reason },
          records: [...attempt.records],
        })
        return null
      } finally {
        if (timer) clearTimeout(timer)
        attempt.controller.signal.removeEventListener('abort', abort)
      }
    }
    if (attempt.controller.signal.aborted || this.attempt !== attempt) return null
    this.publish({ status: 'idle', records: [...attempt.records] })
    return { input: attempt.input, records: [...attempt.records] }
  }
}
