import { randomUUID } from 'node:crypto'
import type { AssistantMessage, Context as ModelContext } from '@earendil-works/pi-ai'
import type { ModelVerification } from '../shared/types.js'
import type { BotStore } from './contracts.js'
import { BotError, requireItem, revision, text, touch } from './errors.js'
import { catalogModel, localAnonymousModel } from './model-metadata.js'
import { effectiveModel, modelFingerprint, modelSettingsView } from './model-settings.js'
import { createBotModels, installModel, modelProviderId } from './models.js'

const checks = new WeakMap<BotStore, Set<string>>()
function checkError(message: AssistantMessage) {
  if (message.stopReason !== 'error' && message.stopReason !== 'aborted') return
  const status = message.errorMessage?.match(/\b(400|401|403|404|408|413|415|422|429|500|502|503|504)\b/)?.[1]
  throw new BotError(
    502,
    'model-check-failed',
    status ? `模型服务拒绝了连接请求（HTTP ${status}）` : '模型连接失败或超时，请检查 URL 与密钥',
  )
}

export async function checkModelSettings(store: BotStore, input: Record<string, unknown>, signal?: AbortSignal) {
  const modelId = text(input.modelId, '模型ID', 128)
  const initial = store.read()
  if (input.revision !== undefined) revision(initial.modelSettings, input.revision)
  const raw = requireItem(initial.models[modelId], '模型')
  if (raw.kind !== 'text') throw new BotError(400, 'invalid-input', '请选择对话模型')
  const running = checks.get(store) ?? new Set<string>()
  checks.set(store, running)
  if (running.has(modelId)) throw new BotError(409, 'model-check-running', '该模型正在连接，请等待当前请求结束')
  running.add(modelId)
  const fingerprint = modelFingerprint(initial, raw)
  const config = effectiveModel(initial, raw)
  const verification: ModelVerification = { status: 'unknown', fingerprint, checkedAt: new Date().toISOString() }
  try {
    try {
      if (!config.credentialRef && !localAnonymousModel(config))
        throw new BotError(400, 'model-check-failed', '请先配置模型服务密钥')
      const models = createBotModels()
      installModel(models, config, store)
      const model = models.getModel(modelProviderId(config), config.model)
      if (!model) throw new BotError(409, 'model-check-failed', '模型连接尚未就绪')
      const nonce = randomUUID()
      const toolName = 'verify_connection'
      const request: ModelContext = {
        systemPrompt:
          'Call verify_connection once with the supplied nonce. After it returns, reply with only its receipt.',
        messages: [{ role: 'user', timestamp: Date.now(), content: `Verify the connection with nonce ${nonce}.` }],
        tools: [
          {
            name: toolName,
            description: 'Verify the model connection locally.',
            parameters: {
              type: 'object',
              properties: { nonce: { type: 'string', const: nonce } },
              required: ['nonce'],
              additionalProperties: false,
            },
          },
        ],
      }
      const options = {
        maxRetries: 0,
        timeoutMs: 45_000,
        signal: AbortSignal.any([AbortSignal.timeout(60_000), ...(signal ? [signal] : [])]),
        maxTokens: Math.min(config.maxTokens ?? 2048, 1024),
      }
      const first = await models.completeSimple(model, request, options)
      checkError(first)
      const calls = first.content.filter((block) => block.type === 'toolCall')
      const call = calls[0]
      if (
        calls.length !== 1 ||
        !call ||
        call.name !== toolName ||
        call.argumentsError ||
        call.arguments.nonce !== nonce
      ) {
        verification.status = first.stopReason === 'length' ? 'unknown' : 'unsupported'
        verification.error = '模型尚未完成工具调用，请选择支持工具调用的对话模型'
      } else {
        const receipt = randomUUID()
        const second = await models.completeSimple(
          model,
          {
            ...request,
            messages: [
              ...request.messages,
              first,
              {
                role: 'toolResult',
                toolCallId: call.id,
                toolName,
                timestamp: Date.now(),
                isError: false,
                content: [{ type: 'text', text: JSON.stringify({ receipt }) }],
              },
            ],
          },
          options,
        )
        checkError(second)
        const received = second.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('')
          .trim()
        if (received === receipt && second.stopReason === 'stop') {
          verification.status = 'verified'
          verification.toolCalls = true
          verification.imageInput = catalogModel(config)?.input.includes('image') ?? raw.verification?.imageInput
        } else {
          verification.status = 'unsupported'
          verification.error = '模型没有完成工具结果往返，请选择支持工具调用的对话模型'
        }
      }
    } catch (cause) {
      verification.status = 'failed'
      verification.error = cause instanceof BotError ? cause.message : '模型连接失败或超时，请检查 URL 与密钥'
    }
    await store.update((state) => {
      if (state.modelSettings.revision !== initial.modelSettings.revision)
        throw new BotError(409, 'revision-conflict', '连接期间模型配置已改变，请读取当前配置后重试', {
          revision: state.modelSettings.revision,
        })
      const current = requireItem(state.models[modelId], '模型')
      if (modelFingerprint(state, current) !== fingerprint)
        throw new BotError(409, 'stale-model-check', '模型连接已改变，本次检查结果已丢弃')
      current.verification = verification
      touch(current)
      state.modelSettings.revision++
    })
    return modelSettingsView(store.read())
  } finally {
    running.delete(modelId)
  }
}
