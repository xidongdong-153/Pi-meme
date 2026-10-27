import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser'
import type { SecureCredentialStorage } from '@pi-meme/contracts/secure-storage'
import { thinkingLevels } from '@pi-meme/contracts/pi'
import {
  modelApis,
  type ConfiguredModel,
  type ModelConfigSnapshot,
  type SaveModelProvider,
} from '@pi-meme/contracts/model-config'
import { loadPiSdk } from '@pi-meme/pi-runtime/sdk/load'
import { createDesktopModelRuntime } from '@pi-meme/pi-runtime/sdk/model-runtime'

type JsonObject = Record<string, unknown>
export function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}必须是 JSON 对象`)
  return value as JsonObject
}
export function endpoint(value: unknown): URL {
  if (typeof value !== 'string') throw new Error('Base URL 必须是 HTTP(S) 地址')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Base URL 必须是完整的 HTTP(S) 地址')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('Base URL 必须是 HTTP(S) 地址，不能包含凭据、查询参数或片段')
  return url
}
export function stringHeaders(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined
  const headers = object(value, '请求头')
  for (const [key, val] of Object.entries(headers)) {
    if (!key.trim() || typeof val !== 'string' || /[\r\n]/.test(key + val))
      throw new Error('请求头必须是字符串键值，不能包含换行')
  }
  return headers as Record<string, string>
}
export function validateApi(value: unknown) {
  if (!modelApis.includes(value as (typeof modelApis)[number])) throw new Error('请选择支持的 API 协议')
}
function validateCompat(value: unknown) {
  if (value === undefined) return
  const compat = object(value, 'compat')
  for (const [key, entry] of Object.entries(compat)) {
    if (/^(?:supports|requires|sendSession|forceAdaptive|allowEmptySignature)/.test(key) && typeof entry !== 'boolean')
      throw new Error(`compat.${key} 必须是布尔值`)
  }
  if (
    compat.maxTokensField !== undefined &&
    !['max_tokens', 'max_completion_tokens'].includes(String(compat.maxTokensField))
  )
    throw new Error('compat.maxTokensField 必须是 max_tokens 或 max_completion_tokens')
}
function secretHeaders(value: unknown) {
  const headers = stringHeaders(value)
  return headers
    ? Object.fromEntries(Object.entries(headers).map(([key, val]) => [key, sensitiveHeader(key) ? '' : val]))
    : undefined
}
function sensitiveHeader(name: string) {
  return /auth|key|token|secret|cookie/i.test(name)
}
function credentialKey(providerId: string) {
  return `model-provider:${providerId}`
}
type ModelSecrets = {
  credential?: { type: 'api_key' | 'oauth'; key?: string; env?: Record<string, string> }
  env?: Record<string, string>
}
function readSecrets(storage: SecureCredentialStorage, providerId: string): ModelSecrets {
  const value = storage.get(credentialKey(providerId))
  if (!value) return { env: {} }
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('模型凭据格式无效')
  return parsed as ModelSecrets
}
function secretVariable(providerId: string, scope: string, header: string) {
  const provider = createHash('sha256').update(providerId).digest('hex').slice(0, 12).toUpperCase()
  const value = createHash('sha256')
    .update(`${scope}\0${header.toLowerCase()}`)
    .digest('hex')
    .slice(0, 20)
    .toUpperCase()
  return `PI_DESKTOP_MODEL_${provider}_${value}`
}
function rejectAmbientCredential(value: string, label: string) {
  if (value.startsWith('!')) throw new Error(`${label}不能使用 !command 凭据`)
  if (/\$\{?[A-Z_]\w*\}?/i.test(value)) throw new Error(`${label}不能引用环境变量，请填写实际值`)
  if (/[\r\n]/.test(value)) throw new Error(`${label}不能包含换行`)
}
function secureHeaders(
  input: unknown,
  existing: unknown,
  providerId: string,
  scope: string,
  env: Record<string, string>,
  previousEnv: Record<string, string>,
): Record<string, string> | undefined {
  if (input === undefined) input = existing
  if (input === undefined) return undefined
  const headers = stringHeaders(input) ?? {}
  const previous = existing === undefined ? {} : (stringHeaders(existing) ?? {})
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    const old = previous[name]
    if (sensitiveHeader(name)) {
      if (value === '' && old?.startsWith('$PI_DESKTOP_MODEL_')) {
        result[name] = old
        const variable = old.slice(1)
        if (previousEnv[variable] !== undefined) env[variable] = previousEnv[variable]!
        continue
      }
      if (value === '') continue
      rejectAmbientCredential(value, '敏感请求头')
      const variable = secretVariable(providerId, scope, name)
      env[variable] = value
      result[name] = `$${variable}`
      continue
    }
    if (value === '' && old !== undefined) result[name] = old
    else {
      rejectAmbientCredential(value, '请求头')
      result[name] = value
    }
  }
  return Object.keys(result).length ? result : undefined
}
export function validateThinkingLevelMap(value: unknown): Record<string, string | null> {
  const map = object(value, '思考等级映射')
  for (const [key, val] of Object.entries(map)) {
    if (
      !(thinkingLevels as readonly string[]).includes(key) ||
      (val !== null && (typeof val !== 'string' || !val.trim()))
    )
      throw new Error('思考等级映射的键必须是 Pi 思考等级，值必须是非空字符串或 null')
  }
  return map as Record<string, string | null>
}
function validateModel(value: unknown): ConfiguredModel {
  const model = object(value, '模型')
  if (typeof model.id !== 'string' || !model.id.trim()) throw new Error('模型 ID 不能为空')
  if (model.name !== undefined && (typeof model.name !== 'string' || !model.name.trim()))
    throw new Error('模型名称不能为空')
  for (const field of ['contextWindow', 'maxTokens']) {
    if (model[field] !== undefined && (!Number.isSafeInteger(model[field]) || Number(model[field]) <= 0))
      throw new Error(`模型 ${model.id} 的 ${field} 必须是正整数`)
  }
  if (model.reasoning !== undefined && typeof model.reasoning !== 'boolean') throw new Error('思考支持必须是布尔值')
  if (
    model.input !== undefined &&
    (!Array.isArray(model.input) ||
      !model.input.includes('text') ||
      model.input.some((v) => v !== 'text' && v !== 'image'))
  )
    throw new Error('模型输入必须包含 text，可选 image')
  stringHeaders(model.headers)
  validateCompat(model.compat)
  if (model.thinkingLevelMap !== undefined) {
    const map = validateThinkingLevelMap(model.thinkingLevelMap)
    if (
      model.reasoning &&
      !thinkingLevels.some(
        (level) => map[level] !== null && ((level !== 'xhigh' && level !== 'max') || map[level] !== undefined),
      )
    )
      throw new Error('支持思考的模型必须至少保留一个思考档位')
  }
  return model as ConfiguredModel
}
const editableFields = [
  'id',
  'name',
  'contextWindow',
  'maxTokens',
  'reasoning',
  'input',
  'headers',
  'compat',
  'thinkingLevelMap',
] as const
function stripPlaintextSecrets(data: JsonObject) {
  for (const raw of Object.values(object(data.providers, 'providers'))) {
    const provider = object(raw, '服务商')
    delete provider.apiKey
    const stripHeaders = (value: unknown) => {
      const headers = value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : undefined
      if (!headers) return
      for (const [name, value] of Object.entries(headers))
        if (sensitiveHeader(name) && typeof value === 'string' && !value.startsWith('$PI_DESKTOP_MODEL_'))
          headers[name] = ''
    }
    stripHeaders(provider.headers)
    if (Array.isArray(provider.models))
      for (const model of provider.models)
        if (model && typeof model === 'object') stripHeaders((model as JsonObject).headers)
  }
}
export class ModelConfigStore {
  private writing = false
  constructor(
    readonly filePath: string,
    private readonly credentialsStore: SecureCredentialStorage,
    readonly agentDir = path.dirname(filePath),
  ) {}
  get credentialStorage() {
    return this.credentialsStore
  }
  private async read() {
    let content = ''
    try {
      content = await readFile(this.filePath, 'utf8')
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('无法读取 Pi 模型配置文件，请检查文件权限')
    }
    const revision = createHash('sha256').update(content).digest('hex')
    const errors: ParseError[] = []
    const data = content
      ? object(parse(content.replace(/^\uFEFF/, ''), errors, { allowTrailingComma: true }), '模型配置')
      : { providers: {} }
    if (errors.length)
      throw new Error(
        `模型配置 JSON 无效：${printParseErrorCode(errors[0].error)}，位置 ${errors[0].offset}。请修正文件后刷新`,
      )
    object(data.providers, 'providers')
    return { data, revision }
  }
  async snapshot(): Promise<ModelConfigSnapshot> {
    const { data, revision } = await this.read()
    const providers = await Promise.all(
      Object.entries(object(data.providers, 'providers')).map(async ([id, raw]) => {
        const provider = object(raw, `服务商 ${id}`)
        if (provider.models !== undefined && !Array.isArray(provider.models))
          throw new Error(`服务商 ${id} 的 models 必须是数组`)
        const secrets = readSecrets(this.credentialsStore, id)
        return {
          id,
          name: typeof provider.name === 'string' ? provider.name : id,
          api: typeof provider.api === 'string' ? provider.api : '',
          baseUrl: typeof provider.baseUrl === 'string' ? provider.baseUrl : '',
          hasApiKey: Boolean(secrets.credential?.type === 'api_key' && secrets.credential.key),
          headers: secretHeaders(provider.headers),
          compat: provider.compat as Record<string, unknown> | undefined,
          models: ((provider.models ?? []) as unknown[]).map((rawModel) => {
            const model = validateModel(rawModel)
            const clean = Object.fromEntries(
              editableFields.filter((key) => model[key] !== undefined).map((key) => [key, model[key]]),
            ) as ConfiguredModel
            clean.headers = secretHeaders(model.headers)
            return clean
          }),
        }
      }),
    )
    return {
      path: this.filePath,
      revision,
      providers,
    }
  }
  async credentials(id?: string) {
    const { data } = await this.read()
    const raw = id ? object(data.providers, 'providers')[id] : undefined
    const provider = raw ? object(raw, '服务商') : {}
    const secrets = id ? readSecrets(this.credentialsStore, id) : { env: {} }
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(stringHeaders(provider.headers) ?? {})) {
      if (sensitiveHeader(name)) {
        const match = /^\$(PI_DESKTOP_MODEL_[A-Z0-9_]+)$/.exec(value)
        if (match && secrets.env?.[match[1]]) headers[name] = secrets.env[match[1]]!
      } else headers[name] = value
    }
    return {
      apiKey: secrets.credential?.type === 'api_key' ? secrets.credential.key : undefined,
      headers,
    }
  }
  async save(value: unknown) {
    const input = object(value, '保存参数') as unknown as SaveModelProvider
    const provider = object(input.provider, '服务商')
    if (
      typeof provider.id !== 'string' ||
      !/^[a-z0-9][\w.-]*$/i.test(provider.id) ||
      ['__proto__', 'constructor', 'prototype'].includes(provider.id)
    )
      throw new Error('服务商 ID 只能包含字母、数字、点、下划线和连字符')
    if (typeof provider.name !== 'string' || !provider.name.trim()) throw new Error('服务商名称不能为空')
    endpoint(provider.baseUrl)
    validateApi(provider.api)
    stringHeaders(provider.headers)
    validateCompat(provider.compat)
    if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || !input.apiKey.trim()))
      throw new Error('API Key 不能为空；清除请使用清除操作')
    if (input.apiKey !== undefined) rejectAmbientCredential(input.apiKey, 'API Key')
    if (input.clearApiKey !== undefined && typeof input.clearApiKey !== 'boolean')
      throw new Error('清除 API Key 参数无效')
    if (!Array.isArray(provider.models) || !provider.models.length) throw new Error('请至少添加一个模型')
    const models = provider.models.map(validateModel)
    if (new Set(models.map((m) => m.id)).size !== models.length) throw new Error('模型 ID 不能重复')
    let nextSecrets: ModelSecrets | undefined
    let previousSecrets: string | undefined
    return this.mutate(
      input.revision,
      async (data) => {
        const providers = object(data.providers, 'providers')
        if (
          input.originalId !== undefined &&
          (typeof input.originalId !== 'string' || input.originalId !== provider.id)
        )
          throw new Error('编辑时不能更改服务商 ID')
        if (input.originalId && !Object.hasOwn(providers, input.originalId)) throw new Error('服务商已删除，请刷新')
        if (!input.originalId && Object.hasOwn(providers, provider.id as string)) throw new Error('服务商 ID 已存在')
        const old = Object.hasOwn(providers, provider.id as string)
          ? object(providers[provider.id as string], '服务商')
          : {}
        previousSecrets = this.credentialsStore.get(credentialKey(provider.id as string))
        const secrets = readSecrets(this.credentialsStore, provider.id as string)
        const env = { ...(secrets.env ?? {}) }
        const previousEnv = { ...env }
        const providerPrefix = `PI_DESKTOP_MODEL_${createHash('sha256')
          .update(provider.id as string)
          .digest('hex')
          .slice(0, 12)
          .toUpperCase()}_`
        for (const name of Object.keys(env)) if (name.startsWith(providerPrefix)) delete env[name]
        const next: JsonObject = { ...old, name: provider.name, api: provider.api, baseUrl: provider.baseUrl }
        next.headers = secureHeaders(provider.headers, old.headers, provider.id as string, 'provider', env, previousEnv)
        next.compat = provider.compat
        delete next.apiKey
        if (input.clearApiKey) {
          if (secrets.credential?.type === 'api_key') delete secrets.credential
        } else if (input.apiKey !== undefined) {
          secrets.credential = { type: 'api_key', key: input.apiKey }
        }
        const oldModels = Array.isArray(old.models) ? (old.models as JsonObject[]) : []
        next.models = models.map((model) => {
          const existing = oldModels.find((m) => m.id === model.id)
          const merged = { ...existing }
          for (const field of editableFields) {
            if (model[field] === undefined) delete merged[field]
            else
              merged[field] =
                field === 'headers'
                  ? secureHeaders(
                      model.headers,
                      existing?.headers,
                      provider.id as string,
                      `model:${model.id}`,
                      env,
                      previousEnv,
                    )
                  : model[field]
          }
          return merged
        })
        const referenced = new Set<string>()
        const collect = (value: unknown) => {
          for (const entry of Object.values(stringHeaders(value) ?? {})) {
            const match = /^\$(PI_DESKTOP_MODEL_[A-Z0-9_]+)$/.exec(entry)
            if (match) referenced.add(match[1]!)
          }
        }
        collect(next.headers)
        for (const model of next.models as JsonObject[]) collect(model.headers)
        for (const name of Object.keys(env))
          if (name.startsWith(providerPrefix) && !referenced.has(name)) delete env[name]
        secrets.env = env
        nextSecrets = secrets
        Object.defineProperty(providers, provider.id as string, {
          value: next,
          enumerable: true,
          configurable: true,
          writable: true,
        })
      },
      async () => {
        const secrets = nextSecrets
        const id = provider.id as string
        try {
          if (secrets && (secrets.credential || Object.keys(secrets.env ?? {}).length))
            this.credentialsStore.set(credentialKey(id), JSON.stringify(secrets))
          else this.credentialsStore.delete(credentialKey(id))
        } catch (cause) {
          if (previousSecrets === undefined) this.credentialsStore.delete(credentialKey(id))
          else this.credentialsStore.set(credentialKey(id), previousSecrets)
          throw cause
        }
      },
    )
  }
  async delete(id: unknown, revision: unknown) {
    if (typeof id !== 'string') throw new Error('服务商 ID 无效')
    return this.mutate(revision, async (data) => {
      const providers = object(data.providers, 'providers')
      if (!Object.hasOwn(providers, id)) throw new Error('服务商已删除，请刷新')
      delete providers[id]
      const previous = this.credentialsStore.get(credentialKey(id))
      return async () => {
        try {
          this.credentialsStore.delete(credentialKey(id))
        } catch (cause) {
          if (previous !== undefined) this.credentialsStore.set(credentialKey(id), previous)
          throw cause
        }
      }
    })
  }
  private async mutate(
    revision: unknown,
    edit: (data: JsonObject) => Promise<(() => Promise<void> | void) | void>,
    beforeCommit?: () => Promise<void> | void,
  ) {
    if (this.writing) throw new Error('模型配置正在保存，请稍后重试')
    this.writing = true
    const temporary = `${this.filePath}.${randomUUID()}.tmp`
    try {
      const current = await this.read()
      if (typeof revision !== 'string' || revision !== current.revision)
        throw new Error('模型配置已被其他程序修改，请刷新后重新编辑')
      const commit = await edit(current.data)
      stripPlaintextSecrets(current.data)
      await mkdir(path.dirname(this.filePath), { recursive: true })
      await writeFile(temporary, `${JSON.stringify(current.data, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
      const sdk = await loadPiSdk()
      const runtime = await createDesktopModelRuntime(sdk, this.agentDir, this.credentialsStore, temporary)
      if (runtime.getError()) throw new Error('Pi 无法加载此模型配置，请检查协议和高级参数')
      if ((await this.read()).revision !== revision) throw new Error('模型配置已被其他程序修改，请刷新后重新编辑')
      await beforeCommit?.()
      await commit?.()
      await rename(temporary, this.filePath)
      return await this.snapshot()
    } finally {
      await rm(temporary, { force: true })
      this.writing = false
    }
  }
}
