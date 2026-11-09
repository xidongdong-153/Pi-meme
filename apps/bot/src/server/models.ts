import { createModels, createProvider } from '@earendil-works/pi-ai/models'
import type { Api, Model } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy'
import type { ModelConfig } from '../shared/types.js'
import type { BotStore } from './contracts.js'

export const modelProviderId = (model: ModelConfig) => `bot-${model.id}-${model.revision}`
export const createBotModels = () => createModels()

export function installModel(models: ReturnType<typeof createModels>, config: ModelConfig, store: BotStore) {
  if (config.kind !== 'text') return
  const provider = modelProviderId(config)
  const api =
    config.provider === 'anthropic'
      ? 'anthropic-messages'
      : config.provider === 'google'
        ? 'google-generative-ai'
        : config.provider === 'openai'
          ? 'openai-responses'
          : 'openai-completions'
  const model: Model<Api> = {
    id: config.model,
    name: config.name,
    api,
    provider,
    baseUrl: config.baseUrl,
    reasoning: false,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
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
            const current = store.read().models[config.id]
            if (!current || current.credentialRef !== config.credentialRef)
              throw new Error('模型凭据已撤销或更新，请创建新任务')
            const key = await store.secret(config.credentialRef)
            const latest = store.read().models[config.id]
            if (!latest || latest.credentialRef !== config.credentialRef)
              throw new Error('模型凭据已撤销或更新，请创建新任务')
            return { auth: key ? { apiKey: key } : {} }
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
