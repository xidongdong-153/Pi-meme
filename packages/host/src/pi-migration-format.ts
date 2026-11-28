import { createHash } from 'node:crypto'
import { colorToHex, indexedColor, parseColor } from '@earendil-works/pi-tui/dist/colors.js'
import {
  isAllowedKeybinding,
  isReservedKeybinding,
  normalizeKeybinding,
  type ShortcutId,
  type ShortcutPlatform,
} from '@pi-meme/contracts/keyboard-shortcuts'
import { thinkingLevels } from '@pi-meme/contracts/pi'
import type { ThemeColors } from '@pi-meme/contracts/settings'
import { endpoint, legacyLiteral, modelHeaderEntries, stringHeaders } from '@pi-meme/models/server/config-store'
import { parseTheme } from '@pi-meme/settings/shared/themes'
import { record, type JsonRecord } from './pi-migration-files'

export function migrationId(value: string) {
  return /^[a-z0-9][\w.-]{0,127}$/i.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value)
}

const providerFields = ['name', 'baseUrl', 'api', 'oauth', 'authHeader', 'compat'] as const
const modelFields = [
  'id',
  'name',
  'api',
  'baseUrl',
  'reasoning',
  'thinkingLevelMap',
  'input',
  'inputLimits',
  'cost',
  'promptCache',
  'contextWindow',
  'maxTokens',
  'samplingParams',
  'samplingParamsByThinkingLevel',
  'compat',
] as const

function pick(value: JsonRecord, keys: readonly string[]) {
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]))
}

function requiredRecord(value: unknown, label: string) {
  const parsed = record(value)
  if (!parsed) throw new Error(`${label}必须是对象`)
  return parsed
}

export function splitPiProvider(value: JsonRecord) {
  const config = pick(value, providerFields)
  if (value.models !== undefined) {
    if (!Array.isArray(value.models)) throw new Error('服务商的 models 必须是列表')
    config.models = value.models.map((model) => pick(requiredRecord(model, '模型'), modelFields))
  }
  if (value.modelOverrides !== undefined) {
    const overrides = requiredRecord(value.modelOverrides, '模型覆盖项')
    config.modelOverrides = Object.fromEntries(
      Object.entries(overrides).map(([id, model]) => [id, pick(requiredRecord(model, '模型覆盖项'), modelFields)]),
    )
  }
  for (const [, item] of modelHeaderEntries(config)) if (item.baseUrl !== undefined) endpoint(item.baseUrl)
  return config
}

export function literalSecret(value: unknown) {
  const literal = legacyLiteral(value)
  return literal?.trim() && !/[\r\n]/.test(literal) ? literal : undefined
}

export function piModelHeaders(value: JsonRecord): {
  values: Array<[string, Record<string, string>]>
  omitted: boolean
} {
  let omitted = false
  const values: Array<[string, Record<string, string>]> = []
  for (const [scope, item] of modelHeaderEntries(value)) {
    const headers = Object.entries(stringHeaders(item.headers) ?? {}).flatMap(([name, raw]) => {
      const literal = literalSecret(raw)
      if (literal === undefined) omitted = true
      return literal === undefined ? [] : [[name, literal]]
    })
    if (headers.length) values.push([scope, Object.fromEntries(headers)])
  }
  return { values, omitted }
}

const mcpFields = ['type', 'command', 'cwd', 'url', 'description', 'enabled', 'timeout', 'exposure', 'toolExposure']
const mcpPrivateFields = ['headers', 'env', 'auth']
const sensitiveArgFlag =
  /^(?:-k|--?(?:api[-_]?key|access[-_]?token|auth[-_]?token|refresh[-_]?token|auth|authorization|bearer|client[-_]?secret|key|passwd|password|secret|token))$/i
const sensitiveArgInline =
  /^(?:-k|(?:-{1,2}|[\w-]*[-_])?(?:api[-_]?key|access[-_]?token|auth[-_]?token|refresh[-_]?token|auth|authorization|bearer|client[-_]?secret|key|passwd|password|secret|token))=/i
const sensitiveArgValue =
  /(?:^|=)(?:sk-[\w-]{12,}|pk-[\w-]{12,}|gh[pousr]_\w{12,}|github_pat_\w{12,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[\w-]{20,}|AKIA[0-9A-Z]{16})|:\/\/[^/\s:@]+:[^/\s@]+@/

function argsLookSensitive(args: unknown) {
  if (!Array.isArray(args)) return true
  let previousWasFlag = false
  for (const item of args) {
    if (typeof item !== 'string') return true
    const trimmed = item.trim()
    if (previousWasFlag && trimmed && !trimmed.startsWith('-')) return true
    if (sensitiveArgInline.test(trimmed) || sensitiveArgValue.test(trimmed)) return true
    previousWasFlag = sensitiveArgFlag.test(trimmed)
  }
  return false
}

export function splitPiMcp(value: JsonRecord) {
  const config = pick(value, mcpFields)
  const credentials = pick(value, mcpPrivateFields)
  if (Object.hasOwn(value, 'args')) {
    if (Array.isArray(value.args) && !value.args.length) {
      // Omit empty args so equivalent stdio configs compare cleanly.
    } else if (argsLookSensitive(value.args)) {
      credentials.args = value.args
    } else {
      config.args = value.args
    }
  }
  if (config.enabled === undefined) config.enabled = true
  if (typeof config.url === 'string') {
    const url = new URL(config.url)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error('MCP 地址必须为不含用户名和密码的 HTTP(S) 地址')
    if (url.search || url.hash) {
      credentials.url = config.url
      url.search = ''
      url.hash = ''
      config.url = url.href
    }
  }
  if (value.oauth !== undefined) {
    const oauth = requiredRecord(value.oauth, 'OAuth 配置')
    const metadata = pick(oauth, [
      'clientId',
      'scope',
      'clientName',
      'callbackUrl',
      'callbackPort',
      'clientRegistration',
    ])
    const privateOptions = pick(oauth, ['clientSecret', 'authServerMetadataUrl'])
    if (Object.keys(metadata).length) config.oauth = metadata
    if (Object.keys(privateOptions).length) credentials.oauth = privateOptions
  }
  config.type ??= typeof config.url === 'string' ? 'http' : 'stdio'
  if (config.type === 'streamable-http') config.type = 'http'
  for (const key of ['headers', 'env']) {
    const fields = record(credentials[key])
    if (fields && !Object.keys(fields).length) delete credentials[key]
  }
  return { config, credentials }
}

export function mergePiMcp(config: JsonRecord, credentials: JsonRecord) {
  const oauth = { ...record(config.oauth), ...record(credentials.oauth) }
  return { ...config, ...credentials, ...(Object.keys(oauth).length ? { oauth } : {}) }
}

export function piMcpLocation(config: JsonRecord) {
  return [config.type, config.url ?? [config.command, config.cwd, config.args], config.oauth]
}

const keyActions = new Map<string, [ShortcutId, string]>([
  ['app.session.new', ['newChat', '新建聊天']],
  ['newSession', ['newChat', '新建聊天']],
  ['app.session.resume', ['searchSessions', '搜索会话']],
  ['resume', ['searchSessions', '搜索会话']],
  ['app.model.select', ['openModelPicker', '选择模型']],
  ['selectModel', ['openModelPicker', '选择模型']],
])

export function piShortcut(action: string, value: unknown, platform: ShortcutPlatform) {
  const target = keyActions.get(action)
  if (!target) return undefined
  if (Array.isArray(value) && !value.length) return { target, binding: null }
  const inputs = Array.isArray(value) ? value : [value]
  const named: Record<string, string> = {
    esc: 'Escape',
    up: 'ArrowUp',
    down: 'ArrowDown',
    left: 'ArrowLeft',
    right: 'ArrowRight',
  }
  for (const key of inputs) {
    if (typeof key !== 'string') continue
    const parts = key.toLowerCase().split('+')
    const last = parts[parts.length - 1]
    parts[parts.length - 1] = named[last] ?? last
    if (platform !== 'darwin')
      for (const [index, part] of parts.entries()) {
        if (part === 'ctrl') parts[index] = 'Mod'
        else if (['meta', 'cmd', 'command', 'super'].includes(part)) parts[index] = 'Ctrl'
      }
    const binding = normalizeKeybinding(parts.join('+'))
    if (binding && isAllowedKeybinding(binding) && !isReservedKeybinding(binding, platform)) return { target, binding }
  }
  return { target, error: '没有可用于 Pi meme 的按键组合' }
}

const settingLabels = {
  defaultThinkingLevel: '默认思考强度',
  modelThinkingLevels: '各模型默认思考强度',
  steeringMode: '插话发送方式',
  followUpMode: '跟进消息发送方式',
  transport: '模型传输方式',
} as const

type SettingKey = keyof typeof settingLabels

export function* piRuntimePreferences(source: JsonRecord) {
  if (source.defaultProvider !== undefined || source.defaultModel !== undefined) {
    const pair = { defaultProvider: source.defaultProvider, defaultModel: source.defaultModel }
    yield {
      id: 'defaultModel',
      name: '默认模型',
      patch: pair,
      error: Object.values(pair).every((value) => typeof value === 'string' && value.trim())
        ? undefined
        : '默认模型需要同时指定服务商和模型',
    }
  }
  for (const [key, name] of Object.entries(settingLabels) as Array<[SettingKey, string]>) {
    if (!Object.hasOwn(source, key)) continue
    const value = source[key]
    const isThinking = (entry: unknown) => (thinkingLevels as readonly unknown[]).includes(entry)
    const valid =
      key === 'defaultThinkingLevel'
        ? isThinking(value)
        : key === 'modelThinkingLevels'
          ? Boolean(
              record(value) &&
              Object.entries(record(value)!).every(([id, level]) => id.includes('/') && isThinking(level)),
            )
          : key === 'transport'
            ? ['auto', 'sse', 'websocket', 'websocket-cached'].includes(String(value))
            : ['all', 'one-at-a-time'].includes(String(value))
    yield { id: key, name, patch: { [key]: value }, error: valid ? undefined : '该项的值不受支持' }
  }
}

function piColor(value: unknown, variables: JsonRecord) {
  const visited = new Set<string>()
  let current = value
  while (typeof current === 'string' && Object.hasOwn(variables, current)) {
    if (visited.has(current)) throw new Error('主题颜色变量循环引用')
    visited.add(current)
    current = variables[current]
  }
  if (current === undefined || current === '') return undefined
  if (typeof current === 'number' && Number.isInteger(current) && current >= 0 && current <= 255)
    return colorToHex(indexedColor(current))
  if (typeof current === 'string') return colorToHex(parseColor(current))
  throw new Error('主题颜色格式不受支持')
}

export function convertPiTheme(filename: string, source: JsonRecord) {
  if (typeof source.name !== 'string' || !source.name.trim()) throw new Error('主题名称不能为空')
  const name = pathName(filename)
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  const suffix =
    slug === name && slug.length <= 70
      ? slug
      : `${slug.slice(0, 50)}-${createHash('sha256').update(name).digest('hex').slice(0, 10)}`
  const id = `pi-${suffix}`
  const parts = requiredRecord(source.colors, '主题 colors')
  const vars = record(source.vars) ?? {}
  const exported = record(source.export) ?? {}
  const color = (value: unknown) => piColor(value, vars)
  const colors: Partial<ThemeColors> = {
    background: color(exported.pageBg),
    surface: color(exported.cardBg),
    elevated: color(exported.infoBg ?? parts.selectedBg),
    text: color(parts.text),
    muted: color(parts.muted),
    border: color(parts.borderMuted ?? parts.border),
    accent: color(parts.accent),
    success: color(parts.success),
    error: color(parts.error),
  }
  const brightness = (hex: string) =>
    [1, 3, 5].reduce((sum, index) => sum + Number.parseInt(hex.slice(index, index + 2), 16), 0)
  const appearance =
    source.appearance ??
    (colors.background
      ? brightness(colors.background) >= 384
        ? 'light'
        : 'dark'
      : colors.text && brightness(colors.text) < 384
        ? 'light'
        : 'dark')
  if (colors.accent) colors.accentText = brightness(colors.accent) >= 384 ? '#080c0f' : '#faf9f5'
  return parseTheme({
    id,
    name: source.name,
    appearance,
    colors: Object.fromEntries(Object.entries(colors).filter(([, value]) => value !== undefined)),
  })
}

function pathName(filename: string) {
  return filename.replace(/\.json$/i, '')
}
