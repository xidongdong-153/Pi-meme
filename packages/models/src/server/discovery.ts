import type { ConfiguredModel, DiscoverModels } from '@pi-meme/contracts/model-config'
import {
  endpoint,
  object,
  stringHeaders,
  validateApi,
  validateThinkingLevelMap,
  type ModelConfigStore,
} from './config-store'

export function resolveCredential(value: string): string {
  if (value.startsWith('!')) throw new Error('此配置使用 !command 凭据，桌面不会执行命令，请填写实际值')
  if (/\$\{?[A-Z_]\w*\}?/i.test(value)) throw new Error('API Key 或请求头不能引用环境变量，请填写实际值')
  if (/[\r\n]/.test(value)) throw new Error('API Key 或请求头不能包含换行')
  return value
}
export async function discoverModels(
  value: unknown,
  store: ModelConfigStore,
  request: typeof fetch = fetch,
  timeoutMs = 15000,
): Promise<ConfiguredModel[]> {
  const input = object(value, '获取模型参数') as unknown as DiscoverModels
  validateApi(input.api)
  const url = endpoint(input.baseUrl)
  if (input.providerId !== undefined && typeof input.providerId !== 'string') throw new Error('服务商 ID 无效')
  if (input.apiKey !== undefined && typeof input.apiKey !== 'string') throw new Error('API Key 无效')
  const stored = await store.credentials(input.providerId)
  const key = resolveCredential(input.apiKey || (input.clearApiKey ? '' : stored.apiKey) || '')
  const supplied = stringHeaders(input.headers)
  const headers = new Headers()
  for (const [name, value] of Object.entries(supplied ?? stored.headers ?? {})) {
    try {
      headers.set(name, resolveCredential(value || stored.headers?.[name] || ''))
    } catch (cause) {
      if (cause instanceof Error && (cause.message.includes('!command') || cause.message.includes('环境变量')))
        throw cause
      throw new Error('请求头名称或值无效，请检查服务商高级配置')
    }
  }
  if (input.api === 'anthropic-messages') {
    if (key) headers.set('x-api-key', key)
    if (!headers.has('anthropic-version')) headers.set('anthropic-version', '2023-06-01')
    url.pathname = `${url.pathname.replace(/\/$/, '').replace(/\/v1$/, '')}/v1/models`
  } else {
    if (key)
      headers.set(
        input.api === 'google-generative-ai' ? 'x-goog-api-key' : 'Authorization',
        input.api === 'google-generative-ai' ? key : `Bearer ${key}`,
      )
    url.pathname = `${url.pathname.replace(/\/$/, '')}/models`
  }
  const signal = AbortSignal.timeout(timeoutMs)
  const models = new Map<string, ConfiguredModel>()
  const cursors = new Set<string>()
  for (let page = 0; page < 20; page++) {
    let response: Response
    try {
      response = await request(url, { headers, redirect: 'error', signal })
    } catch {
      throw new Error(
        signal.aborted
          ? '获取模型列表超时，请重试或手动添加模型'
          : '无法获取模型列表，请检查接口地址、网络和重定向设置',
      )
    }
    if (!response.ok)
      throw new Error(
        response.status === 401 || response.status === 403
          ? '模型列表鉴权失败，请检查 API Key 和请求头'
          : `获取模型列表失败（HTTP ${response.status}），可手动添加模型`,
      )
    let body: Record<string, unknown>
    try {
      body = object(await response.json(), '模型列表响应')
    } catch {
      throw new Error('模型列表响应不是有效 JSON 对象，可手动添加模型')
    }
    const entries = input.api === 'google-generative-ai' ? body.models : body.data
    if (!Array.isArray(entries)) throw new Error('模型列表响应缺少模型数组，可手动添加模型')
    for (const entry of entries) {
      const raw = object(entry, '模型列表条目')
      if (
        input.api === 'google-generative-ai' &&
        (!Array.isArray(raw.supportedGenerationMethods) || !raw.supportedGenerationMethods.includes('generateContent'))
      )
        continue
      const id = input.api === 'google-generative-ai' ? raw.name : raw.id
      if (typeof id !== 'string' || !id.trim()) throw new Error('模型列表包含无效模型 ID')
      const model: ConfiguredModel = { id: input.api === 'google-generative-ai' ? id.replace(/^models\//, '') : id }
      const name = raw.displayName ?? raw.display_name
      if (typeof name === 'string' && name.trim()) model.name = name
      const context = raw.inputTokenLimit ?? raw.max_input_tokens
      const output = raw.outputTokenLimit ?? raw.max_tokens
      if (Number.isSafeInteger(context) && Number(context) > 0) model.contextWindow = Number(context)
      if (Number.isSafeInteger(output) && Number(output) > 0) model.maxTokens = Number(output)
      if (typeof raw.thinking === 'boolean') model.reasoning = raw.thinking
      if (typeof raw.reasoning === 'boolean') model.reasoning = raw.reasoning
      if (raw.thinkingLevelMap !== undefined) model.thinkingLevelMap = validateThinkingLevelMap(raw.thinkingLevelMap)
      if (raw.capabilities && typeof raw.capabilities === 'object') {
        const capabilities = raw.capabilities as Record<string, { supported?: boolean }>
        if (typeof capabilities.thinking?.supported === 'boolean') model.reasoning = capabilities.thinking.supported
        if (typeof capabilities.image_input?.supported === 'boolean')
          model.input = capabilities.image_input.supported ? ['text', 'image'] : ['text']
      }
      if (!models.has(model.id)) models.set(model.id, model)
    }
    const cursor =
      input.api === 'google-generative-ai'
        ? body.nextPageToken
        : input.api === 'anthropic-messages' && body.has_more
          ? body.last_id
          : undefined
    if (cursor === undefined || cursor === null || cursor === '') return [...models.values()]
    if (typeof cursor !== 'string' || cursors.has(cursor)) throw new Error('模型列表分页游标无效，请手动添加模型')
    cursors.add(cursor)
    url.searchParams.set(input.api === 'google-generative-ai' ? 'pageToken' : 'after_id', cursor)
  }
  throw new Error('模型列表超过 20 页，请手动添加模型')
}
