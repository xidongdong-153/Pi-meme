import { randomUUID } from 'node:crypto'
import { mcpConfigCredentialPrefix } from '@pi-meme/contracts/mcp'
import { savedEndpoint, type SecureCredentialStorage } from '@pi-meme/contracts/secure-storage'
import { object } from '../shared/config'

const metadata = ['enabled', 'exposure', 'toolExposure'] as const
const savedValue = '[已保存]'
const savedCommand = '[已保存命令]'
const savedCwd = '[已保存工作目录]'
const savedArgument = (index: number) => `[已保存参数 ${index + 1}]`
const editable = ['type', 'description', 'timeout', ...metadata] as const
const oauthFields = ['clientId', 'scope', 'clientName', 'callbackPort', 'callbackUrl', 'clientRegistration'] as const

function fields(config: Record<string, unknown>, names: readonly string[]) {
  return Object.fromEntries(names.filter((name) => Object.hasOwn(config, name)).map((name) => [name, config[name]]))
}

export function mcpConfigRef(config: unknown): string | undefined {
  return object(config) && typeof config.credentialRef === 'string' ? config.credentialRef : undefined
}

export function loadGlobalMcpConfig(
  name: string,
  config: Record<string, unknown>,
  credentials: SecureCredentialStorage,
) {
  const ref = mcpConfigRef(config)
  if (ref) {
    const value = ref.startsWith(mcpConfigCredentialPrefix) ? credentials.get(ref) : undefined
    const stored: unknown = value ? JSON.parse(value) : undefined
    if (!object(stored) || stored.name !== name || !object(stored.config)) throw new Error('MCP 连接配置不可用')
    return { ...stored.config, ...fields(config, metadata) }
  }
  const secret = credentials.get(`mcp-oauth-client:${name}`)
  return secret && object(config.oauth) ? { ...config, oauth: { ...config.oauth, clientSecret: secret } } : config
}

export function sealMcpConfig(name: string, config: Record<string, unknown>, credentials: SecureCredentialStorage) {
  const credentialRef = `${mcpConfigCredentialPrefix}${randomUUID()}`
  const connection = { ...config }
  for (const key of metadata) delete connection[key]
  credentials.set(credentialRef, JSON.stringify({ name, config: connection }))
  return { ...fields(config, metadata), credentialRef }
}

function maskedValues(value: unknown) {
  return object(value) ? Object.fromEntries(Object.keys(value).map((key) => [key, savedValue])) : undefined
}

export function editableMcpConfig(config: Record<string, unknown>) {
  return {
    ...fields(config, editable),
    ...(object(config.auth) ? { auth: { provider: config.auth.provider } } : {}),
    ...(typeof config.url === 'string' ? { url: savedEndpoint } : {}),
    ...(typeof config.command === 'string' ? { command: savedCommand } : {}),
    ...(typeof config.cwd === 'string' ? { cwd: savedCwd } : {}),
    ...(object(config.headers) ? { headers: maskedValues(config.headers) } : {}),
    ...(object(config.env) ? { env: maskedValues(config.env) } : {}),
    ...(Array.isArray(config.args) ? { args: config.args.map((_, index) => savedArgument(index)) } : {}),
    ...(object(config.oauth)
      ? {
          oauth: {
            ...fields(config.oauth, oauthFields),
            ...(typeof config.oauth.authServerMetadataUrl === 'string' ? { authServerMetadataUrl: savedEndpoint } : {}),
          },
        }
      : {}),
  }
}

function restoreValue(value: unknown, placeholder: string, previous: unknown) {
  if (value !== placeholder) return value
  if (typeof previous !== 'string') throw new Error('请填写连接配置')
  return previous
}

function restoreValues(value: unknown, previous: unknown) {
  if (!object(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      entry === savedValue && object(previous) && Object.hasOwn(previous, key) ? previous[key] : entry,
    ]),
  )
}

export function restoreMcpConfig(config: Record<string, unknown>, previous: Record<string, unknown> = {}) {
  const next = { ...config }
  next.url = restoreValue(next.url, savedEndpoint, previous.url)
  next.command = restoreValue(next.command, savedCommand, previous.command)
  next.cwd = restoreValue(next.cwd, savedCwd, previous.cwd)
  let reusedArguments = false
  if (Array.isArray(next.args) && Array.isArray(previous.args)) {
    const saved = new Map(previous.args.map((arg, index) => [savedArgument(index), arg]))
    reusedArguments = next.args.some((value) => saved.has(value))
    next.args = next.args.map((value) => saved.get(value) ?? value)
  }
  if (object(next.oauth)) {
    const previousOAuth = object(previous.oauth) ? previous.oauth : {}
    const oauth = { ...next.oauth }
    const metadataUrl = restoreValue(oauth.authServerMetadataUrl, savedEndpoint, previousOAuth.authServerMetadataUrl)
    if (metadataUrl !== undefined) oauth.authServerMetadataUrl = metadataUrl
    next.oauth = oauth
  }
  // Never carry saved credentials over to a different endpoint or process invocation.
  const sameEndpoint = next.url !== undefined && next.url === previous.url
  const sameCommand =
    next.command !== undefined &&
    next.command === previous.command &&
    next.cwd === previous.cwd &&
    JSON.stringify(next.args ?? []) === JSON.stringify(previous.args ?? [])
  if (!sameCommand && reusedArguments) throw new Error('启动配置已变化，请填写该命令所需的参数')
  if (
    (!sameEndpoint && object(next.headers) && Object.values(next.headers).includes(savedValue)) ||
    (!sameCommand && object(next.env) && Object.values(next.env).includes(savedValue))
  )
    throw new Error('连接目标已变化，请替换或移除之前保存的请求头和环境变量')
  next.headers = restoreValues(next.headers, previous.headers)
  next.env = restoreValues(next.env, previous.env)
  if (object(next.oauth) && object(previous.oauth) && previous.oauth.clientSecret && !next.oauth.clientSecret) {
    if (
      !sameEndpoint ||
      next.oauth.authServerMetadataUrl !== previous.oauth.authServerMetadataUrl ||
      next.oauth.clientId !== previous.oauth.clientId
    )
      throw new Error('OAuth 连接已变化，请重新填写 Client Secret')
    next.oauth.clientSecret = previous.oauth.clientSecret
  }
  for (const [key, value] of Object.entries(next)) if (value === undefined) delete next[key]
  delete next.desktopAuthorized
  delete next.credentialRef
  return next
}
