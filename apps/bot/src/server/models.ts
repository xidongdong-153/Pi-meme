import { createModels, createProvider } from '@earendil-works/pi-ai/models'
import type { Api, Model } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy'
import type { ModelConfig } from '../shared/types.js'
import type { BotStore } from './contracts.js'
import { effectiveModel, modelConfigFingerprint, modelFingerprint } from './model-settings.js'
import { catalogModel, localAnonymousModel, modelMetadata } from './model-metadata.js'

export const modelProviderId = (model: ModelConfig) => `bot-${model.id}-${model.revision}`
export const createBotModels = () => createModels()

export function installModel(models: ReturnType<typeof createModels>, config: ModelConfig, store: BotStore) {
  if (config.kind !== 'text') return
  const provider = modelProviderId(config)
  const known = catalogModel(config)
  const fingerprint = modelConfigFingerprint(config)
  const model: Model<Api> = {
    ...known,
    id: config.model,
    name: config.name,
    api:
      config.protocol ??
      (config.provider === 'anthropic'
        ? 'anthropic-messages'
        : config.provider === 'google'
          ? 'google-generative-ai'
          : config.provider === 'openai'
            ? 'openai-responses'
            : 'openai-completions'),
    provider,
    baseUrl: config.baseUrl,
    ...modelMetadata(config),
    input: known?.input ?? ['text', 'image'],
    cost: known?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
  models.setProvider(
    createProvider({
      id: provider,
      name: config.name,
      baseUrl: config.baseUrl,
      models: [model],
      auth: {
        apiKey: {
          name: config.name,
          resolve: async () => {
            const assertCurrent = () => {
              const state = store.read()
              const current = state.models[config.id]
              if (!current) throw new Error('模型已删除，请选择其他模型')
              const latest = effectiveModel(state, current)
              if (!latest.credentialRef && !localAnonymousModel(latest)) throw new Error('模型密钥已撤销')
              if (modelFingerprint(state, current) === fingerprint) return latest
              const inUse = Object.values(state.tasks).some(
                (task) =>
                  ['queued', 'running', 'waiting'].includes(task.status) &&
                  !task.stopRequested &&
                  task.modelConfig &&
                  modelConfigFingerprint(task.modelConfig) === fingerprint,
              )
              if (!inUse) throw new Error('模型配置已更新，请创建新任务')
              return config
            }
            const current = assertCurrent()
            const key = await store.secret(current.credentialRef)
            assertCurrent()
            if (!key && !localAnonymousModel(current)) throw new Error('模型凭据已撤销或不存在')
            return { auth: { apiKey: key ?? 'local-anonymous' } }
          },
        },
      },
      api: {
        'openai-completions': openAICompletionsApi(),
        'openai-responses': openAIResponsesApi(),
        'anthropic-messages': anthropicMessagesApi(),
        'google-generative-ai': googleGenerativeAIApi(),
      },
    }),
  )
}
