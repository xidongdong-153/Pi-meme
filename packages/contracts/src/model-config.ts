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
