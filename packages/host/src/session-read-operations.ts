import type { AppSession, SessionRef } from '@pi-meme/contracts/app-host'
import type { Snapshot } from '@pi-meme/contracts/desktop'
import type { SessionHistoryData } from '@pi-meme/contracts/sessions'
import type { SystemOperation } from '@pi-meme/contracts/system-tools'
import { projectUiMessage } from '@pi-meme/contracts/plugin-ui-message'
import {
  readInteger,
  readPage,
  readRecord,
  readRevision,
  readString,
  readText,
  SystemReadError,
  type ReadQuery,
} from '@pi-meme/contracts/system-read'

const definitions = [
  [
    'sessions.snapshot',
    '读取公开状态、连接、模型与 Agent 摘要白名单；错误仅返回安全 code，不恢复运行时',
    '[query?,SessionRef?]',
  ],
  ['sessions.history', '分页读取当前分支历史消息', '[query?,SessionRef?]'],
  ['sessions.events', '分页读取公开流式消息和工具事件投影；隐藏思考、内部对象和原始错误不返回', '[query?,SessionRef?]'],
  ['sessions.message', '按原生 entryId 分片读取可见消息', '[{entryId,offset?,limit?,revision?},SessionRef?]'],
  ['sessions.tree', '分页读取会话条目树及活动叶子', '[{query?,type?,...分页}?,SessionRef?]'],
  [
    'sessions.entry',
    '按原生 entryId 分片读取公开条目投影；未知内部条目仅返回元数据及 protected',
    '[{entryId,offset?,limit?,revision?},SessionRef?]',
  ],
  ['sessions.query', '按名称和目录查询已登记会话', '[{query?,project?,...分页}?]'],
  ['sessions.search', '有界搜索已登记会话的可见消息', '[{query,project?,sessions?,...分页}]'],
  ['sessions.queue', '读取已有会话队列，不取出或编辑输入', '[SessionRef?]'],
  ['sessions.interactions', '分页读取待答交互，不确认或回答', '[query?,SessionRef?]'],
  ['sessions.stats', '读取已有统计及估算状态', '[SessionRef?]'],
  ['sessions.sources', '分页读取已发送与排队附件及技能来源', '[query?,SessionRef?]'],
  ['sessions.image', '读取消息内联图片，不获取远程网址', '[{entryId,index},SessionRef?]'],
  ['agents.get', '读取所属根会话的公开子代理摘要白名单；错误仅返回安全 code', '[agentId,SessionRef?]'],
  ['agents.messages', '分页读取子代理可见消息', '[{agentId,...分页},SessionRef?]'],
  [
    'agents.events',
    '分页读取子代理公开事件投影；隐藏思考、内部对象和原始错误不返回',
    '[{agentId,...分页},SessionRef?]',
  ],
  ['agents.mailbox', '分页读取协作邮件，不消费邮件', '[{agentId?,...分页}?,SessionRef?]'],
  ['plans.history', '分页读取当前分支保存的计划版本', '[query?,SessionRef?]'],
  ['plans.get', '按版本分片读取保存计划', '[{id,version,offset?,limit?,revision?},SessionRef?]'],
  ['git.turnChangeSummaries', '分页读取指定原生用户轮次的文件变更摘要', '[{entryIds,...分页},SessionRef?]'],
  [
    'git.turnFile',
    '分片读取保存轮次的文件差异',
    '[{entryId,path,part?:patch|before|after,offset?,limit?,revision?},SessionRef?]',
  ],
] as const
const fieldSchemas: Record<string, unknown> = {
  cursor: { type: 'string', maxLength: 4096 },
  offset: { type: 'integer', minimum: 0 },
  limit: { type: 'integer', minimum: 1, maximum: 100 },
  revision: { type: 'string' },
  query: { type: 'string', minLength: 1, maxLength: 1024 },
  type: { type: 'string' },
  entryId: { type: 'string', minLength: 1, maxLength: 256 },
  index: { type: 'integer', minimum: 0, maximum: 1000 },
  agentId: { type: 'string', minLength: 1, maxLength: 256 },
  id: { type: 'string', minLength: 1, maxLength: 256 },
  version: { type: 'integer', minimum: 1 },
  entryIds: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'string', minLength: 1, maxLength: 256 } },
  path: { type: 'string', minLength: 1, maxLength: 4096 },
  part: { enum: ['patch', 'before', 'after'] },
  project: {
    type: 'object',
    required: ['hostId', 'projectId'],
    additionalProperties: false,
    properties: {
      hostId: { type: 'string', minLength: 1, maxLength: 128 },
      projectId: { type: 'string', minLength: 1, maxLength: 128 },
    },
  },
  sessions: {
    type: 'array',
    minItems: 1,
    maxItems: 100,
    items: {
      type: 'object',
      required: ['hostId', 'sessionId'],
      additionalProperties: false,
      properties: {
        hostId: { type: 'string', minLength: 1, maxLength: 128 },
        sessionId: { type: 'string', minLength: 1, maxLength: 128 },
      },
    },
  },
}
const pageFields = ['cursor', 'offset', 'limit', 'revision']
const operationFields: Record<string, string[]> = {
  'sessions.snapshot': [],
  'sessions.history': pageFields,
  'sessions.events': pageFields,
  'sessions.message': [...pageFields, 'entryId'],
  'sessions.tree': [...pageFields, 'query', 'type'],
  'sessions.entry': [...pageFields, 'entryId'],
  'sessions.query': [...pageFields, 'query', 'project'],
  'sessions.search': [...pageFields, 'query', 'project', 'sessions'],
  'sessions.interactions': pageFields,
  'sessions.sources': pageFields,
  'sessions.image': ['entryId', 'index'],
  'agents.messages': [...pageFields, 'agentId'],
  'agents.events': [...pageFields, 'agentId'],
  'agents.mailbox': [...pageFields, 'agentId'],
  'plans.history': pageFields,
  'plans.get': [...pageFields, 'id', 'version'],
  'git.turnChangeSummaries': [...pageFields, 'entryIds'],
  'git.turnFile': [...pageFields, 'entryId', 'path', 'part'],
}
const refSchema = {
  type: 'object',
  required: ['hostId', 'sessionId'],
  additionalProperties: false,
  properties: {
    hostId: { type: 'string', minLength: 1, maxLength: 128 },
    sessionId: { type: 'string', minLength: 1, maxLength: 128 },
  },
}
const requiredFields: Record<string, string[]> = {
  'sessions.message': ['entryId'],
  'sessions.entry': ['entryId'],
  'sessions.search': ['query'],
  'sessions.image': ['entryId', 'index'],
  'agents.messages': ['agentId'],
  'agents.events': ['agentId'],
  'plans.get': ['id', 'version'],
  'git.turnChangeSummaries': ['entryIds'],
  'git.turnFile': ['entryId', 'path'],
}
export const systemSessionReadDefinitions: SystemOperation[] = definitions.map(([name, description, parameters]) => {
  const properties = Object.fromEntries((operationFields[name] ?? []).map((key) => [key, fieldSchemas[key]]))
  if (name === 'sessions.message' || name === 'sessions.entry' || name === 'plans.get' || name === 'git.turnFile')
    properties.limit = { type: 'integer', minimum: 1, maximum: 20000 }
  const required = requiredFields[name] ?? []
  const hostScope = name === 'sessions.query' || name === 'sessions.search'
  const direct = name === 'sessions.queue' || name === 'sessions.stats'
  const first =
    name === 'sessions.queue' || name === 'sessions.stats'
      ? refSchema
      : name === 'agents.get'
        ? { type: 'string', minLength: 1, maxLength: 256 }
        : { type: 'object', additionalProperties: false, properties, required }
  return {
    name,
    description,
    parameters,
    write: false,
    scope: name === 'sessions.query' || name === 'sessions.search' ? 'host' : 'session',
    domain: name.split('.')[0],
    inputSchema: {
      type: 'array',
      prefixItems: hostScope || direct ? [first] : [first, refSchema],
      minItems: required.length > 0 || name === 'agents.get' ? 1 : 0,
      maxItems: hostScope || direct ? 1 : 2,
    },
    outputSchema: {
      description:
        '有界公共白名单投影，不返回隐藏 thinking/sealed、原始 Pi/provider 对象或原始错误；未知内部条目或事件为元数据及 protected。列表包含 items/total/revision/nextCursor/observedAt，正文包含 content/offset/total/revision/nextOffset',
    },
    limits: { textBytes: 49152, maxPageSize: 100 },
  }
})

export type SessionReadContext = {
  hostId: string
  reader: SessionRef
  session: (ref: SessionRef) => AppSession
  list: () => AppSession[]
  history: (session: AppSession) => Promise<SessionHistoryData>
  entry: (session: AppSession, id: string) => Promise<unknown>
  snapshot: (session: AppSession) => Promise<Snapshot>
  agent: (id: string) => Promise<Snapshot>
  turns: (session: AppSession, ids: string[]) => Promise<unknown[]>
  turnFile: (
    session: AppSession,
    id: string,
    path: string,
  ) => Promise<{ patch: string; before?: string; after?: string; notice?: string }>
}
type PublicRecord = Record<string, unknown>
function object(value: unknown): PublicRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as PublicRecord) : {}
}
/** Only named scalar fields cross this boundary; nested opaque objects never do. */
function scalars(value: PublicRecord, keys: readonly string[]): PublicRecord {
  return Object.fromEntries(
    keys.flatMap((key) => {
      const item = value[key]
      return item === null ||
        typeof item === 'string' ||
        typeof item === 'boolean' ||
        (typeof item === 'number' && Number.isFinite(item))
        ? [[key, item]]
        : []
    }),
  )
}
function publicModel(value: unknown): PublicRecord {
  const model = object(value)
  return {
    ...scalars(model, ['provider', 'id', 'name', 'api', 'reasoning', 'contextWindow', 'maxTokens']),
    input: Array.isArray(model.input) ? model.input.filter((item) => item === 'text' || item === 'image') : undefined,
    thinkingLevels: Array.isArray(model.thinkingLevels)
      ? model.thinkingLevels.filter((item) =>
          ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(String(item)),
        )
      : undefined,
    cost: scalars(object(model.cost), ['input', 'output', 'cacheRead', 'cacheWrite']),
  }
}
function publicStats(value: unknown): PublicRecord | null {
  if (value === undefined || value === null) return null
  const stats = object(value)
  return {
    ...scalars(stats, [
      'sessionId',
      'userMessages',
      'assistantMessages',
      'toolCalls',
      'toolResults',
      'totalMessages',
      'cost',
    ]),
    tokens: scalars(object(stats.tokens), ['input', 'output', 'cacheRead', 'cacheWrite', 'total']),
    contextUsage: scalars(object(stats.contextUsage), [
      'tokens',
      'contextWindow',
      'percent',
      'compactionId',
      'estimated',
    ]),
  }
}
function publicGeneration(value: unknown): PublicRecord | null {
  return value === undefined || value === null
    ? null
    : scalars(object(value), [
        'running',
        'phase',
        'elapsedMs',
        'generationMs',
        'generationActive',
        'ttftMs',
        'outputTokens',
        'estimated',
      ])
}
function publicAgent(value: unknown): PublicRecord {
  const agent = object(value)
  const cleanup = object(agent.cleanup)
  return {
    ...scalars(agent, [
      'agentId',
      'rootAgentId',
      'parentAgentId',
      'name',
      'avatar',
      'taskPath',
      'depth',
      'runId',
      'rootTaskId',
      'epoch',
      'executionGeneration',
      'isPaused',
      'status',
      'cwd',
      'sessionId',
      'thinkingLevel',
      'accessMode',
      'mode',
      'task',
      'report',
      'updatedAt',
      'runStartedAt',
      'runCompletedAt',
      'importedRunId',
    ]),
    model: agent.model === undefined ? undefined : publicModel(agent.model),
    error:
      agent.status === 'failed' ||
      agent.error !== undefined ||
      agent.failure !== undefined ||
      agent.failureReason !== undefined
        ? { code: 'agent-failed' }
        : undefined,
    cleanup:
      agent.cleanup === undefined
        ? undefined
        : {
            ...scalars(cleanup, ['state', 'causeId', 'revision']),
            error: cleanup.error === undefined ? undefined : { code: 'cleanup-failed' },
          },
  }
}
function publicState(value: unknown): PublicRecord {
  const state = object(value)
  const policy = object(state.pluginPolicy)
  return {
    ...scalars(state, [
      'mode',
      'activeMode',
      'sessionName',
      'isStreaming',
      'isCompacting',
      'isPaused',
      'queuePaused',
      'stopped',
      'pauseRevision',
      'steeringMode',
      'followUpMode',
      'pendingMessageCount',
      'thinkingLevel',
      'modelSelectionRequired',
    ]),
    model: state.model === undefined ? undefined : publicModel(state.model),
    generationMetrics: publicGeneration(state.generationMetrics),
    retry:
      state.retry === undefined
        ? undefined
        : {
            ...scalars(object(state.retry), ['kind', 'attempt', 'maxAttempts', 'delayMs']),
            error: { code: 'retrying' },
          },
    recovery: state.recovery === undefined ? undefined : scalars(object(state.recovery), ['entryId', 'mode']),
    compactionError: state.compactionError === undefined ? undefined : { code: 'compaction-failed' },
    pauseIntervals: Array.isArray(state.pauseIntervals)
      ? state.pauseIntervals.map((item) => scalars(object(item), ['startedAt', 'endedAt']))
      : undefined,
    runIntervals: Array.isArray(state.runIntervals)
      ? state.runIntervals.map((item) => scalars(object(item), ['startedAt', 'endedAt']))
      : undefined,
    resourceSnapshot:
      state.resourceSnapshot === undefined
        ? undefined
        : scalars(object(state.resourceSnapshot), ['id', 'generation', 'cwd']),
    pluginPolicy:
      state.pluginPolicy === undefined
        ? undefined
        : {
            ...scalars(policy, ['policyRevision']),
            capabilities: Array.isArray(policy.capabilities)
              ? policy.capabilities.filter((item) => typeof item === 'string')
              : [],
            effectivePlugins: Array.isArray(policy.effectivePlugins)
              ? policy.effectivePlugins.map((item) => scalars(object(item), ['id', 'generation']))
              : [],
            unavailablePlugins: Array.isArray(policy.unavailablePlugins)
              ? policy.unavailablePlugins.map((item) => ({
                  ...scalars(object(item), ['id']),
                  reason: { code: 'not-available' },
                }))
              : [],
          },
  }
}
function publicConnection(value: unknown): PublicRecord {
  const connection = object(value)
  return {
    ...scalars(connection, [
      'workspaceKind',
      'sourceProjectCwd',
      'generation',
      'cwd',
      'status',
      'accessMode',
      'accessChanging',
      'editPhase',
      'restrictedAccessSupported',
      'restrictedPluginRuntimeSupported',
      'piVersion',
    ]),
    error: connection.error === undefined ? undefined : { code: 'connection-failed' },
    restrictedAccessReason: connection.restrictedAccessReason === undefined ? undefined : { code: 'not-supported' },
    restrictedPluginRuntimeReason:
      connection.restrictedPluginRuntimeReason === undefined ? undefined : { code: 'not-supported' },
  }
}
function publicAppSession(value: unknown): PublicRecord {
  const session = object(value)
  const configuration = object(session.configuration)
  return {
    ...scalars(session, ['hostId', 'sessionId', 'cwd', 'createdAt', 'name', 'status', 'temporary', 'pinned']),
    project: session.project === undefined ? undefined : scalars(object(session.project), ['hostId', 'projectId']),
    configuration: {
      ...scalars(configuration, ['thinkingLevel', 'accessMode', 'mode']),
      model: configuration.model === undefined ? undefined : publicModel(configuration.model),
      agentPlugins: Array.isArray(configuration.agentPlugins)
        ? configuration.agentPlugins.filter((item) => typeof item === 'string')
        : [],
    },
  }
}
function publicSnapshot(snapshot: Snapshot): PublicRecord {
  const raw = object(snapshot)
  return {
    ...scalars(raw, ['totalMessages', 'historyRevision', 'historyDetails', 'goalsSupported', 'eventSequence']),
    connection: publicConnection(snapshot.connection),
    state: publicState(snapshot.state),
    appSession: snapshot.appSession === undefined ? undefined : publicAppSession(snapshot.appSession),
    agent: snapshot.agent === undefined ? undefined : publicAgent(snapshot.agent),
    agents: snapshot.agents?.map(publicAgent),
    models: snapshot.models.map(publicModel),
    thinkingLevels: snapshot.thinkingLevels?.filter((item) =>
      ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(item),
    ),
    stats: publicStats(snapshot.stats),
    goal:
      snapshot.goal === undefined
        ? undefined
        : {
            ...scalars(object(snapshot.goal), [
              'goalId',
              'revision',
              'objective',
              'status',
              'tokensUsed',
              'elapsedMs',
              'usageIncomplete',
              'progress',
              'turns',
              'createdAt',
              'updatedAt',
              'inputEntryId',
            ]),
            session: scalars(object(snapshot.goal.session), ['hostId', 'sessionId']),
            evidence: snapshot.goal.evidence.filter((item) => typeof item === 'string'),
            blocker: scalars(object(snapshot.goal.blocker), ['key', 'count']),
            reason: snapshot.goal.reason === undefined ? undefined : { code: 'goal-status' },
          },
    pendingInteractionCount: snapshot.pendingInteractions?.length ?? 0,
    historyAvailability:
      snapshot.historyAvailability === undefined
        ? undefined
        : scalars(object(snapshot.historyAvailability), ['tree', 'sources']),
    controlCursor:
      raw.controlCursor === undefined ? undefined : scalars(object(raw.controlCursor), ['journalEpoch', 'seq']),
    extensionError: snapshot.extensionError === undefined ? undefined : { code: 'extension-failed' },
  }
}
function publicContent(content: unknown): PublicRecord {
  if (typeof content === 'string') return { text: content }
  const parts = Array.isArray(content) ? content.map(object) : []
  return {
    text: parts
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join(''),
    toolCalls: parts
      .filter((part) => part.type === 'toolCall')
      .map((part) => ({
        ...scalars(part, ['id', 'name']),
        argumentKeys: Object.keys(object(part.arguments)).filter(
          (key) => !/thinking|sealed|provider|raw|error|signature/i.test(key),
        ),
      })),
    images: parts.flatMap((part, index) => (part.type === 'image' ? [{ index, ...scalars(part, ['mimeType']) }] : [])),
  }
}
function publicMessage(value: unknown): PublicRecord {
  const message = object(value)
  const metadata = {
    ...scalars(message, ['role', 'timestamp', 'completedAt', 'toolName', 'toolCallId', 'customType']),
    sourceEntry: scalars(object(message.sourceEntry), ['id', 'parentId', 'type', 'revision']),
  }
  if (message.role === 'custom' && message.display !== true) return { ...metadata, protected: true }
  if (!['user', 'assistant', 'toolResult', 'custom'].includes(String(message.role)))
    return { ...metadata, protected: true }
  if (message.isError === true || message.stopReason === 'error' || typeof message.errorMessage === 'string')
    return {
      ...metadata,
      state: 'error',
      error: { code: message.role === 'toolResult' ? 'tool-failed' : 'message-failed' },
      protected: true,
    }
  return { ...metadata, ...publicContent(message.content), ...scalars(message, ['stopReason']) }
}
function publicEntry(value: unknown): PublicRecord {
  const entry = object(value)
  const metadata = scalars(entry, ['id', 'parentId', 'type', 'timestamp'])
  if (entry.type === undefined && typeof entry.role === 'string') return { ...metadata, message: publicMessage(entry) }
  switch (entry.type) {
    case 'message':
      return { ...metadata, message: publicMessage(entry.message) }
    case 'custom_message':
      return entry.display === true
        ? { ...metadata, ...scalars(entry, ['customType', 'display']), ...publicContent(entry.content) }
        : { ...metadata, ...scalars(entry, ['customType']), protected: true }
    case 'compaction':
      return { ...metadata, ...scalars(entry, ['summary', 'firstKeptEntryId', 'tokensBefore', 'fromHook']) }
    case 'branch_summary':
      return { ...metadata, ...scalars(entry, ['summary', 'fromId', 'fromHook']) }
    case 'context_edit':
      return { ...metadata, ...scalars(entry, ['targetId']), omitted: entry.replacement === null, protected: true }
    case 'model_change':
      return { ...metadata, ...scalars(entry, ['provider', 'modelId']) }
    case 'thinking_level_change':
      return { ...metadata, ...scalars(entry, ['thinkingLevel']) }
    case 'session_info':
      return { ...metadata, ...scalars(entry, ['name']) }
    case 'label':
      return { ...metadata, ...scalars(entry, ['targetId', 'label']) }
    default:
      return { ...metadata, ...scalars(entry, ['customType']), protected: true }
  }
}
function publicEvents(values: readonly unknown[]): PublicRecord[] {
  return values.flatMap((value) => {
    const envelope = object(value)
    const event = object(envelope.event)
    const type = typeof event.type === 'string' ? event.type : 'unknown'
    const delta = object(event.assistantMessageEvent)
    if (/thinking|sealed/i.test(type) || /thinking|sealed/i.test(String(delta.type))) return []
    const metadata = scalars(envelope, [
      'generation',
      'executionGeneration',
      'sequence',
      'rootAgentId',
      'agentId',
      'runId',
    ])
    let projected: PublicRecord
    if (['message_start', 'message_update', 'message_end'].includes(type)) {
      projected = { type, message: publicMessage(event.message) }
      if (delta.type === 'text_delta' && typeof delta.delta === 'string')
        projected.delta = { type: 'text_delta', text: delta.delta }
    } else if (['tool_execution_start', 'tool_execution_update', 'tool_execution_end'].includes(type)) {
      projected = { type, ...scalars(event, ['toolCallId', 'toolName', 'isError']) }
      if (event.isError === true) projected.error = { code: 'tool-failed' }
      else if (type !== 'tool_execution_start')
        projected.result = publicContent(object(event.result ?? event.partialResult).content)
      if (type === 'tool_execution_start')
        projected.argumentKeys = Object.keys(object(event.args)).filter(
          (key) => !/thinking|sealed|provider|raw|error|signature/i.test(key),
        )
    } else if (type === 'compaction_end') {
      projected = { type, ...scalars(event, ['aborted', 'willRetry']) }
      if (event.error !== undefined || event.errorMessage !== undefined) projected.error = { code: 'compaction-failed' }
      else if (event.result !== undefined)
        projected.result = publicEntry({
          ...scalars(object(event.result), ['summary', 'firstKeptEntryId', 'tokensBefore']),
          type: 'compaction',
        })
    } else if (
      [
        'agent_start',
        'agent_end',
        'agent_settled',
        'turn_start',
        'turn_end',
        'compaction_start',
        'pause_update',
        'stop_update',
        'extension_ui_closed',
        'extension_ui_timeout',
      ].includes(type)
    ) {
      projected = {
        type,
        ...scalars(event, ['id', 'aborted', 'isPaused', 'queuePaused', 'stopped', 'revision', 'turnIndex']),
      }
    } else {
      projected = { type, protected: true }
    }
    return [{ ...metadata, event: projected }]
  })
}

export async function readSessionOperation(
  context: SessionReadContext,
  operation: string,
  args: unknown[],
): Promise<unknown> {
  const direct = operation === 'sessions.queue' || operation === 'sessions.stats'
  const hostScope = operation === 'sessions.query' || operation === 'sessions.search'
  const required = requiredFields[operation] ?? []
  if (
    !Array.isArray(args) ||
    args.length > (hostScope || direct ? 1 : 2) ||
    ((required.length > 0 || operation === 'agents.get') && args.length === 0)
  )
    throw new SystemReadError('invalid-input', '参数数量与读取操作定义不一致')
  const rawRef = args[direct ? 0 : 1] ?? { hostId: context.reader.hostId, sessionId: context.reader.sessionId }
  const reference = readRecord(rawRef, ['hostId', 'sessionId'], '会话目标')
  const ref = {
    hostId: readString(reference.hostId, 'Host ID', 128),
    sessionId: readString(reference.sessionId, '会话 ID', 128),
  }
  const session = context.session(ref)
  const query = operation === 'agents.get' || direct ? {} : readRecord(args[0], operationFields[operation] ?? [])
  if (required.some((field) => query[field] === undefined))
    throw new SystemReadError('invalid-input', '读取参数缺少必填字段')
  const binding = JSON.stringify([
    context.hostId,
    session.sessionId,
    operation,
    query.query,
    query.type,
    query.agentId,
    query.project,
    query.sessions,
  ])
  const page = <T>(items: readonly T[], revision?: string) => readPage(items, query as ReadQuery, binding, revision)
  if (operation === 'sessions.query' || operation === 'sessions.search') {
    const needle =
      operation === 'sessions.search'
        ? readString(query.query, '搜索词').toLocaleLowerCase()
        : query.query === undefined
          ? ''
          : readString(query.query, '查询词').toLocaleLowerCase()
    const project = query.project === undefined ? undefined : readRecord(query.project, ['hostId', 'projectId'])
    if (project && (project.hostId !== context.hostId || !readString(project.projectId, '项目 ID', 128)))
      throw new SystemReadError('invalid-input', '项目目标无效或属于其他 Host')
    let sessions = context.list().filter((item) => !project || item.project?.projectId === project.projectId)
    if (query.sessions !== undefined) {
      if (!Array.isArray(query.sessions) || query.sessions.length === 0 || query.sessions.length > 100)
        throw new SystemReadError('invalid-input', '每次最多搜索 100 个会话')
      const selected = query.sessions.map((item) => context.session(item as SessionRef).sessionId)
      sessions = sessions.filter((item) => selected.includes(item.sessionId))
    }
    if (operation === 'sessions.query')
      return page(sessions.filter((item) => `${item.name ?? ''} ${item.cwd}`.toLocaleLowerCase().includes(needle)))
    // Page the scan before loading bodies, so a single request has bounded disk work.
    const scan = readPage(
      sessions,
      query as ReadQuery,
      binding + JSON.stringify([project, query.sessions]),
      readRevision(sessions),
    )
    const results = await Promise.all(
      scan.items.map(async (item) => {
        try {
          const history = await context.history(item)
          const match = history.messages
            .map((message) => projectUiMessage(message, item))
            .find((message) => message?.text.toLocaleLowerCase().includes(needle))
          const position = match?.text.toLocaleLowerCase().indexOf(needle) ?? -1
          return match
            ? {
                session: item,
                entryId: match.ref?.entryId,
                excerpt: match.text.slice(Math.max(0, position - 80), position + needle.length + 160),
              }
            : undefined
        } catch {
          return { session: item, error: { code: 'history-unavailable' } }
        }
      }),
    )
    return {
      ...scan,
      items: results.filter((item) => item !== undefined),
      scanned: scan.items.length,
      totalScannedSessions: scan.total,
    }
  }
  if (operation === 'git.turnChangeSummaries') {
    if (!Array.isArray(query.entryIds) || query.entryIds.length === 0 || query.entryIds.length > 200)
      throw new SystemReadError('invalid-input', '每次最多读取 200 个轮次')
    return page(
      await context.turns(
        session,
        query.entryIds.map((id) => readString(id, '轮次 ID', 256)),
      ),
    )
  }
  if (operation === 'git.turnFile') {
    const result = await context.turnFile(
      session,
      readString(query.entryId, '轮次 ID', 256),
      readString(query.path, '文件路径', 4096),
    )
    const part = query.part ?? 'patch'
    if (!['patch', 'before', 'after'].includes(part as string))
      throw new SystemReadError('invalid-input', '差异部分无效')
    return {
      ...readText(result[part as 'patch' | 'before' | 'after'] ?? '', query as ReadQuery),
      notice: result.notice,
      part,
    }
  }
  const snapshot = await context.snapshot(session)
  const revision = snapshot.historyRevision ?? readRevision([snapshot.sessionEntries, snapshot.messages])
  if (operation === 'sessions.snapshot') {
    return {
      ...publicSnapshot(snapshot),
      revision,
      observedAt: new Date().toISOString(),
      dataOrigin: 'existing-runtime-or-history',
      totalMessages: snapshot.messages.length,
    }
  }
  if (operation === 'sessions.events') return page(publicEvents(snapshot.events ?? []))
  if (operation === 'sessions.stats')
    return {
      stats: publicStats(snapshot.stats),
      generation: publicGeneration(snapshot.state.generationMetrics),
      available: Boolean(snapshot.stats),
      observedAt: new Date().toISOString(),
    }
  if (operation === 'sessions.queue') {
    const history = await context.history(session)
    const queued = snapshot.events?.findLast((record) => record.event.type === 'queue_update')?.event
    const queue =
      queued?.type === 'queue_update'
        ? { steering: queued.steering, followUp: queued.followUp }
        : (history.taskControl ?? { steering: [], followUp: [] })
    return {
      ...queue,
      paused: snapshot.state.queuePaused,
      stopped: snapshot.state.stopped,
      revision: readRevision(queue),
    }
  }
  if (operation === 'sessions.interactions') return page(snapshot.pendingInteractions ?? [])
  if (operation === 'sessions.sources') {
    const history = await context.history(session)
    const queued = snapshot.events?.findLast((record) => record.event.type === 'queue_update')?.event
    const queue = queued?.type === 'queue_update' ? queued : history.taskControl
    return page(
      [
        ...(snapshot.branchAttachments ?? []).map(({ image, ...item }) => ({
          ...item,
          kind: 'attachment',
          image: image ? { mimeType: image.mimeType } : undefined,
        })),
        ...(history.skillUsages ?? []).map((item) => ({ ...item, kind: 'skill' })),
        ...[...(queue?.steering ?? []), ...(queue?.followUp ?? [])].map((item) => ({
          id: item.id,
          kind: 'queued',
          text: item.text,
          images: item.images?.map((image, index) => ({ index, mimeType: image.mimeType })),
        })),
      ],
      revision,
    )
  }
  if (operation.startsWith('agents.')) {
    const id =
      operation === 'agents.get'
        ? readString(args[0], 'Agent ID', 256)
        : query.agentId === undefined
          ? undefined
          : readString(query.agentId, 'Agent ID', 256)
    if (id && !snapshot.agents?.some((agent) => agent.agentId === id))
      throw new SystemReadError('permission-denied', 'Agent 不属于目标会话')
    if (operation === 'agents.mailbox')
      return page(
        (snapshot.agentMessages ?? []).filter(
          (message) => !id || message.toAgentId === id || message.fromAgentId === id,
        ),
      )
    if (!id) throw new SystemReadError('invalid-input', '必须提供 Agent ID')
    const agent = await context.agent(id)
    if (operation === 'agents.events') return page(publicEvents(agent.events ?? []))
    if (operation === 'agents.get')
      return {
        agent: publicAgent(agent.agent),
        stats: publicStats(agent.stats),
        pendingInteractionCount: agent.pendingInteractions?.length ?? 0,
        totalMessages: agent.messages.length,
        observedAt: new Date().toISOString(),
      }
    return page(
      agent.messages.flatMap((message) => {
        const projected = projectUiMessage(message, session)
        return projected ? [projected] : []
      }),
    )
  }
  if (operation === 'plans.history')
    return page(
      (snapshot.planCheckpoints ?? []).map(({ document, sourceEntryId }) => ({
        id: document.id,
        version: document.revision,
        title: document.title,
        updatedAt: document.updatedAt,
        sourceEntryId,
      })),
      revision,
    )
  if (operation === 'plans.get') {
    const id = readString(query.id, '计划 ID', 256)
    const version = readInteger(query.version, 1, Number.MAX_SAFE_INTEGER, 1)
    const plan = snapshot.planCheckpoints?.find(
      ({ document }) => document.id === id && document.revision === version,
    )?.document
    if (!plan) throw new SystemReadError('not-found', '当前分支不存在该计划版本')
    return { id, version, title: plan.title, ...readText(plan.markdown, query as ReadQuery) }
  }
  if (operation === 'sessions.tree')
    return {
      ...page(
        (snapshot.sessionEntries?.entries ?? []).filter(
          (entry) =>
            (!query.type || entry.type === query.type) &&
            (!query.query ||
              JSON.stringify(entry)
                .toLocaleLowerCase()
                .includes(readString(query.query, '查询词').toLocaleLowerCase())),
        ),
        revision,
      ),
      leafId: snapshot.sessionEntries?.leafId ?? null,
    }
  if (operation === 'sessions.entry') {
    const id = readString(query.entryId, '条目 ID', 256)
    const entry = snapshot.sessionEntries?.entries.find((item) => item.id === id)
    if (!entry) throw new SystemReadError('not-found', '条目不存在')
    const projected = {
      ...scalars(object(entry), ['id', 'parentId', 'type', 'timestamp']),
      ...publicEntry(await context.entry(session, id)),
    }
    return { entryId: id, ...readText(JSON.stringify(projected), query as ReadQuery, readRevision(projected)) }
  }
  if (operation === 'sessions.image') {
    const id = readString(query.entryId, '消息 ID', 256)
    const message = snapshot.messages.find((item) => item.sourceEntry?.id === id)
    const content = message && 'content' in message && Array.isArray(message.content) ? message.content : []
    const images = content.filter((item: unknown) =>
      Boolean(item && typeof item === 'object' && 'type' in item && item.type === 'image'),
    ) as { data?: string; mimeType?: string }[]
    const image = images[readInteger(query.index, 0, 1000)]
    if (
      !image?.data ||
      !image.mimeType ||
      !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(image.mimeType)
    )
      throw new SystemReadError('not-found', '消息内联图片不存在；路径附件请用 files.preview')
    if (image.data.length > 12 * 1024 * 1024) throw new SystemReadError('not-supported', '图片超过读取上限')
    return { type: 'image', data: image.data, mimeType: image.mimeType }
  }
  const messages = snapshot.messages.flatMap((message) => {
    const value = projectUiMessage(message, session)
    return value ? [value] : []
  })
  if (operation === 'sessions.message') {
    const id = readString(query.entryId, '消息 ID', 256)
    const message = messages.find((item) => item.ref?.entryId === id)
    if (!message) throw new SystemReadError('not-found', '消息不存在于当前分支')
    return {
      ...message,
      text: undefined,
      data: undefined,
      body: readText(JSON.stringify({ text: message.text, data: message.data }), query as ReadQuery, message.revision),
    }
  }
  if (operation === 'sessions.history') return page(messages, revision)
  throw new SystemReadError('not-supported', '会话读取操作不存在')
}
