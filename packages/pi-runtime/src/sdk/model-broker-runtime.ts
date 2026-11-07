import { randomUUID } from 'node:crypto'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from '@earendil-works/pi-ai'
import type { PiSdk } from './load'
import {
  modelBrokerOptions,
  type ModelBrokerBatch,
  type ModelBrokerCatalog,
  type ModelBrokerReply,
  type ModelBrokerRequest,
  type ModelBrokerTransport,
} from './model-broker-protocol'

function brokerError(model: Model<Api>, cause: unknown, aborted: boolean): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: aborted ? 'aborted' : 'error',
    errorMessage: cause instanceof Error ? cause.message : 'Host模型通道不可用',
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }
}

/** The Worker has catalog metadata and a private IPC audience, never provider auth or network endpoints. */
export async function createBrokeredModelRuntime(sdk: PiSdk, transport: ModelBrokerTransport) {
  const runtime = await sdk.ModelRuntime.create({
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
    credentials: {
      read: async () => undefined,
      list: async () => [],
      modify: async () => {
        throw new Error('模型凭据只能在Host设置中修改')
      },
      delete: async () => {
        throw new Error('模型凭据只能在Host设置中修改')
      },
    },
  })
  const internals = runtime as unknown as { models?: { authContext?: unknown } }
  if (!internals.models || !('authContext' in internals.models)) throw new Error('当前Pi SDK不支持隔离模型认证上下文')
  internals.models.authContext = { env: async () => undefined, fileExists: async () => false }
  const providers = new Map<string, ModelBrokerCatalog['models']>()
  for (const model of transport.catalog.models) {
    const list = providers.get(model.provider) ?? []
    list.push(model)
    providers.set(model.provider, list)
  }
  for (const [provider, models] of providers) {
    runtime.registerProvider(provider, {
      // This audience only works on the parent Worker port. It is not an HTTP credential.
      apiKey: transport.catalog.audience,
      api: models[0]?.api ?? 'openai-completions',
      baseUrl: 'https://model-broker.invalid',
      streamSimple: (model, context, options) => stream(model, context, options),
      models: models.map((model) => ({
        ...model,
        input: model.input.filter((kind): kind is 'text' | 'image' => kind === 'text' || kind === 'image'),
      })),
    })
  }
  await runtime.refresh({ allowNetwork: false })
  runtime.isUsingOAuth = (provider) => transport.catalog.auth?.[provider]?.oauth ?? false
  runtime.isUsingSubscription = (provider) => transport.catalog.auth?.[provider]?.subscription ?? false
  const request = (input: Omit<ModelBrokerRequest, 'audience'> | ModelBrokerRequest, signal?: AbortSignal) =>
    transport.request({ ...input, audience: transport.catalog.audience } as ModelBrokerRequest, signal)
  function stream(
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
    mode: 'simple' | 'api' = 'simple',
    handle?: Parameters<typeof runtime.streamDeferred>[1],
  ) {
    const output = createAssistantMessageEventStream()
    const id = randomUUID()
    let terminal = false
    let started = false
    let iterating = false
    let resultOnly = false
    const cancel = () => {
      if (started) void request({ action: 'cancel', id } as ModelBrokerRequest).catch(() => {})
    }
    const originalResult = output.result.bind(output)
    const originalIterator = output[Symbol.asyncIterator].bind(output)
    const start = () => {
      if (started) return
      started = true
      options?.signal?.addEventListener('abort', cancel, { once: true })
      void (async () => {
        try {
          options?.signal?.throwIfAborted()
          const opened = await request(
            {
              action: 'open',
              id,
              model: { provider: model.provider, id: model.id },
              context,
              mode,
              options: modelBrokerOptions(options),
              handle,
            } as ModelBrokerRequest,
            options?.signal,
          )
          if (!('id' in opened) || opened.id !== id) throw new Error('Host返回的模型流标识无效')
          if (options?.signal?.aborted) {
            cancel()
            options.signal.throwIfAborted()
          }
          for (;;) {
            const batch = (await request(
              { action: 'next', id } as ModelBrokerRequest,
              options?.signal,
            )) as ModelBrokerBatch
            if (!Array.isArray(batch.events) || typeof batch.done !== 'boolean')
              throw new Error('Host返回的模型流格式无效')
            for (const event of batch.events) {
              if (terminal) throw new Error('Host模型流在结束后继续返回事件')
              if (!resultOnly || iterating || event.type === 'done' || event.type === 'error') output.push(event)
              if (event.type === 'done' || event.type === 'error') terminal = true
            }
            if (batch.done) {
              if (batch.error) throw new Error(batch.error)
              if (!terminal) throw new Error('Host模型流未返回结束消息')
              break
            }
          }
        } catch (cause) {
          cancel()
          if (!terminal) {
            const error = brokerError(model, cause, options?.signal?.aborted === true)
            output.push({ type: 'error', reason: error.stopReason === 'aborted' ? 'aborted' : 'error', error })
          }
        } finally {
          options?.signal?.removeEventListener('abort', cancel)
          output.end()
        }
      })()
    }
    output.result = () => {
      if (!iterating) resultOnly = true
      start()
      return originalResult()
    }
    output[Symbol.asyncIterator] = () => {
      iterating = true
      start()
      const iterator = originalIterator()
      return {
        next: () => iterator.next(),
        return: async () => {
          cancel()
          return { done: true as const, value: undefined }
        },
      }
    }
    return output
  }
  runtime.stream = ((model: Model<Api>, context: Context, options?: unknown) =>
    stream(model, context, options as SimpleStreamOptions | undefined, 'api')) as typeof runtime.stream
  runtime.streamSimple = (model, context, options) => stream(model, context, options)
  runtime.streamDeferred = (model, handle, options) => stream(model, { messages: [] }, options, 'simple', handle)
  runtime.cancelDeferred = async (model, handle, options) => {
    await request(
      {
        action: 'cancel-deferred',
        id: randomUUID(),
        model: { provider: model.provider, id: model.id },
        handle,
      } as ModelBrokerRequest,
      options?.signal,
    )
  }
  runtime.generateImages = async (model, context, options) => {
    const reply = await request(
      {
        action: 'invoke',
        id: randomUUID(),
        kind: 'images',
        model: { provider: model.provider, id: model.id },
        context,
      } as ModelBrokerRequest,
      options?.signal,
    )
    if (!('result' in reply)) throw new Error('Host图像模型返回格式无效')
    return reply.result as Awaited<ReturnType<typeof runtime.generateImages>>
  }
  runtime.classify = async (model, context, options) => {
    const reply = await request(
      {
        action: 'invoke',
        id: randomUUID(),
        kind: 'classify',
        model: { provider: model.provider, id: model.id },
        context,
      } as ModelBrokerRequest,
      options?.signal,
    )
    if (!('result' in reply)) throw new Error('Host分类模型返回格式无效')
    return reply.result as Awaited<ReturnType<typeof runtime.classify>>
  }
  const hostOnly = async (): Promise<never> => {
    throw new Error('模型登录和凭据修改只允许使用Host设置入口')
  }
  runtime.login = hostOnly
  runtime.logout = hostOnly
  runtime.setRuntimeApiKey = hostOnly
  runtime.removeRuntimeApiKey = hostOnly
  return runtime
}

export type { ModelBrokerReply, ModelBrokerRequest, ModelBrokerTransport }
