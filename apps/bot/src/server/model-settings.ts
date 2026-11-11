import { createHash, randomUUID } from 'node:crypto'
import type {
  AppState,
  Bot,
  ModelConfig,
  ModelProtocol,
  ModelProvider,
  ModelService,
  ModelSettings,
} from '../shared/types.js'
import type { BotStore } from './contracts.js'
import { BotError, ids, requireItem, revision, text, touch } from './errors.js'
import { ensureBotConversation } from './bot-conversations.js'
import { defaultProtocol, localAnonymousModel, modelMetadata } from './model-metadata.js'

const providers: ModelProvider[] = ['openai', 'openai-compatible', 'anthropic', 'google']
const protocols: ModelProtocol[] = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
]
export function modelResource(id: string = randomUUID()) {
  const now = new Date().toISOString()
  return { id, revision: 1, createdAt: now, updatedAt: now }
}

export function effectiveModel(state: AppState, model: ModelConfig): ModelConfig {
  const service = model.serviceId ? state.modelServices[model.serviceId] : undefined
  if (model.serviceId && !service) throw new BotError(409, 'model-unavailable', '模型服务已删除，请重新选择模型')
  const merged = service
    ? {
        ...model,
        provider: service.provider,
        protocol: service.protocol,
        baseUrl: service.baseUrl,
        credentialRef: service.credentialRef,
      }
    : { ...model, protocol: model.protocol ?? defaultProtocol(model.provider) }
  return { ...merged, ...modelMetadata(merged) }
}

export function modelConfigFingerprint(model: ModelConfig): string {
  const current = { ...model, protocol: model.protocol ?? defaultProtocol(model.provider), ...modelMetadata(model) }
  return createHash('sha256')
    .update(
      JSON.stringify({
        serviceId: current.serviceId,
        provider: current.provider,
        protocol: current.protocol,
        baseUrl: current.baseUrl,
        credentialRef: current.credentialRef ?? null,
        kind: current.kind,
        model: current.model,
        contextWindow: current.contextWindow,
        maxTokens: current.maxTokens,
        reasoning: current.reasoning,
      }),
    )
    .digest('hex')
}

export function modelFingerprint(state: AppState, model: ModelConfig): string {
  return modelConfigFingerprint(effectiveModel(state, model))
}

export function modelIsVerified(state: AppState, model: ModelConfig): boolean {
  return model.verification?.status === 'verified' && model.verification.fingerprint === modelFingerprint(state, model)
}

export function resolveBotModel(state: AppState, botOrModelId: Bot | string | null): ModelConfig {
  const modelId =
    typeof botOrModelId === 'object' && botOrModelId !== null
      ? (botOrModelId.modelId ?? state.modelSettings.defaultModelId)
      : (botOrModelId ?? state.modelSettings.defaultModelId)
  if (!modelId) throw new BotError(409, 'model-unavailable', '请先配置并验证默认对话模型')
  const raw = requireItem(state.models[modelId], '对话模型')
  if (raw.kind !== 'text') throw new BotError(409, 'model-unavailable', '请选择支持工具调用的对话模型')
  if (!modelIsVerified(state, raw))
    throw new BotError(409, 'model-unverified', '请先验证模型的工具调用能力', { modelId })
  const config = effectiveModel(state, raw)
  if (!config.credentialRef && !localAnonymousModel(config))
    throw new BotError(409, 'model-unavailable', '模型凭据尚未配置或已撤销', { modelId })
  return config
}

export function modelView(state: AppState, model: ModelConfig): ModelConfig {
  const copy = effectiveModel(state, model)
  copy.hasCredential = !!copy.credentialRef
  delete copy.credentialRef
  if (copy.verification?.fingerprint && copy.verification.fingerprint !== modelFingerprint(state, model))
    copy.verification = { status: 'unverified' }
  return copy
}
export function modelSettingsView(state: AppState): ModelSettings {
  return {
    ...state.modelSettings,
    services: Object.values(state.modelServices).map(({ credentialRef, ...service }) => ({
      ...service,
      hasCredential: !!credentialRef,
    })),
    models: Object.values(state.models).map((model) => modelView(state, model)),
  }
}

function inputObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BotError(400, 'invalid-input', '模型或服务内容须为对象')
  return value as Record<string, unknown>
}
function entries(value: unknown, label: string) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 100)
    throw new BotError(400, 'invalid-input', `${label}列表无效（最多100项）`)
  return value.map(inputObject)
}
function resourceId(value: unknown): string {
  if (value === undefined) return randomUUID()
  const id = text(value, '资源ID', 128)
  if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id))
    throw new BotError(400, 'invalid-input', '新模型或服务ID须为UUID')
  return id
}
function serviceFields(value: Record<string, unknown>, current?: ModelService): ModelService {
  const provider = value.provider ?? current?.provider ?? 'openai-compatible'
  if (!providers.includes(provider as ModelProvider)) throw new BotError(400, 'invalid-input', '模型供应商无效')
  const protocol =
    value.protocol ??
    (value.provider !== undefined && value.provider !== current?.provider
      ? defaultProtocol(provider as ModelProvider)
      : current?.protocol) ??
    defaultProtocol(provider as ModelProvider)
  if (
    !protocols.includes(protocol as ModelProtocol) ||
    (provider === 'anthropic' && protocol !== 'anthropic-messages') ||
    (provider === 'google' && protocol !== 'google-generative-ai') ||
    ((provider === 'openai' || provider === 'openai-compatible') &&
      !['openai-responses', 'openai-completions'].includes(String(protocol)))
  )
    throw new BotError(400, 'invalid-input', '供应商与连接协议不匹配')
  const fallback =
    provider === 'anthropic'
      ? 'https://api.anthropic.com'
      : provider === 'google'
        ? 'https://generativelanguage.googleapis.com'
        : 'https://api.openai.com/v1'
  const baseUrl = text(value.baseUrl ?? current?.baseUrl ?? fallback, '服务地址', 2000).replace(/\/+$/, '')
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    throw new BotError(400, 'invalid-input', '模型服务地址无效')
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  )
    throw new BotError(400, 'invalid-input', '远程模型须使用HTTPS；本机回环可用HTTP，地址不能包含凭据')
  return {
    ...(current ?? modelResource(resourceId(value.id))),
    name: text(value.name ?? current?.name ?? provider, '服务名称', 80),
    provider: provider as ModelProvider,
    protocol: protocol as ModelProtocol,
    baseUrl,
    credentialRef: current?.credentialRef,
  }
}
function boundedInteger(value: unknown, label: string, min: number, max: number) {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max)
    throw new BotError(400, 'invalid-input', `${label}须为${min}–${max}整数`)
  return Number(value)
}
function setModel(state: AppState, value: Record<string, unknown>, old?: ModelConfig) {
  const serviceId = text(value.serviceId ?? old?.serviceId, '模型服务', 128)
  const service = requireItem(state.modelServices[serviceId], '模型服务')
  const kind = value.kind ?? old?.kind ?? 'text'
  if (kind !== 'text' && kind !== 'image') throw new BotError(400, 'invalid-input', '模型类型无效')
  if (kind === 'image' && !['openai', 'openai-compatible'].includes(service.provider))
    throw new BotError(400, 'capability-unavailable', '生图目前仅支持OpenAI或兼容图片API')
  const model: ModelConfig = {
    ...(old ?? modelResource(resourceId(value.id))),
    serviceId,
    name: text(value.name ?? old?.name ?? value.model, '模型名称', 80),
    kind,
    model: text(value.model ?? old?.model, '模型ID', 200),
    provider: service.provider,
    protocol: service.protocol,
    baseUrl: service.baseUrl,
  }
  delete model.credentialRef
  if (value.contextWindow !== undefined)
    model.contextWindow = boundedInteger(value.contextWindow, '上下文长度', 2048, 10_000_000)
  if (value.maxTokens !== undefined) model.maxTokens = boundedInteger(value.maxTokens, '输出上限', 128, 1_000_000)
  if (value.reasoning !== undefined) {
    if (typeof value.reasoning !== 'boolean') throw new BotError(400, 'invalid-input', '推理开关须为布尔值')
    model.reasoning = value.reasoning
  }
  Object.assign(model, modelMetadata(model))
  if (model.maxTokens! >= model.contextWindow!) throw new BotError(400, 'invalid-input', '输出上限须小于上下文长度')
  if (old) touch(model)
  const before = old ? modelFingerprint(state, old) : undefined
  if (before !== modelFingerprint(state, model)) {
    model.verification = { status: 'unverified' }
  }
  state.models[model.id] = model
}
function refs(state: AppState) {
  return new Set(
    [
      ...Object.values(state.modelServices).map((service) => service.credentialRef),
      ...Object.values(state.models).map((model) => model.credentialRef),
      ...Object.values(state.hosts).map((host) => host.credentialRef),
      state.qq.credentialRef,
      ...Object.values(state.tasks)
        .filter((task) => ['queued', 'running', 'waiting', 'stopping'].includes(task.status))
        .map((task) => task.modelConfig?.credentialRef),
    ].filter((ref): ref is string => !!ref),
  )
}

export async function releaseModelCredential(store: BotStore, ref: string | undefined) {
  if (ref && !refs(store.read()).has(ref)) await store.deleteSecret(ref)
}
function activateDefault(state: AppState) {
  if (state.modelSettings.initialized) return
  if (!state.modelSettings.defaultModelId) return
  const model = requireItem(state.models[state.modelSettings.defaultModelId], '默认模型')
  if (!modelIsVerified(state, model)) throw new BotError(409, 'model-unverified', '请先验证默认模型的工具调用能力')
  const existing = Object.values(state.bots).sort(
    (a, b) =>
      Number(b.enabled) - Number(a.enabled) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  )[0]
  if (existing) {
    ensureBotConversation(state, existing.id)
    state.modelSettings.defaultAssistantId = existing.id
    state.modelSettings.initialized = true
    return
  }
  const bot: Bot = {
    ...modelResource(),
    conversationId: randomUUID(),
    name: '默认助理',
    avatar: '',
    description: '',
    instructions: '你是用户的个人助理。通过对话帮用户完成工作并管理 Bot 配置，遇到缺少的信息时提出具体问题。',
    modelId: null,
    enabled: true,
    maxToolCalls: 32,
  }
  state.bots[bot.id] = bot
  ensureBotConversation(state, bot.id)
  state.modelSettings.defaultAssistantId = bot.id
  state.modelSettings.initialized = true
}

export async function patchModelSettings(store: BotStore, input: Record<string, unknown>): Promise<ModelSettings> {
  if (
    Object.keys(input).some(
      (key) =>
        !['revision', 'services', 'models', 'defaultModelId', 'defaultAssistantId', 'removedServiceIds'].includes(key),
    )
  )
    throw new BotError(400, 'invalid-input', '模型设置字段无效')
  const serviceInputs = entries(input.services, '服务')
  const modelInputs = entries(input.models, '模型')
  for (const value of serviceInputs)
    if (
      Object.keys(value).some(
        (key) => !['id', 'revision', 'name', 'provider', 'protocol', 'baseUrl', 'apiKey'].includes(key),
      )
    )
      throw new BotError(400, 'invalid-input', '模型服务字段无效')
  for (const value of modelInputs)
    if (
      Object.keys(value).some(
        (key) =>
          !['id', 'revision', 'serviceId', 'name', 'kind', 'model', 'contextWindow', 'maxTokens', 'reasoning'].includes(
            key,
          ),
      )
    )
      throw new BotError(400, 'invalid-input', '模型字段无效，请通过 services 配置连接')
  const secretWrites = new Map<Record<string, unknown>, string>()
  let committed = false
  let oldRefs: Set<string> = new Set()
  try {
    for (const value of serviceInputs)
      if (value.apiKey !== undefined) {
        const apiKey = text(value.apiKey, 'API key', 8000, true)
        if (apiKey) secretWrites.set(value, await store.writeSecret(apiKey))
      }
    await store.update((state) => {
      revision(state.modelSettings, input.revision)
      oldRefs = refs(state)
      const before = new Map(Object.values(state.models).map((model) => [model.id, modelFingerprint(state, model)]))
      const seenServices = new Set<string>()
      for (const value of serviceInputs) {
        const id = resourceId(value.id)
        if (seenServices.has(id)) throw new BotError(400, 'invalid-input', '服务ID不可重复')
        seenServices.add(id)
        const old = state.modelServices[id]
        if (!old && value.revision !== undefined) throw new BotError(404, 'not-found', '模型服务已不存在')
        if (old && value.revision !== undefined) revision(old, value.revision)
        const service = serviceFields({ ...value, id }, old)
        if (value.apiKey !== undefined) service.credentialRef = secretWrites.get(value)
        if (old) touch(service)
        state.modelServices[id] = service
      }
      const seenModels = new Set<string>()
      for (const value of modelInputs) {
        const id = resourceId(value.id)
        if (seenModels.has(id)) throw new BotError(400, 'invalid-input', '模型ID不可重复')
        seenModels.add(id)
        const old = state.models[id]
        if (!old && value.revision !== undefined) throw new BotError(404, 'not-found', '模型已不存在')
        if (old && value.revision !== undefined) revision(old, value.revision)
        setModel(state, { ...value, id }, old)
      }
      if (Object.keys(state.models).length > 100 || Object.keys(state.modelServices).length > 100)
        throw new BotError(409, 'limit-exceeded', '最多100个模型或服务')
      for (const model of Object.values(state.models)) {
        const service = requireItem(state.modelServices[model.serviceId!], '模型服务')
        model.provider = service.provider
        model.protocol = service.protocol
        model.baseUrl = service.baseUrl
        if (model.kind === 'image' && !['openai', 'openai-compatible'].includes(service.provider))
          throw new BotError(400, 'capability-unavailable', '生图目前仅支持OpenAI或兼容图片API')
        if (before.has(model.id) && before.get(model.id) !== modelFingerprint(state, model)) {
          model.verification = { status: 'unverified' }
          if (!seenModels.has(model.id)) touch(model)
        }
      }
      if (input.removedServiceIds !== undefined)
        for (const id of ids(input.removedServiceIds, '移除服务', 100)) {
          requireItem(state.modelServices[id], '模型服务')
          if (Object.values(state.models).some((model) => model.serviceId === id))
            throw new BotError(409, 'resource-in-use', '请先移除服务中的模型')
          delete state.modelServices[id]
        }
      if (input.defaultModelId !== undefined) {
        if (input.defaultModelId === null) {
          if (state.modelSettings.initialized) throw new BotError(409, 'resource-in-use', '请先指定另一个默认对话模型')
          state.modelSettings.defaultModelId = null
        } else {
          const model = requireItem(state.models[text(input.defaultModelId, '默认模型', 128)], '默认模型')
          if (model.kind !== 'text' || !modelIsVerified(state, model))
            throw new BotError(409, 'model-unverified', '请先验证默认模型的工具调用能力')
          state.modelSettings.defaultModelId = model.id
        }
      }
      activateDefault(state)
      if (input.defaultAssistantId !== undefined) {
        const assistant =
          input.defaultAssistantId === null
            ? undefined
            : requireItem(state.bots[text(input.defaultAssistantId, '默认助理', 128)], '默认助理')
        if (assistant && !assistant.enabled) throw new BotError(400, 'invalid-input', '请选择已启用的默认助理')
        state.modelSettings.defaultAssistantId = assistant?.id ?? null
      }
      state.modelSettings.revision++
    })
    committed = true
    const latest = store.read()
    const keep = refs(latest)
    await Promise.allSettled([...oldRefs].filter((ref) => !keep.has(ref)).map((ref) => store.deleteSecret(ref)))
    return modelSettingsView(latest)
  } catch (cause) {
    if (!committed) await Promise.allSettled([...secretWrites.values()].map((ref) => store.deleteSecret(ref)))
    throw cause
  }
}

export async function deleteModel(store: BotStore, id: string, expected: unknown) {
  const previous = refs(store.read())
  await store.update((state) => {
    const model = requireItem(state.models[id], '模型')
    revision(model, expected)
    if (state.modelSettings.defaultModelId === id) throw new BotError(409, 'resource-in-use', '请先更换默认模型')
    if (Object.values(state.bots).some((bot) => bot.modelId === id))
      throw new BotError(409, 'resource-in-use', '请先为关联Bot更换模型')
    if (
      Object.values(state.tasks).some(
        (task) => task.modelConfig?.id === id && ['queued', 'running', 'waiting', 'stopping'].includes(task.status),
      )
    )
      throw new BotError(409, 'active-tasks', '请等待使用此模型的任务结束后再删除')
    delete state.models[id]
    state.modelSettings.revision++
  })
  const keep = refs(store.read())
  await Promise.allSettled([...previous].filter((ref) => !keep.has(ref)).map((ref) => store.deleteSecret(ref)))
}

export function fallbackDefaultAssistant(state: AppState, removedId: string) {
  if (state.modelSettings.defaultAssistantId !== removedId) return
  const fallback = Object.values(state.bots)
    .filter((bot) => bot.id !== removedId && bot.enabled)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0]
  state.modelSettings.defaultAssistantId = fallback?.id ?? null
  state.modelSettings.revision++
}
