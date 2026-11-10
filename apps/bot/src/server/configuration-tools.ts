import { createHash, createHmac } from 'node:crypto'
import type {
  AppState,
  Conversation,
  HostConnection,
  ModelConfig,
  ModelSettings,
  QqConfig,
  Task,
} from '../shared/types.js'
import type { BotServices } from './contracts.js'
import { BotError, canonicalJson, requireItem, text } from './errors.js'
import { assertTaskAuthorized } from './task-interactions.js'
import { modelView } from './model-settings.js'

export interface ConfigurationTool {
  name: string
  description: string
  properties: Record<string, object>
  required: string[]
  execute: (args: Record<string, unknown>, task: Task, signal: AbortSignal, callId: string) => Promise<unknown>
}

interface ConfigurationContext {
  timezone: string
  qqDefaultBotId: string
  modelServiceId?: string
  model?: ModelConfig
  defaultModelId: string | null
  label: string
  resourceRevision?: number
  conversationFingerprint?: string
  confirmedConversationRevision?: number
  modelSettingsRevision: number
  qqRevision: number
}
type PreparedConfigurationTool = Omit<ConfigurationTool, 'execute'> & {
  execute: (
    args: Record<string, unknown>,
    task: Task,
    signal: AbortSignal,
    callId: string,
    context: ConfigurationContext,
  ) => Promise<unknown>
}
interface ConfigurationReceipt {
  context: ConfigurationContext
  completed: boolean
  value?: unknown
}

const string = { type: 'string', maxLength: 32000 }
const id = { type: 'string', minLength: 1, maxLength: 128 }
const boolean = { type: 'boolean' }
const list = { type: 'array', items: id, maxItems: 100 }
const choice = (...values: string[]) => ({ type: 'string', enum: values })
const resourceId = (value: unknown) => encodeURIComponent(text(value, '资源 ID', 128))
function fields(args: Record<string, unknown>, names: string[]) {
  return Object.fromEntries(names.filter((name) => args[name] !== undefined).map((name) => [name, args[name]]))
}

function stableId(taskId: string, callId: string, kind: string) {
  const hash = createHash('sha256').update(`${taskId}:${callId}:${kind}`).digest('hex')
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

function conversationFingerprint(conversation: Conversation) {
  const { revision: _revision, updatedAt: _updatedAt, sequence: _sequence, ...configuration } = conversation
  return createHash('sha256').update(canonicalJson(configuration)).digest('hex')
}

function configurationContext(
  name: string,
  args: Record<string, unknown>,
  task: Task,
  state: AppState,
): ConfigurationContext {
  const model = state.models[String(args.modelId)]
  if (name === 'configure_model') {
    if (args.modelId !== undefined) requireItem(model, '模型')
    if (args.action === 'save' && args.serviceId !== undefined)
      requireItem(state.modelServices[text(args.serviceId, '模型服务', 128)], '模型服务')
  }
  const targets: Record<string, { revision: number; name?: string; title?: string; url?: string } | undefined> = {
    configure_bot: state.bots[String(args.botId ?? task.botId)],
    configure_model: args.action === 'delete_service' ? state.modelServices[String(args.serviceId)] : model,
    configure_pi_meme: state.hosts[String(args.connectionId)],
    manage_group: state.conversations[String(args.conversationId ?? task.conversationId)],
    manage_memory: state.memories[String(args.memoryId)],
    manage_schedule: state.schedules[String(args.scheduleId)],
    manage_api_token: state.tokens[String(args.tokenId)],
  }
  const target = targets[name]
  if (['delete', 'delete_service', 'disconnect', 'archive', 'revoke'].includes(String(args.action)) && !target)
    throw new BotError(404, 'not-found', '要移除的配置不存在')
  return {
    timezone: state.settings.timezone,
    qqDefaultBotId: state.qq.defaultBotId || task.botId,
    modelServiceId: model?.serviceId,
    model: name === 'configure_model' && model ? modelView(state, model) : undefined,
    defaultModelId: state.modelSettings.defaultModelId,
    label: target?.name ?? target?.title ?? target?.url ?? '',
    resourceRevision: target?.revision,
    conversationFingerprint:
      name === 'manage_group' && target ? conversationFingerprint(target as Conversation) : undefined,
    modelSettingsRevision: state.modelSettings.revision,
    qqRevision: state.qq.revision,
  }
}

export function configurationTools(
  services: BotServices,
  confirm: (task: Task, callId: string, question: string, signal: AbortSignal) => Promise<boolean>,
): ConfigurationTool[] {
  const requestFor =
    (task: Task, signal: AbortSignal, callId: string) =>
    <T = unknown>(
      path: string,
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET',
      body?: Record<string, unknown>,
      step = 'main',
    ) =>
      services.configure({ taskId: task.id, signal, callId, path, method, body, step }) as Promise<T>
  const definitions: PreparedConfigurationTool[] = [
    {
      name: 'read_configuration',
      description: '读取 Bot 的全部可管理配置和稳定 ID。密钥只返回是否已配置。修改前用此工具读取当前状态。',
      properties: {
        section: choice(
          'all',
          'bots',
          'models',
          'pi_meme',
          'qq',
          'appearance',
          'web',
          'groups',
          'schedules',
          'memories',
          'tokens',
        ),
      },
      required: [],
      async execute(args, task, signal, callId) {
        const request = requestFor(task, signal, callId)
        const paths: Record<string, string> = {
          bots: '/bots',
          models: '/settings/models',
          pi_meme: '/hosts',
          qq: '/channels/qq',
          appearance: '/settings',
          web: '/settings',
          groups: '/conversations',
          schedules: '/schedules',
          memories: '/memories',
          tokens: '/tokens',
        }
        if (args.section && args.section !== 'all') {
          const path = paths[String(args.section)]
          if (!path) throw new BotError(400, 'invalid-input', '配置分类无效')
          return request(path)
        }
        const sections = ['bots', 'models', 'pi_meme', 'qq', 'appearance', 'groups', 'schedules', 'memories', 'tokens']
        const values = await Promise.all(sections.map(async (section) => [section, await request(paths[section])]))
        return { botId: task.botId, conversationId: task.conversationId, ...Object.fromEntries(values) }
      },
    },
    {
      name: 'configure_bot',
      description:
        '创建、修改、复制或删除 Bot。修改默认作用于自己，所有 Bot 自动具备配置管理和已连接服务的使用能力。角色与模型修改从下一轮生效。',
      properties: {
        action: choice('create', 'update', 'copy', 'delete'),
        botId: id,
        name: string,
        avatar: string,
        description: string,
        instructions: string,
        modelId: { anyOf: [id, { type: 'null' }] },
        enabled: boolean,
        maxToolCalls: { type: 'integer', minimum: 1, maximum: 128 },
      },
      required: ['action'],
      async execute(args, task, signal, callId, context) {
        const request = requestFor(task, signal, callId)
        const botId = resourceId(args.botId ?? task.botId)
        const body = fields(args, [
          'name',
          'avatar',
          'description',
          'instructions',
          'modelId',
          'enabled',
          'maxToolCalls',
        ])
        switch (args.action) {
          case 'create':
            return request('/bots', 'POST', body)
          case 'copy':
            return request(`/bots/${botId}/copy`, 'POST', {})
          case 'update':
            if (args.enabled === false) {
              if (!(await confirm(task, callId, `停用 ${context.label}？已接纳的任务会执行至结束。`, signal)))
                return { cancelled: true }
              body.runningTasks = 'finish'
            }
            return request(`/bots/${botId}`, 'PATCH', { ...body, revision: context.resourceRevision })
          case 'delete':
            if (!(await confirm(task, callId, `删除 ${context.label}？`, signal))) return { cancelled: true }
            return botId === task.botId
              ? request(`/tasks/${task.id}/completion-action`, 'POST', {
                  kind: 'delete-bot',
                  revision: context.resourceRevision,
                })
              : request(`/bots/${botId}`, 'DELETE', { revision: context.resourceRevision })
          default:
            throw new BotError(400, 'invalid-input', 'Bot 配置操作无效')
        }
      },
    },
    {
      name: 'configure_model',
      description:
        '管理模型与服务。save 保存并实际检查对话模型，makeDefault=true 时通过检查后切换默认模型。可复用 serviceId 添加模型，save_service 单独管理服务连接。模型失败会返回验证错误，默认模型在检查成功后切换。',
      properties: {
        action: choice('save', 'save_service', 'check', 'set_default', 'delete', 'delete_service'),
        modelId: id,
        serviceId: id,
        provider: choice('openai', 'openai-compatible', 'anthropic', 'google'),
        protocol: choice('openai-responses', 'openai-completions', 'anthropic-messages', 'google-generative-ai'),
        url: string,
        apiKey: { type: 'string', maxLength: 8000 },
        model: string,
        name: string,
        serviceName: string,
        kind: choice('text', 'image'),
        makeDefault: boolean,
        reasoning: boolean,
        contextWindow: { type: 'integer', minimum: 2048, maximum: 10000000 },
        maxTokens: { type: 'integer', minimum: 128, maximum: 1000000 },
      },
      required: ['action'],
      async execute(args, task, signal, callId, context) {
        const request = requestFor(task, signal, callId)
        if (args.action === 'delete' || args.action === 'delete_service') {
          const target = resourceId(args.action === 'delete' ? args.modelId : args.serviceId)
          if (
            !(await confirm(
              task,
              callId,
              `删除${args.action === 'delete' ? '模型' : '模型服务'} ${context.label}？`,
              signal,
            ))
          )
            return { cancelled: true }
          return args.action === 'delete'
            ? request(`/models/${target}`, 'DELETE', { revision: context.resourceRevision })
            : request('/settings/models', 'PATCH', {
                removedServiceIds: [target],
                revision: context.modelSettingsRevision,
              })
        }
        if (args.action === 'save_service') {
          if (
            args.apiKey === '' &&
            !(await confirm(task, callId, '撤销这个模型服务的密钥？使用它的 Bot 将需要重新连接模型。', signal))
          )
            return { cancelled: true }
          const serviceId = args.serviceId ?? stableId(task.id, callId, 'service')
          const connection = fields(args, ['provider', 'protocol', 'apiKey'])
          if (args.url !== undefined) connection.baseUrl = args.url
          if (args.serviceName !== undefined) connection.name = args.serviceName
          return request('/settings/models', 'PATCH', {
            revision: context.modelSettingsRevision,
            services: [{ id: serviceId, ...connection }],
          })
        }
        const modelId = args.modelId === undefined ? stableId(task.id, callId, 'model') : resourceId(args.modelId)
        let model = context.model
        let settingsRevision = context.modelSettingsRevision
        let defaultModelId = context.defaultModelId
        if (args.action === 'save') {
          if (
            args.apiKey === '' &&
            !(await confirm(task, callId, '撤销这个模型服务的密钥？使用它的 Bot 将需要重新连接模型。', signal))
          )
            return { cancelled: true }
          const serviceId = args.serviceId ?? context.modelServiceId ?? stableId(task.id, callId, 'service')
          const connection = fields(args, ['provider', 'protocol', 'apiKey'])
          if (args.url !== undefined) connection.baseUrl = args.url
          if (args.serviceName !== undefined) connection.name = args.serviceName
          const body: Record<string, unknown> = {
            revision: context.modelSettingsRevision,
            models: [
              {
                id: modelId,
                serviceId,
                ...fields(args, ['model', 'name', 'kind', 'contextWindow', 'maxTokens', 'reasoning']),
              },
            ],
          }
          if ((!model && args.serviceId === undefined) || Object.keys(connection).length)
            body.services = [{ id: serviceId, ...connection }]
          const settings = await request<ModelSettings>('/settings/models', 'PATCH', body, 'save')
          model = settings.models.find((item) => item.id === modelId)
          settingsRevision = settings.revision
          defaultModelId = settings.defaultModelId
        } else if (args.action !== 'check' && args.action !== 'set_default')
          throw new BotError(400, 'invalid-input', '模型配置操作无效')
        model = requireItem(model, '模型')
        if (model.kind === 'text' && (args.action === 'check' || model.verification?.status !== 'verified')) {
          const settings = await request<ModelSettings>(
            '/settings/models/check',
            'POST',
            { modelId, revision: settingsRevision },
            'check',
          )
          model = requireItem(
            settings.models.find((item) => item.id === modelId),
            '模型',
          )
          settingsRevision = settings.revision
          defaultModelId = settings.defaultModelId
        }
        if (args.action === 'set_default' || args.makeDefault === true) {
          if (model.kind !== 'text' || model.verification?.status !== 'verified')
            return { model, activated: false, error: model.verification?.error ?? '请选择已连通的对话模型' }
          const settings = await request<ModelSettings>(
            '/settings/models',
            'PATCH',
            { defaultModelId: modelId, revision: settingsRevision },
            'activate',
          )
          defaultModelId = settings.defaultModelId
        }
        return { model, defaultModelId }
      },
    },
    {
      name: 'configure_pi_meme',
      description:
        '用 URL 和密钥连接 Pi meme，保存后自动检查，所有 Bot 可访问所有项目及以后新增的项目。更新、检查或解除时传 connectionId。',
      properties: {
        action: choice('connect', 'update', 'check', 'disconnect'),
        connectionId: id,
        url: string,
        token: { type: 'string', maxLength: 8192 },
      },
      required: ['action'],
      async execute(args, task, signal, callId, context) {
        const request = requestFor(task, signal, callId)
        if (args.action === 'connect') return request<HostConnection>('/hosts', 'POST', fields(args, ['url', 'token']))
        const connectionId = resourceId(args.connectionId)
        if (args.action === 'update')
          return request(`/hosts/${connectionId}`, 'PATCH', {
            ...fields(args, ['url', 'token']),
            revision: context.resourceRevision,
          })
        if (args.action === 'check') return request(`/hosts/${connectionId}/check`, 'POST', {})
        if (args.action !== 'disconnect') throw new BotError(400, 'invalid-input', 'Pi meme 连接操作无效')
        if (!(await confirm(task, callId, `解除 ${context.label} 的连接？`, signal))) return { cancelled: true }
        return request(`/hosts/${connectionId}`, 'DELETE', { revision: context.resourceRevision })
      },
    },
    {
      name: 'read_pi_meme',
      description:
        '读取 Pi meme 的所有项目、会话、历史消息和项目文件。先列出项目取得 projectId。仅一条连接时可省略 connectionId。',
      properties: {
        connectionId: id,
        kind: choice('projects', 'sessions', 'session', 'messages', 'files', 'read_file', 'search_files', 'models'),
        projectId: id,
        sessionId: id,
        path: string,
        query: string,
        cursor: string,
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
      required: ['kind'],
      async execute(args, task, signal, callId) {
        const hosts = Object.values(services.store.read().hosts)
        const connectionId = resourceId(args.connectionId ?? (hosts.length === 1 ? hosts[0].id : undefined))
        const query = new URLSearchParams(
          Object.entries(
            fields(args, ['kind', 'projectId', 'sessionId', 'path', 'query', 'cursor', 'offset', 'limit']),
          ).map(([key, value]) => [key, String(value)]),
        )
        return requestFor(task, signal, callId)(`/hosts/${connectionId}/content?${query}`)
      },
    },
    {
      name: 'create_pi_meme_project',
      description: '在 Pi meme 中登记或创建项目，cwd 为该 Pi meme 所在机器的绝对目录。新项目立即可用。',
      properties: { connectionId: id, cwd: string, name: string },
      required: ['connectionId', 'cwd'],
      async execute(args, task, signal, callId) {
        return requestFor(task, signal, callId)(
          `/hosts/${resourceId(args.connectionId)}/projects`,
          'POST',
          fields(args, ['cwd', 'name']),
        )
      },
    },
    {
      name: 'configure_qq',
      description:
        '配置 QQ 官方机器人并自动连接。只需 AppID 和 AppSecret，默认由当前 Bot 接待。bind 生成绑定码，用户在 QQ 向机器人发送绑定码完成本人绑定。',
      properties: {
        action: choice('save', 'connect', 'bind', 'unbind'),
        appId: string,
        appSecret: { type: 'string', maxLength: 8192 },
        enabled: boolean,
        defaultBotId: id,
      },
      required: ['action'],
      async execute(args, task, signal, callId, context) {
        const request = requestFor(task, signal, callId)
        if (args.action === 'unbind' || args.enabled === false) {
          if (
            !(await confirm(
              task,
              callId,
              args.action === 'unbind' ? '解除 QQ 账号绑定？后续通知需要重新绑定。' : '停用 QQ 机器人？',
              signal,
            ))
          )
            return { cancelled: true }
        }
        if (args.action === 'unbind') return request('/channels/qq/binding', 'DELETE', { revision: context.qqRevision })
        if (args.action === 'bind') return request('/channels/qq/binding', 'POST', {})
        if (args.action === 'connect') return request('/channels/qq/connect', 'POST', {})
        if (args.action !== 'save') throw new BotError(400, 'invalid-input', 'QQ 配置操作无效')
        const config = await request<QqConfig>(
          '/channels/qq',
          'PATCH',
          {
            enabled: true,
            defaultBotId: context.qqDefaultBotId,
            revision: context.qqRevision,
            ...fields(args, ['appId', 'appSecret', 'enabled', 'defaultBotId']),
          },
          'save',
        )
        if (config.enabled && config.status !== 'offline' && !config.boundUserId)
          return { config, binding: await request('/channels/qq/binding', 'POST', {}, 'binding') }
        return config
      },
    },
    {
      name: 'configure_preferences',
      description:
        '设置外观、时区和公开网页访问。主题与减少动态效果会立即同步到所有已打开的 Bot 页面。allowedWebDomains 为空表示允许全部公开域名。',
      properties: {
        theme: choice('system', 'light', 'dark'),
        reducedMotion: boolean,
        timezone: string,
        webEnabled: boolean,
        allowedWebDomains: list,
      },
      required: [],
      async execute(args, task, signal, callId) {
        return requestFor(task, signal, callId)('/settings', 'PATCH', args)
      },
    },
    {
      name: 'manage_group',
      description: '创建或编辑群组，成员使用 Bot ID。archive 归档群组。',
      properties: {
        action: choice('create', 'update', 'archive'),
        conversationId: id,
        name: string,
        memberIds: list,
        coordinatorId: id,
        collaborationEnabled: boolean,
        pinned: boolean,
      },
      required: ['action'],
      async execute(args, task, signal, callId, context) {
        const request = requestFor(task, signal, callId)
        const body = fields(args, ['name', 'memberIds', 'coordinatorId', 'collaborationEnabled', 'pinned'])
        if (args.action === 'create') return request('/conversations', 'POST', { ...body, kind: 'group' })
        const conversationId = resourceId(args.conversationId ?? task.conversationId)
        if (args.action === 'update')
          return request(`/conversations/${conversationId}`, 'PATCH', { ...body, revision: context.resourceRevision })
        if (args.action !== 'archive') throw new BotError(400, 'invalid-input', '群组配置操作无效')
        if (!(await confirm(task, callId, `归档 ${context.label}？`, signal))) return { cancelled: true }
        let expectedRevision = context.resourceRevision
        if (conversationId === task.conversationId) {
          expectedRevision = await services.store.update((state) => {
            assertTaskAuthorized(state, requireItem(state.tasks[task.id], '任务'))
            signal.throwIfAborted()
            const receipt = state.operations[`configuration-tool:${task.id}:${callId}`].result as ConfigurationReceipt
            if (receipt.context.confirmedConversationRevision !== undefined)
              return receipt.context.confirmedConversationRevision
            const current = requireItem(state.conversations[conversationId], '会话')
            if (conversationFingerprint(current) !== context.conversationFingerprint)
              throw new BotError(409, 'revision-conflict', '确认期间会话配置已改变，请读取当前配置后重试')
            receipt.context.confirmedConversationRevision = current.revision
            return current.revision
          })
        }
        return conversationId === task.conversationId
          ? request(`/tasks/${task.id}/completion-action`, 'POST', {
              kind: 'archive-conversation',
              revision: expectedRevision,
            })
          : request(`/conversations/${conversationId}`, 'DELETE', { revision: context.resourceRevision })
      },
    },
    {
      name: 'manage_memory',
      description:
        '直接保存、修改或删除用户要求记住的信息。私聊默认当前 Bot，群聊默认当前群。可指定 owner 保存全局记忆。',
      properties: {
        action: choice('create', 'update', 'delete'),
        memoryId: id,
        title: string,
        content: string,
        scope: choice('owner', 'bot', 'conversation'),
        targetId: id,
      },
      required: ['action'],
      async execute(args, task, signal, callId, context) {
        const request = requestFor(task, signal, callId)
        const body = fields(args, ['title', 'content', 'scope', 'targetId'])
        if (args.action === 'create') {
          const conversation = requireItem(services.store.read().conversations[task.conversationId], '会话')
          const scope = args.scope ?? (conversation.kind === 'group' ? 'conversation' : 'bot')
          return request('/memories', 'POST', {
            ...body,
            scope,
            sourceMessageId: task.sourceMessageId,
            ...(scope === 'owner'
              ? {}
              : { targetId: args.targetId ?? (scope === 'bot' ? task.botId : task.conversationId) }),
          })
        }
        const memoryId = resourceId(args.memoryId)
        if (args.action === 'update')
          return request(`/memories/${memoryId}`, 'PATCH', { ...body, revision: context.resourceRevision })
        if (args.action !== 'delete') throw new BotError(400, 'invalid-input', '记忆配置操作无效')
        if (!(await confirm(task, callId, `删除记忆“${context.label}”？`, signal))) return { cancelled: true }
        return request(`/memories/${memoryId}`, 'DELETE', { revision: context.resourceRevision })
      },
    },
    {
      name: 'manage_schedule',
      description:
        '直接创建、修改、暂停、恢复或删除定时任务。默认当前会话、当前 Bot 和应用时区。once 的 at 使用带时区 ISO 时间，daily/weekly 使用 HH:mm，weekdays 为 0–6（周日为0）。',
      properties: {
        action: choice('create', 'update', 'pause', 'resume', 'delete'),
        scheduleId: id,
        name: string,
        prompt: string,
        conversationId: id,
        botId: id,
        enabled: boolean,
        kind: choice('once', 'daily', 'weekly'),
        timezone: string,
        at: string,
        time: string,
        weekdays: { type: 'array', maxItems: 7, items: { type: 'integer', minimum: 0, maximum: 6 } },
        notification: choice('web', 'qq'),
      },
      required: ['action'],
      async execute(args, task, signal, callId, context) {
        const request = requestFor(task, signal, callId)
        const body = fields(args, [
          'name',
          'prompt',
          'conversationId',
          'botId',
          'enabled',
          'kind',
          'timezone',
          'at',
          'time',
          'weekdays',
          'notification',
        ])
        if (args.action === 'create')
          return request('/schedules', 'POST', {
            conversationId: task.conversationId,
            botId: task.botId,
            timezone: context.timezone,
            notification: task.notification ?? 'web',
            kind: 'once',
            ...body,
          })
        const scheduleId = resourceId(args.scheduleId)
        if (args.action === 'update')
          return request(`/schedules/${scheduleId}`, 'PATCH', { ...body, revision: context.resourceRevision })
        if (args.action === 'pause' || args.action === 'resume')
          return request(`/schedules/${scheduleId}/${args.action}`, 'POST', { revision: context.resourceRevision })
        if (args.action !== 'delete') throw new BotError(400, 'invalid-input', '定时任务操作无效')
        if (!(await confirm(task, callId, `删除定时任务“${context.label}”？`, signal))) return { cancelled: true }
        return request(`/schedules/${scheduleId}`, 'DELETE', { revision: context.resourceRevision })
      },
    },
    {
      name: 'set_default_assistant',
      description: '设置打开 Bot 时默认接待的助理。',
      properties: { botId: id },
      required: ['botId'],
      async execute(args, task, signal, callId) {
        return requestFor(task, signal, callId)('/settings/models', 'PATCH', {
          defaultAssistantId: text(args.botId, 'Bot', 128),
        })
      },
    },
    {
      name: 'change_access_password',
      description: '修改 Bot 登录密码。需要当前密码与至少12字符的新密码，修改后用户用新密码重新登录。',
      properties: {
        currentPassword: { type: 'string', minLength: 12, maxLength: 256 },
        password: { type: 'string', minLength: 12, maxLength: 256 },
      },
      required: ['currentPassword', 'password'],
      async execute(args, task, signal, callId) {
        if (!(await confirm(task, callId, '修改 Bot 登录密码并退出已登录的页面？', signal))) return { cancelled: true }
        return requestFor(task, signal, callId)(
          '/settings/password',
          'POST',
          fields(args, ['currentPassword', 'password']),
        )
      },
    },
    {
      name: 'manage_api_token',
      description: '创建或撤销 Bot API 访问令牌。新令牌只返回一次，readOnly=false 允许写入。',
      properties: { action: choice('create', 'revoke'), name: string, tokenId: id, readOnly: boolean },
      required: ['action'],
      async execute(args, task, signal, callId, context) {
        const request = requestFor(task, signal, callId)
        if (args.action === 'create') {
          if (
            !(await confirm(
              task,
              callId,
              `创建${args.readOnly === false ? '可读写' : '只读'} API 令牌“${text(args.name, '名称', 80)}”？`,
              signal,
            ))
          )
            return { cancelled: true }
          return request('/tokens', 'POST', {
            name: args.name,
            scopes: args.readOnly === false ? ['read', 'write'] : ['read'],
          })
        }
        if (args.action !== 'revoke') throw new BotError(400, 'invalid-input', '访问令牌操作无效')
        const tokenId = resourceId(args.tokenId)
        if (!(await confirm(task, callId, `撤销 API 令牌“${context.label}”？`, signal))) return { cancelled: true }
        return request(`/tokens/${tokenId}`, 'DELETE', {})
      },
    },
  ]
  return definitions.map((definition) => ({
    ...definition,
    async execute(args, task, signal, callId) {
      if (definition.name.startsWith('read_'))
        return definition.execute(
          args,
          task,
          signal,
          callId,
          configurationContext(definition.name, args, task, services.store.read()),
        )
      const operationId = `configuration-tool:${task.id}:${callId}`
      const hash = createHmac('sha256', services.store.read().epoch)
        .update(canonicalJson({ name: definition.name, args }))
        .digest('hex')
      const receipt = await services.store.update((state) => {
        assertTaskAuthorized(state, requireItem(state.tasks[task.id], '任务'))
        signal.throwIfAborted()
        const previous = state.operations[operationId]
        if (previous) {
          if (previous.hash !== hash) throw new BotError(409, 'idempotency-conflict', '配置工具调用内容已经变化')
          return previous.result as ConfigurationReceipt
        }
        if (Object.keys(state.operations).length >= 100000)
          throw new BotError(507, 'storage-limit', '操作回执已达容量上限')
        const result: ConfigurationReceipt = {
          context: configurationContext(definition.name, args, task, state),
          completed: false,
        }
        state.operations[operationId] = { hash, result, createdAt: new Date().toISOString() }
        return result
      })
      if (receipt.completed) return receipt.value
      const value = await definition.execute(args, task, signal, callId, receipt.context)
      await services.store.update((state) => {
        const current = state.operations[operationId].result as ConfigurationReceipt
        state.operations[operationId].result = { ...current, completed: true, value }
      })
      return value
    },
  }))
}
