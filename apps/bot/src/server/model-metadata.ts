import { OPENAI_MODELS } from '@earendil-works/pi-ai/providers/openai.models'
import { ANTHROPIC_MODELS } from '@earendil-works/pi-ai/providers/anthropic.models'
import { GOOGLE_MODELS } from '@earendil-works/pi-ai/providers/google.models'
import type { Api, Model } from '@earendil-works/pi-ai'
import type { ModelConfig, ModelProtocol, ModelProvider } from '../shared/types.js'

export function defaultProtocol(provider: ModelProvider): ModelProtocol {
  return provider === 'anthropic'
    ? 'anthropic-messages'
    : provider === 'google'
      ? 'google-generative-ai'
      : provider === 'openai'
        ? 'openai-responses'
        : 'openai-completions'
}

export function catalogModel(config: Pick<ModelConfig, 'provider' | 'model'>): Model<Api> | undefined {
  const catalog =
    config.provider === 'anthropic'
      ? ANTHROPIC_MODELS
      : config.provider === 'google'
        ? GOOGLE_MODELS
        : config.provider === 'openai'
          ? OPENAI_MODELS
          : undefined
  return catalog ? (Object.values(catalog) as Model<Api>[]).find((model) => model.id === config.model) : undefined
}

export function modelMetadata(config: ModelConfig) {
  const known = catalogModel(config)
  return {
    contextWindow: config.contextWindow ?? known?.contextWindow ?? 16384,
    maxTokens: config.maxTokens ?? known?.maxTokens ?? 2048,
    reasoning: config.reasoning ?? known?.reasoning ?? false,
  }
}

export function localAnonymousModel(config: Pick<ModelConfig, 'provider' | 'baseUrl'>) {
  try {
    return (
      config.provider === 'openai-compatible' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(new URL(config.baseUrl).hostname)
    )
  } catch {
    return false
  }
}
