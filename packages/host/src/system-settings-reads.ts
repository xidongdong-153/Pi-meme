import { readPage, readRecord, readText, SystemReadError, type ReadQuery } from '@pi-meme/contracts/system-read'
import type { SessionRef } from '@pi-meme/contracts/app-host'
import { defaultAccessMode } from '@pi-meme/contracts/agent-access'
import type { SystemOperation } from '@pi-meme/contracts/system-tools'

type Row = Record<string, unknown>
type Reader = () => unknown | Promise<unknown>

/** Dependencies must only inspect existing state. They must not load workers, reconnect, or probe services. */
export type SettingsReadContext = {
  hostId: string
  session: SessionRef
  cwd: string
  configuration: Reader
  models?: Reader
  modelDefaults?: Reader
  modelAuth?: Reader
  imageGeneration?: Reader
  subagents?: Reader
  plugins?: Reader
  pluginDiagnostics?: Reader
  sessionPlugins?: Reader
  mcp?: Reader
  usage?: Reader
  instructions?: Reader
  captured?: Reader
  runtime?: Reader
  modules?: Reader
  services?: Reader
  sandbox?: Reader
  storage?: Reader
  execution?: Reader
}

const definitions: Array<[string, string, string, SystemOperation['scope']?]> = [
  ['settings.general', '读取 Host 常规设置的字段白名单及配置来源', '[]'],
  ['settings.agent', '读取默认 Agent、子代理和工具配置，不重载执行', '[]'],
  ['tools.execution', '区分保存的工具开关、本轮捕获设置和有效权限', '[]', 'session'],
  ['permissions.status', '读取默认与本轮有效访问权限及沙箱可用性', '[]', 'session'],
  ['sandbox.status', '读取 Host 启动时已缓存的沙箱能力，不重新探测', '[]'],
  ['host.runtime', '读取实际 Host 与已有 Pi 连接的安全运行摘要', '[]'],
  ['host.modules', '分页读取已装配内置模块状态', '[{cursor?,limit?}?]'],
  ['host.diagnostics', '读取配置、模块、插件的安全诊断代码，不返回原始错误日志', '[{cursor?,limit?}?]'],
  [
    'models.providers',
    '分页读取提供商配置；指定 providerId 时分页读取其模型，不含地址或请求头',
    '[{providerId?,cursor?,limit?}?]',
  ],
  ['models.defaults', '读取已保存默认模型和思考等级，不创建 SDK 运行时', '[]'],
  ['models.authStatus', '分页读取提供商凭据存在性与认证类型，不刷新或验证凭据', '[{cursor?,limit?}?]'],
  ['imageGeneration.config', '读取图片模型配置与默认选择，不生图或测试连接', '[{cursor?,limit?}?]'],
  ['subagents.settings', '读取子代理总开关、默认模型、思考等级和选择的定义', '[]'],
  ['subagents.catalog', '分页读取子代理定义与安全诊断，不重载定义', '[{cursor?,limit?}?]'],
  ['plugins.list', '分页读取安装插件的状态与能力摘要，不加载插件', '[{cursor?,limit?}?]'],
  ['plugins.get', '读取插件安全详情；长字段可显式分片读取', '[pluginId,{piece?:{field,offset?,limit?}}?]'],
  ['plugins.status', '分页读取已安装插件的启用、代次与切换状态', '[{cursor?,limit?}?]'],
  ['plugins.dependencies', '读取插件声明依赖与现有服务提供者，不启动依赖', '[pluginId,{cursor?,limit?}?]'],
  ['plugins.permissions', '读取插件声明权限和授权白名单，不返回凭据或网络地址', '[pluginId]'],
  ['plugins.session', '分页读取本轮捕获的插件代次，与安装状态和当前授权区分', '[{cursor?,limit?}?]', 'session'],
  ['plugins.diagnostics', '分页读取插件安全诊断代码，不返回异常正文或目录', '[{cursor?,limit?}?]'],
  ['mcp.status', '分页读取 MCP 保存配置及本轮加载状态，不连接或检查服务', '[{cursor?,limit?}?]', 'session'],
  ['mcp.tools', '分页读取本轮已经捕获的 MCP 工具元数据；未捕获返回 unknown', '[{cursor?,limit?}?]', 'session'],
  ['usage.summary', '读取 Host 本地用量汇总，保留未知费用与不完整状态', '[]'],
  ['usage.details', '分页读取 Host 每日 Token 用量，不读取提供商账单', '[{cursor?,limit?}?]'],
  ['storage.info', '读取执行 Host 存储来源及配置状态，不返回敏感配置路径', '[]'],
  ['storage.status', '读取 Host 已有维护状态；未观察到的客户端维护状态为 unknown', '[]'],
  [
    'instructions.configured',
    '读取保存的 Host 和项目指令来源与修订；正文显式分页',
    '[{kind?,source?,offset?,limit?}?]',
  ],
  [
    'instructions.captured',
    '读取当前执行已捕获的指令；无快照返回 unknown',
    '[{kind?,source?,offset?,limit?}?]',
    'session',
  ],
  [
    'instructions.effective',
    '区分保存指令与本轮指令的生效信息；正文显式分页',
    '[{kind?,source?,offset?,limit?}?]',
    'session',
  ],
]

const rangeProperties = {
  cursor: { type: 'string', maxLength: 4096 },
  offset: { type: 'integer', minimum: 0 },
  limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  revision: { type: 'string' },
}
const objectSchema = (properties: Row) => ({ type: 'object', additionalProperties: false, properties })
const pagedOperations = new Set([
  'host.modules',
  'host.diagnostics',
  'models.providers',
  'models.authStatus',
  'imageGeneration.config',
  'subagents.catalog',
  'plugins.list',
  'plugins.status',
  'plugins.session',
  'plugins.diagnostics',
  'mcp.status',
  'mcp.tools',
  'usage.details',
])
const itemFields: Record<string, Record<string, string>> = {
  'host.modules': { id: 'string', version: 'string', status: 'string' },
  'host.diagnostics': { domain: 'string', code: 'string', id: 'string', status: 'string' },
  'models.providers': {
    id: 'string',
    name: 'string',
    api: 'string',
    credentialConfigured: 'boolean',
    endpointConfigured: 'boolean',
    headersConfigured: 'boolean',
    compatibilityConfigured: 'boolean',
    modelCount: 'number',
    contextWindow: 'number',
    maxTokens: 'number',
    reasoning: 'boolean',
  },
  'models.authStatus': {
    provider: 'string',
    configured: 'boolean',
    authType: 'string',
    source: 'string',
    status: 'string',
    validity: 'string',
    headersConfigured: 'boolean',
  },
  'imageGeneration.config': {
    id: 'string',
    name: 'string',
    model: 'string',
    size: 'string',
    quality: 'string',
    credentialConfigured: 'boolean',
    endpointConfigured: 'boolean',
    source: 'string',
  },
  'subagents.catalog': { id: 'string', description: 'string', maxTurns: 'number', enabled: 'boolean', tools: 'array' },
  'plugins.list': {
    id: 'string',
    version: 'string',
    description: 'string',
    generation: 'number',
    enabled: 'boolean',
    grantChanging: 'boolean',
    status: 'string',
    capabilities: 'object',
  },
  'plugins.dependencies': { service: 'string', providers: 'array', builtinProviders: 'array', status: 'string' },
  'plugins.diagnostics': { domain: 'string', code: 'string', id: 'string', status: 'string' },
  'mcp.status': {
    name: 'string',
    enabled: 'boolean',
    authorized: 'boolean',
    transport: 'string',
    endpointConfigured: 'boolean',
    authenticationConfigured: 'boolean',
    environmentConfigured: 'boolean',
    headersConfigured: 'boolean',
    connection: 'string',
  },
  'mcp.tools': { name: 'string', description: 'string', server: 'string', enabled: 'boolean' },
  'usage.details': { date: 'string', tokens: 'number' },
}
function operationInputSchema(name: string): Row {
  let prefixItems: Row[] = []
  let minItems = 0
  if (pagedOperations.has(name)) {
    prefixItems = [
      objectSchema({
        ...rangeProperties,
        ...(name === 'models.providers' ? { providerId: { type: 'string', minLength: 1, maxLength: 500 } } : {}),
      }),
    ]
  } else if (name.startsWith('instructions.')) {
    prefixItems = [
      objectSchema({
        kind: { enum: ['agents', 'system', 'append-system'] },
        source: { enum: ['host', 'project'] },
        offset: rangeProperties.offset,
        limit: { type: 'integer', minimum: 1, maximum: 20000, default: 12000 },
        revision: rangeProperties.revision,
      }),
    ]
  } else if (['plugins.get', 'plugins.dependencies', 'plugins.permissions'].includes(name)) {
    minItems = 1
    prefixItems = [{ type: 'string', minLength: 1, maxLength: 500, description: '从 plugins.list 获取的插件 id' }]
    if (name === 'plugins.dependencies') prefixItems.push(objectSchema(rangeProperties))
    if (name === 'plugins.get')
      prefixItems.push(
        objectSchema({
          piece: {
            ...objectSchema({
              field: { enum: ['description', 'name'] },
              offset: rangeProperties.offset,
              limit: { type: 'integer', minimum: 1, maximum: 20000 },
              revision: rangeProperties.revision,
            }),
            required: ['field'],
          },
        }),
      )
  }
  return { type: 'array', prefixItems, minItems, maxItems: prefixItems.length }
}
export const systemSettingsReadDefinitions: SystemOperation[] = definitions.map(
  ([name, description, parameters, scope]) => ({
    name,
    description,
    parameters,
    scope: scope ?? 'host',
    write: false,
    domain: name.split('.')[0],
    inputSchema: operationInputSchema(name),
    outputSchema: {
      type: 'object',
      description: name.startsWith('instructions.')
        ? '默认返回来源/修订/长度；提供 kind 和 source 时返回可续读正文。captured 缺失明确 unknown。'
        : '字段白名单投影；unknown 表示没有观察到运行状态。分页采用 items/total/revision/nextCursor，错误不含原始日志或敏感配置。',
      properties: {
        status: { type: 'string' },
        source: { type: 'string' },
        configured: { type: 'object', description: '保存的配置，不代表当前执行已采用' },
        captured: { type: 'object', description: '本次执行捕获的快照；未保留则 unknown' },
        effective: { type: 'object', description: '有效权限或已捕获内容，未知不推断为生效' },
        ...(pagedOperations.has(name) || name === 'plugins.dependencies'
          ? {
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: Object.fromEntries(
                    Object.entries(itemFields[name] ?? itemFields['plugins.list']!).map(([key, type]) => [
                      key,
                      { type },
                    ]),
                  ),
                },
              },
              total: { type: 'integer', minimum: 0 },
              revision: { type: 'string' },
              nextCursor: { type: 'string' },
              observedAt: { type: 'string' },
            }
          : {}),
      },
    },
    limits: { maxPageSize: 100, textBytes: 48 * 1024, retained: '运行状态仅读取已捕获快照；不主动探测或重载' },
  }),
)

function row(value: unknown): Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {}
}
function rows(value: unknown): Row[] {
  return Array.isArray(value) ? value.map(row) : []
}
function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}
function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}
function fields(value: unknown, names: string[]): Row {
  const source = row(value)
  const result: Row = {}
  for (const name of names) {
    const item = source[name]
    if (typeof item === 'string' || typeof item === 'boolean' || number(item) !== undefined) result[name] = item
  }
  return result
}
function selected(value: unknown, choices: readonly string[]): string | undefined {
  return typeof value === 'string' && choices.includes(value) ? value : undefined
}
function model(value: unknown) {
  const source = row(value)
  return typeof source.provider === 'string' && typeof source.id === 'string'
    ? { provider: source.provider, id: source.id }
    : null
}
function fail(code: string): never {
  throw new SystemReadError(code.endsWith('not-found') ? 'not-found' : 'invalid-input', code)
}
function query(value: unknown, allowed: string[] = []) {
  return readRecord(value, [...new Set(['cursor', 'offset', 'limit', 'revision', ...allowed])])
}
function piece(content: string, input: Row) {
  return readText(content, input as ReadQuery)
}
function diagnostic(domain: string, value: unknown, id?: string) {
  const data = row(value)
  return {
    domain,
    code: 'diagnostic-present',
    ...(id ? { id } : {}),
    status: data.error || data.message ? 'error' : 'unknown',
  }
}
function settingsProjection(value: unknown) {
  const source = row(value)
  return {
    showComposerHint: bool(source.showComposerHint) ?? true,
    showContextUsage: bool(source.showContextUsage) ?? true,
    contextWindowArchive: bool(source.contextWindowArchive) ?? false,
    ...fields(source, ['preferredProjectApp']),
    defaultAccessMode:
      selected(source.defaultAccessMode, ['read-only', 'workspace-write', 'full-access']) ?? defaultAccessMode,
    defaultAccessModeSource: source.defaultAccessMode === undefined ? 'application-default' : 'host-configuration',
    sidebar: {
      groupMode: selected(row(source.sidebar).groupMode, ['projects', 'merged']) ?? 'unknown',
      sortMode: selected(row(source.sidebar).sortMode, ['recent', 'manual']) ?? 'unknown',
      collapsed: fields(row(source.sidebar).collapsed, ['pinned', 'projects', 'recents']),
    },
    pinnedDirectoryCount: strings(source.pinnedPaths).length,
    source: 'host-configuration',
  }
}
function agentProjection(value: unknown) {
  const source = row(value)
  return {
    ...fields(source, ['codemodeEnabled', 'mcpEnabled', 'subagentsEnabled']),
    enabledSubagents: strings(source.enabledSubagents),
    defaultAgentPlugins: strings(source.defaultAgentPlugins),
    subagentDefaults: {
      model: model(row(source.subagentDefaults).model),
      thinkingLevel:
        selected(row(source.subagentDefaults).thinkingLevel, [
          'off',
          'minimal',
          'low',
          'medium',
          'high',
          'xhigh',
          'max',
        ]) ?? null,
    },
    source: 'host-configuration',
  }
}
function toolsProjection(value: unknown) {
  return fields(value, ['codemodeEnabled', 'mcpEnabled', 'subagentsEnabled'])
}
function pluginSummary(value: unknown) {
  const source = row(value)
  return {
    ...fields(source, ['id', 'version', 'description', 'generation', 'enabled', 'grantChanging']),
    status: selected(source.status, ['pending', 'failed', 'active', 'disabled']) ?? 'unknown',
    capabilities: fields(source.capabilities, ['server', 'agent', 'ui', 'resources']),
    ...(source.error ? { error: { code: 'plugin-failed' } } : {}),
  }
}
function permissionsProjection(value: unknown) {
  const source = row(value)
  const restricted = row(source.restricted)
  return {
    trusted: fields(source.trusted, ['ui', 'server', 'agent']),
    ui: strings(source.ui),
    beforeSend: strings(source.beforeSend),
    restricted: {
      maxAccess: selected(restricted.maxAccess, ['read-only', 'workspace-write']) ?? 'unknown',
      capabilities: strings(restricted.capabilities),
      network: rows(restricted.network).map((entry) => ({
        id: text(entry.id),
        methods: strings(entry.methods),
        originConfigured: typeof entry.origin === 'string',
      })),
      sharedData: strings(restricted.sharedData),
    },
    revision: number(source.revision),
  }
}
function providerSummary(value: unknown) {
  const source = row(value)
  return {
    ...fields(source, ['id', 'name', 'api']),
    credentialConfigured: bool(source.hasApiKey) ?? false,
    endpointConfigured: typeof source.baseUrl === 'string' && Boolean(source.baseUrl),
    headersConfigured: Object.keys(row(source.headers)).length > 0,
    compatibilityConfigured: Object.keys(row(source.compat)).length > 0,
    modelCount: Array.isArray(source.models) ? source.models.length : 0,
    source: 'host-model-configuration',
  }
}
function configuredModel(value: unknown) {
  const source = row(value)
  return {
    ...fields(source, ['id', 'name', 'api', 'contextWindow', 'maxTokens', 'reasoning']),
    input: strings(source.input).filter((item) => ['text', 'image'].includes(item)),
    endpointConfigured: typeof source.baseUrl === 'string' && Boolean(source.baseUrl),
    headersConfigured: Object.keys(row(source.headers)).length > 0,
    compatibilityConfigured: Object.keys(row(source.compat)).length > 0,
  }
}
function safeRuntime(value: unknown) {
  const source = row(value)
  const connection = row(source.connection)
  return {
    ...fields(source, ['hostId', 'version', 'piVersion', 'platform', 'arch', 'nodeVersion', 'apiVersion']),
    status: selected(source.status, ['running', 'ready', 'stopping', 'stopped', 'unknown']) ?? 'unknown',
    connection: {
      status:
        selected(connection.status, ['idle', 'connecting', 'ready', 'connected', 'disconnected', 'error']) ?? 'unknown',
      ...(connection.error ? { error: { code: 'connection-error' } } : {}),
    },
  }
}

export function createSettingsReads(context: SettingsReadContext) {
  const read = async (callback: Reader | undefined) => (callback ? await callback() : undefined)
  const capture = async () => row(await read(context.captured))
  const configuration = async () => {
    const value = row(await context.configuration())
    return Object.hasOwn(value, 'settings') ? row(value.settings) : value
  }
  const installed = async () => rows(await read(context.plugins))
  const plugin = async (id: unknown) => {
    if (typeof id !== 'string' || !id || id.length > 500) fail('invalid-plugin-id')
    const entry = (await installed()).find((item) => item.id === id)
    if (!entry) fail('plugin-not-found')
    return entry!
  }
  const instructionResult = (value: unknown, input: Row, source: string) => {
    if (value === undefined) return { status: 'unknown', source, reason: 'execution-snapshot-unavailable' }
    const data = row(value)
    const entries = rows(data.entries)
    const kinds = ['agents', 'system', 'append-system']
    if (input.kind !== undefined && !kinds.includes(String(input.kind))) fail('invalid-instruction-kind')
    if (input.source !== undefined && !['host', 'project'].includes(String(input.source)))
      fail('invalid-instruction-source')
    if (input.kind !== undefined && input.source !== undefined) {
      const entry = entries.find((item) => item.kind === input.kind)
      if (!entry) fail('instruction-not-found')
      const file = row(entry[String(input.source)])
      if (typeof file.content !== 'string')
        return { status: file.exists === false ? 'missing' : 'unknown', source, kind: input.kind }
      return {
        status: 'available',
        source,
        kind: input.kind,
        location: input.source,
        exists: bool(file.exists),
        ...piece(file.content, input),
      }
    }
    if (input.offset !== undefined || input.limit !== undefined || input.source !== undefined)
      fail('instruction-kind-and-source-required')
    return {
      status: 'available',
      source,
      entries: entries
        .filter((item) => input.kind === undefined || item.kind === input.kind)
        .map((entry) => ({
          kind: selected(entry.kind, kinds),
          effectiveSource: selected(entry.effective, ['host', 'project', 'combined', 'default']) ?? 'unknown',
          host: {
            exists: bool(row(entry.host).exists),
            revision: text(row(entry.host).revision),
            characters:
              typeof row(entry.host).content === 'string' ? String(row(entry.host).content).length : undefined,
          },
          project:
            entry.project === null
              ? null
              : {
                  exists: bool(row(entry.project).exists),
                  revision: text(row(entry.project).revision),
                  characters:
                    typeof row(entry.project).content === 'string'
                      ? String(row(entry.project).content).length
                      : undefined,
                },
        })),
    }
  }
  return {
    async read(operation: string, args: unknown[]): Promise<unknown> {
      if (!systemSettingsReadDefinitions.some((entry) => entry.name === operation)) fail('settings-operation-not-found')
      if (args.length > 2) fail('invalid-arguments')
      try {
        const page = (items: unknown[], input: Row) =>
          readPage(
            items,
            input as ReadQuery,
            JSON.stringify([
              context.hostId,
              context.session.sessionId,
              operation,
              input.providerId ?? null,
              operation === 'plugins.dependencies' ? args[0] : null,
            ]),
          )
        const acceptsSecond = ['plugins.get', 'plugins.dependencies'].includes(operation)
        if (args.length > (acceptsSecond ? 2 : 1)) fail('invalid-arguments')
        switch (operation) {
          case 'settings.general':
            if (args.length) fail('invalid-arguments')
            return { configured: settingsProjection(await configuration()) }
          case 'settings.agent':
          case 'subagents.settings':
            if (args.length) fail('invalid-arguments')
            return {
              configured: agentProjection(await configuration()),
              captured: row(await capture()).settings
                ? agentProjection((await capture()).settings)
                : { status: 'unknown' },
            }
          case 'tools.execution': {
            if (args.length) fail('invalid-arguments')
            const configured = toolsProjection(await configuration())
            const captured = await capture()
            const execution = row(await read(context.execution))
            const mode = selected(execution.mode, ['default', 'plan']) ?? 'unknown'
            const accessMode =
              selected(execution.accessMode, ['read-only', 'workspace-write', 'full-access']) ?? 'unknown'
            const allowed = mode === 'default' && accessMode === 'full-access'
            return {
              configured,
              captured: captured.tools ? toolsProjection(captured.tools) : { status: 'unknown' },
              effective: {
                mode,
                accessMode,
                externalAgentToolsAllowed: mode === 'unknown' || accessMode === 'unknown' ? 'unknown' : allowed,
                codemodeEnabled: bool(row(captured.tools).codemodeEnabled) ?? 'unknown',
                mcpEnabled:
                  !allowed && mode !== 'unknown' && accessMode !== 'unknown'
                    ? false
                    : (bool(row(captured.tools).mcpEnabled) ?? 'unknown'),
                source: 'execution-permissions',
              },
            }
          }
          case 'permissions.status': {
            if (args.length) fail('invalid-arguments')
            const settings = await configuration()
            const execution = row(await read(context.execution))
            return {
              defaultAccessMode:
                selected(settings.defaultAccessMode, ['read-only', 'workspace-write', 'full-access']) ??
                defaultAccessMode,
              execution: {
                accessMode:
                  selected(execution.accessMode, ['read-only', 'workspace-write', 'full-access']) ?? 'unknown',
                mode: selected(execution.mode, ['default', 'plan']) ?? 'unknown',
              },
              sandbox: fields(await read(context.sandbox), ['supported', 'platform']),
            }
          }
          case 'sandbox.status': {
            if (args.length) fail('invalid-arguments')
            const sandbox = row(await read(context.sandbox))
            return {
              ...fields(sandbox, ['supported', 'platform', 'checkedAt']),
              status: typeof sandbox.supported === 'boolean' ? 'captured' : 'unknown',
              ...(sandbox.reason ? { reason: 'sandbox-unavailable' } : {}),
              source: 'host-startup-capability',
            }
          }
          case 'host.runtime':
            if (args.length) fail('invalid-arguments')
            return { hostId: context.hostId, ...safeRuntime(await read(context.runtime)) }
          case 'host.modules':
            return page(
              rows(await read(context.modules)).map((entry) => fields(entry, ['id', 'version', 'status'])),
              query(args[0]),
            )
          case 'host.diagnostics': {
            const diagnostics = rows(await read(context.pluginDiagnostics)).map((entry) =>
              diagnostic('plugins', entry, text(entry.id)),
            )
            const settings = row(await context.configuration())
            if (row(settings.writeState).status === 'blocked') diagnostics.push(diagnostic('settings', { error: true }))
            for (const _ of Array.isArray(settings.errors) ? settings.errors : [])
              diagnostics.push(diagnostic('settings', { error: true }))
            const sandbox = row(await read(context.sandbox))
            if (sandbox.supported === false) diagnostics.push(diagnostic('sandbox', { error: true }))
            const mcp = row(await read(context.mcp))
            if (mcp.error) diagnostics.push(diagnostic('mcp', { error: true }))
            for (const module of rows(await read(context.modules)))
              if (module.status !== 'active') diagnostics.push(diagnostic('modules', { error: true }, text(module.id)))
            return page(diagnostics, query(args[0]))
          }
          case 'models.defaults': {
            if (args.length) fail('invalid-arguments')
            const defaults = row(await read(context.modelDefaults))
            return {
              configured: {
                model: model(defaults.model),
                thinkingLevel:
                  selected(defaults.thinkingLevel, ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) ?? null,
                source: 'host-model-settings',
                status:
                  selected(defaults.status, ['configured', 'missing']) ??
                  (context.modelDefaults ? 'available' : 'unknown'),
              },
              effective: { status: 'unknown', reason: 'session-model-is-explicit' },
            }
          }
          case 'models.authStatus': {
            const auth = rows(await read(context.modelAuth))
            const configured = rows(row(await read(context.models)).providers)
            const values = new Map(
              auth.map((entry) => [
                entry.provider ?? entry.id,
                {
                  provider: text(entry.provider ?? entry.id),
                  configured: bool(entry.configured),
                  authType: selected(entry.authType, ['api_key', 'oauth']) ?? 'unknown',
                  source:
                    selected(entry.source, ['host-credential-store', 'host-model-configuration', 'none']) ?? 'unknown',
                  status: selected(entry.status, ['stored', 'invalid', 'missing']) ?? 'unknown',
                  validity: 'unknown',
                  headersConfigured: bool(entry.headersConfigured),
                },
              ]),
            )
            for (const provider of configured)
              if (!values.has(provider.id))
                values.set(provider.id, {
                  provider: text(provider.id),
                  configured: bool(provider.hasApiKey),
                  authType: provider.hasApiKey ? 'api_key' : 'unknown',
                  source: 'host-model-configuration',
                  status: provider.hasApiKey ? 'stored' : 'missing',
                  validity: 'unknown',
                  headersConfigured: Object.keys(row(provider.headers)).length > 0,
                })
            return {
              status: context.modelAuth || context.models ? 'available' : 'unknown',
              ...page([...values.values()], query(args[0])),
            }
          }
          case 'models.providers': {
            const input = query(args[0], ['providerId', 'cursor', 'limit'])
            const data = row(await read(context.models))
            const providers = rows(data.providers)
            if (input.providerId !== undefined) {
              if (typeof input.providerId !== 'string') fail('invalid-provider-id')
              const provider = providers.find((entry) => entry.id === input.providerId)
              if (!provider) fail('provider-not-found')
              return {
                provider: providerSummary(provider),
                ...page(rows(provider!.models).map(configuredModel), input),
              }
            }
            return { configurationRevision: text(data.revision), ...page(providers.map(providerSummary), input) }
          }
          case 'imageGeneration.config': {
            const data = row(await read(context.imageGeneration))
            return {
              status: data.error ? 'error' : context.imageGeneration ? 'configured' : 'unknown',
              configurationRevision: text(data.revision),
              defaultId: text(data.defaultId),
              ...(data.error ? { error: { code: 'image-config-unavailable' } } : {}),
              ...page(
                rows(data.models).map((entry) => ({
                  ...fields(entry, ['id', 'name', 'model', 'size', 'quality']),
                  credentialConfigured: bool(entry.hasApiKey),
                  endpointConfigured: typeof entry.baseUrl === 'string' && Boolean(entry.baseUrl),
                  source: 'host-image-configuration',
                })),
                query(args[0]),
              ),
            }
          }
          case 'subagents.catalog': {
            const data = row(await read(context.subagents))
            return {
              status: context.subagents ? 'configured' : 'unknown',
              diagnostics: rows(data.diagnostics).map((entry) => diagnostic('subagents', entry)),
              ...page(
                rows(data.agents).map((entry) => ({
                  ...fields(entry, ['id', 'description', 'maxTurns', 'enabled']),
                  tools: strings(entry.tools),
                })),
                query(args[0]),
              ),
            }
          }
          case 'plugins.list':
          case 'plugins.status':
            return {
              status: context.plugins ? 'available' : 'unknown',
              ...page((await installed()).map(pluginSummary), query(args[0])),
            }
          case 'plugins.get': {
            const entry = await plugin(args[0])
            const input = query(args[1], ['piece'])
            if (input.piece !== undefined) {
              const part = query(input.piece, ['field', 'offset', 'limit'])
              if (!['description', 'name'].includes(String(part.field))) fail('invalid-piece-field')
              const content = part.field === 'name' ? text(row(entry.display).name) : text(entry.description)
              return { id: text(entry.id), field: part.field, ...piece(content ?? '', part) }
            }
            return {
              ...pluginSummary(entry),
              name: text(row(entry.display).name),
              requires: strings(entry.requires),
              provides: strings(entry.provides),
              entries: {
                agent: fields(row(entry.entries).agent, ['trusted', 'restricted']),
                server: fields(row(entry.entries).server, ['trusted', 'restricted']),
              },
              permissions: permissionsProjection(entry.permissions),
              grant: permissionsProjection(entry.grant),
              operations: rows(entry.operations).map((operation) => ({
                ...fields(operation, ['name', 'effect']),
                audience: strings(operation.audience),
              })),
            }
          }
          case 'plugins.permissions': {
            if (args.length !== 1) fail('invalid-arguments')
            const entry = await plugin(args[0])
            return {
              id: text(entry.id),
              generation: number(entry.generation),
              grantChanging: bool(entry.grantChanging),
              declared: permissionsProjection(entry.permissions),
              granted: permissionsProjection(entry.grant),
            }
          }
          case 'plugins.dependencies': {
            const entry = await plugin(args[0])
            const all = await installed()
            const modules = rows(await read(context.modules))
            const services = strings(await read(context.services))
            return {
              id: text(entry.id),
              provides: strings(entry.provides),
              resolution: 'host-registry-metadata',
              ...page(
                strings(entry.requires).map((requirement) => ({
                  service: requirement,
                  providers: all
                    .filter((item) => strings(item.provides).includes(requirement))
                    .map((item) => ({
                      id: text(item.id),
                      status: selected(item.status, ['active', 'disabled', 'failed', 'pending']) ?? 'unknown',
                      enabled: bool(item.enabled),
                    })),
                  builtinProviders: modules
                    .filter((item) => strings(item.provides).includes(requirement))
                    .map((item) => text(item.id)),
                  status: services.includes(requirement)
                    ? 'host-service-present'
                    : all.some((item) => strings(item.provides).includes(requirement) && item.status === 'active')
                      ? 'provider-active'
                      : 'unknown',
                })),
                query(args[1]),
              ),
            }
          }
          case 'plugins.session': {
            const captured = await read(context.sessionPlugins)
            if (captured === undefined)
              return { status: 'unknown', reason: 'execution-snapshot-unavailable', ...page([], query(args[0])) }
            const current = await installed()
            const execution = row(await read(context.execution))
            const prohibited =
              execution.mode === 'plan' ||
              (typeof execution.accessMode === 'string' && execution.accessMode !== 'full-access')
            return {
              status: 'captured',
              ...page(
                rows(captured).map((entry) => {
                  const latest = current.find((item) => item.id === entry.id)
                  const changed = latest && latest.policyHash !== entry.policyHash
                  return {
                    ...pluginSummary(entry),
                    executionGeneration: number(entry.generation),
                    installedGeneration: number(latest?.generation),
                    pendingReload: latest ? latest.generation !== entry.generation : true,
                    authorization: changed ? 'policy-changed' : latest ? 'current-policy' : 'not-installed',
                    grant: permissionsProjection(changed || !latest ? entry.grant : latest.grant),
                    effectiveAllowed:
                      prohibited || !latest || changed || latest.enabled === false || latest.grantChanging
                        ? false
                        : 'unknown',
                  }
                }),
                query(args[0]),
              ),
            }
          }
          case 'plugins.diagnostics':
            return page(
              rows(await read(context.pluginDiagnostics)).map((entry) => diagnostic('plugins', entry, text(entry.id))),
              query(args[0]),
            )
          case 'mcp.status': {
            const configured = row(await read(context.mcp))
            const settings = await configuration()
            const captured = await capture()
            return {
              configuredEnabled: bool(settings.mcpEnabled) ?? false,
              captured: captured.mcp
                ? { status: 'captured', ...fields(captured.mcp, ['enabled']) }
                : { status: 'unknown' },
              ...(configured.error ? { error: { code: 'mcp-config-unavailable' } } : {}),
              configurationRevision: text(configured.revision),
              ...page(
                rows(configured.servers).map((entry) => {
                  const config = row(entry.config)
                  return {
                    name: text(entry.name),
                    enabled: bool(config.enabled) ?? true,
                    authorized: bool(config.desktopAuthorized) ?? false,
                    transport:
                      typeof config.command === 'string'
                        ? 'stdio'
                        : typeof config.url === 'string'
                          ? 'http'
                          : 'unknown',
                    endpointConfigured: typeof config.url === 'string' || typeof config.command === 'string',
                    authenticationConfigured: Boolean(config.oauth || config.auth),
                    environmentConfigured: Object.keys(row(config.env)).length > 0,
                    headersConfigured: Object.keys(row(config.headers)).length > 0,
                    connection: 'unknown',
                    ...(entry.error ? { error: { code: 'mcp-server-config-invalid' } } : {}),
                  }
                }),
                query(args[0]),
              ),
            }
          }
          case 'mcp.tools': {
            const captured = row((await capture()).mcp)
            return {
              status: Array.isArray(captured.tools) ? 'captured' : 'unknown',
              source: 'execution-snapshot',
              ...page(
                rows(captured.tools).map((entry) => fields(entry, ['name', 'description', 'server', 'enabled'])),
                query(args[0]),
              ),
            }
          }
          case 'usage.summary': {
            if (args.length) fail('invalid-arguments')
            const data = row(await read(context.usage))
            return {
              status: context.usage
                ? Array.isArray(data.warnings) && data.warnings.length
                  ? 'partial'
                  : 'available'
                : 'unknown',
              ...fields(data, [
                'updatedAt',
                'today',
                'totalTokens',
                'peakDailyTokens',
                'longestTaskMs',
                'longestStreak',
                'currentStreak',
                'memoryTotalTokens',
                'memoryCalls',
                'memoryUnknownCalls',
                'memoryKnownCost',
                'memoryUnknownCostCalls',
              ]),
              ...(Array.isArray(data.warnings) && data.warnings.length
                ? { warnings: { code: 'usage-incomplete', count: data.warnings.length } }
                : {}),
              source: 'host-local-usage',
              providerBilling: 'unknown',
            }
          }
          case 'usage.details': {
            const data = row(await read(context.usage))
            return {
              status:
                Array.isArray(data.warnings) && data.warnings.length
                  ? 'partial'
                  : context.usage
                    ? 'available'
                    : 'unknown',
              ...page(
                rows(data.daily).map((entry) => fields(entry, ['date', 'tokens'])),
                query(args[0]),
              ),
            }
          }
          case 'storage.info':
          case 'storage.status': {
            if (args.length) fail('invalid-arguments')
            const data = row(await read(context.storage))
            return {
              hostId: context.hostId,
              source: selected(data.source, ['default', 'custom', 'environment']) ?? 'unknown',
              configured: typeof data.dataRoot === 'string' || bool(data.configured) === true,
              status: selected(data.status, ['ready', 'blocked', 'maintaining', 'unknown']) ?? 'unknown',
              canMaintain: bool(data.canMaintain) ?? 'unknown',
              cacheBytes: number(data.cacheBytes) ?? null,
              ...(data.error || data.lastError || data.cacheError
                ? { error: { code: 'storage-status-unavailable' } }
                : {}),
              clientMaintenance: 'unknown',
            }
          }
          case 'instructions.configured':
            return instructionResult(
              await read(context.instructions),
              query(args[0], ['kind', 'source', 'offset', 'limit']),
              'configuration',
            )
          case 'instructions.captured':
            return instructionResult(
              (await capture()).instructions,
              query(args[0], ['kind', 'source', 'offset', 'limit']),
              'execution-snapshot',
            )
          case 'instructions.effective': {
            const captured = await capture()
            const input = query(args[0], ['kind', 'source', 'offset', 'limit'])
            return {
              configured: instructionResult(await read(context.instructions), {}, 'configuration'),
              effective: instructionResult(captured.instructions, input, 'execution-snapshot'),
            }
          }
          default:
            return fail('settings-operation-not-found')
        }
      } catch (cause) {
        // Error codes may survive, arbitrary business messages and provider bodies may not.
        if (cause instanceof SystemReadError)
          throw new SystemReadError(
            cause.code,
            cause.code === 'stale-cursor'
              ? '数据已变化，请重新读取'
              : cause.code === 'not-found'
                ? '读取目标不存在'
                : '读取参数无效',
          )
        throw new SystemReadError('internal-error', '设置读取失败，请在设置页面检查该功能状态')
      }
    },
  }
}
