import type {
  AnyModel,
  AssistantMessageEvent,
  Context,
  ImagesContext,
  ClassifierContext,
  DeferredHandle,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai'

export type {
  AnyModel,
  AssistantMessageEvent,
  ClassifierContext,
  Context,
  DeferredHandle,
  ImagesContext,
} from '@earendil-works/pi-ai'

export function sanitizeBrokerModel(model: AnyModel): AnyModel {
  const output: Record<string, unknown> = { baseUrl: 'https://model-broker.invalid' }
  for (const name of [
    'provider',
    'id',
    'name',
    'api',
    'type',
    'input',
    'cost',
    'inputLimits',
    'contextWindow',
    'maxTokens',
    'reasoning',
    'thinkingLevelMap',
    'promptCache',
    'output',
  ]) {
    if (name in model) output[name] = structuredClone((model as unknown as Record<string, unknown>)[name])
  }
  return output as unknown as AnyModel
}

export type ModelBrokerCatalog = {
  audience: string
  models: AnyModel[]
  auth?: Record<string, { oauth: boolean; subscription: boolean }>
}
export type ModelBrokerTarget = { provider: string; id: string }
export type ModelBrokerOperation = ModelBrokerTarget & { kind: 'chat' | 'images' | 'classify' | 'deferred' }
export type ModelBrokerOptions = Pick<
  SimpleStreamOptions,
  | 'maxTokens'
  | 'temperature'
  | 'reasoning'
  | 'thinkingBudgets'
  | 'toolChoice'
  | 'cacheRetention'
  | 'sessionId'
  | 'transport'
>
export type ModelBrokerRequest = { audience: string } & (
  | {
      action: 'open'
      id: string
      model: ModelBrokerTarget
      context: Context
      options?: ModelBrokerOptions
      mode: 'simple' | 'api'
      handle?: DeferredHandle
    }
  | { action: 'next'; id: string }
  | { action: 'cancel'; id: string }
  | {
      action: 'invoke'
      id: string
      model: ModelBrokerTarget
      kind: 'images' | 'classify'
      context: ImagesContext | ClassifierContext
    }
  | { action: 'cancel-deferred'; id: string; model: ModelBrokerTarget; handle: DeferredHandle }
)
export type ModelBrokerBatch = { events: AssistantMessageEvent[]; done: boolean; error?: string }
export type ModelBrokerReply = { id: string } | ModelBrokerBatch | { result: unknown } | { cancelled: true }
export type ModelBrokerTransport = {
  catalog: ModelBrokerCatalog
  request: (request: ModelBrokerRequest, signal?: AbortSignal) => Promise<ModelBrokerReply>
}

/** Only these non-secret request controls cross the private Worker channel. */
export function modelBrokerOptions(options?: SimpleStreamOptions): ModelBrokerOptions {
  if (!options) return {}
  const output: ModelBrokerOptions = {}
  for (const name of [
    'maxTokens',
    'temperature',
    'reasoning',
    'thinkingBudgets',
    'toolChoice',
    'cacheRetention',
    'sessionId',
    'transport',
  ] as const) {
    if (options[name] !== undefined) Object.assign(output, { [name]: structuredClone(options[name]) })
  }
  return output
}
