export const modelApis = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
] as const
export type ModelApi = (typeof modelApis)[number]
export type ConfiguredModel = {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
  input?: ('text' | 'image')[]
  headers?: Record<string, string>
  compat?: Record<string, unknown>
  thinkingLevelMap?: Record<string, string | null>
}
export type ConfiguredProvider = {
  id: string
  name: string
  baseUrl: string
  api: string
  hasApiKey: boolean
  headers?: Record<string, string>
  compat?: Record<string, unknown>
  models: ConfiguredModel[]
}
export type ModelConfigSnapshot = { path: string; revision: string; providers: ConfiguredProvider[] }
export type SaveModelProvider = {
  revision: string
  originalId?: string
  provider: Omit<ConfiguredProvider, 'hasApiKey' | 'api'> & { api: ModelApi }
  apiKey?: string
  clearApiKey?: boolean
}
export type DiscoverModels = {
  providerId?: string
  baseUrl: string
  api: ModelApi
  apiKey?: string
  clearApiKey?: boolean
  headers?: Record<string, string>
}
export type ModelConfigResult = { snapshot: ModelConfigSnapshot; reconnectError?: string }
