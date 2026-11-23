import type { PiModel } from './pi'

export type ModelsReadonlyApi = { list: () => Promise<PiModel[]> }

export const modelApis = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
] as const
export type ModelApi = (typeof modelApis)[number]

export function isConfigurableFastModeApi(api: string) {
  return api === 'openai-completions' || api === 'openai-responses'
}

const codexFastModels = new Set([
  'gpt-5.5',
  'gpt-5.6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-6-astra',
  'gpt-6-luna',
  'gpt-6-sol',
  'gpt-6.1-sol',
  'gpt-6.1-terra',
  'gpt-6.2-sol',
  'gpt-6.2-astra',
])
const publicApiFastModels = new Set([
  ...codexFastModels,
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.2',
  'gpt-5.1',
  'gpt-5',
  'gpt-5-mini',
  'gpt-4.1',
  'gpt-4.1-mini',
  'gpt-4o',
  'gpt-4o-mini',
])

export function isOfficialFastModel(api: string, baseUrl: string, id: string) {
  const endpoint = baseUrl.replace(/\/+$/, '')
  if (api === 'openai-codex-responses') return endpoint === 'https://chatgpt.com/backend-api' && codexFastModels.has(id)
  return isConfigurableFastModeApi(api) && endpoint === 'https://api.openai.com/v1' && publicApiFastModels.has(id)
}

export type ConfiguredModel = {
  id: string
  name?: string
  api?: ModelApi
  baseUrl?: string
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
export type BuiltinAuthType = 'api_key' | 'oauth'
export type BuiltinAuthMethod = {
  type: BuiltinAuthType
  name: string
  subscription?: boolean
  interactive: boolean
}
export type BuiltinProviderInfo = {
  id: string
  name: string
  configured: boolean
  authType?: BuiltinAuthType
  subscription?: boolean
  methods: BuiltinAuthMethod[]
}
export type ModelLoginNotice = {
  type: 'info' | 'auth_url' | 'device_code' | 'progress'
  message?: string
  url?: string
  instructions?: string
  links?: { url: string; label?: string }[]
  userCode?: string
  verificationUri?: string
}
export type ModelLoginPrompt = {
  id: string
  type: 'text' | 'secret' | 'select' | 'manual_code'
  message: string
  placeholder?: string
  optional?: boolean
  options?: { id: string; label: string; description?: string }[]
}
export type ModelLoginStatus = 'running' | 'needs_input' | 'done' | 'cancelled' | 'error'
export type ModelLoginState = {
  id: string
  providerId: string
  providerName: string
  authType: BuiltinAuthType
  status: ModelLoginStatus
  notices: ModelLoginNotice[]
  prompt?: ModelLoginPrompt
  error?: string
  reconnectError?: string
}
export type StartBuiltinLogin = { providerId: string; authType: BuiltinAuthType }
export type RespondBuiltinLogin = { id: string; promptId: string; value: string }
export type BuiltinLogoutResult = { providers: BuiltinProviderInfo[]; reconnectError?: string }
