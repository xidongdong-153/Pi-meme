import { Buffer } from 'node:buffer'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AppHostCapabilities, MutationOptions } from '@pi-meme/contracts/app-host'
import type { Snapshot } from '@pi-meme/contracts/desktop'
import type { ScheduledTask } from '@pi-meme/contracts/schedules'
import { z } from 'zod'
import manifest from '../package.json' with { type: 'json' }
import { type HostRegistry, type HostContext, McpError, publicSession } from './hosts'

const id = z.string().min(1).max(128).regex(/^\S+$/)
const name = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .regex(/^[^\r\n]+$/)
const text = z
  .string()
  .min(1)
  .max(100000)
  .refine((value) => !!value.trim(), '正文不能为空')
const projectRef = z.object({ hostId: id, projectId: id }).strict()
const sessionRef = z.object({ hostId: id, sessionId: id }).strict()
const workspaceRef = z.union([projectRef, sessionRef])
const taskRef = z.object({ hostId: id, taskId: id }).strict()
const relativePath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.startsWith('\\') &&
      !/^[A-Za-z]:/.test(value) &&
      !value.includes('\0') &&
      !value.split(/[\\/]/).includes('..'),
    '路径必须在工作目录内，不能是绝对路径或包含 ..',
  )
const model = z.object({ provider: id, id: z.string().min(1).max(500) }).strict()
const thinkingLevel = z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const accessMode = z.enum(['read-only', 'workspace-write', 'full-access'])
const configuration = z
  .object({
    model: model.optional(),
    thinkingLevel: thinkingLevel.optional(),
    accessMode: accessMode.optional(),
    mode: z.enum(['default', 'plan']).optional(),
    agentPlugins: z.array(id).max(100).optional(),
  })
  .strict()
const mutation = { idempotencyKey: z.string().min(1).max(128).regex(/^\S+$/) }
const pagination = { offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(500).default(100) }
const query = z.string().max(500).optional()
const scheduleRule = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once'), at: z.iso.datetime({ offset: true }), timeZone: id }).strict(),
  z
    .object({
      kind: z.enum(['daily', 'weekdays', 'weekly']),
      time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
      timeZone: id,
      weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('interval'),
      every: z.number().int().min(1).max(525600),
      unit: z.enum(['minutes', 'hours']),
      anchor: z.iso.datetime({ offset: true }),
      timeZone: id,
    })
    .strict(),
])
const scheduleInput = z
  .object({
    name,
    prompt: text,
    project: projectRef.optional(),
    rule: scheduleRule,
    newSessionEachRun: z.boolean(),
    configuration: configuration.extend({ model, thinkingLevel, accessMode, agentPlugins: z.array(id).max(100) }),
    notification: z.enum(['all', 'failures', 'off']),
  })
  .strict()

type Feature = AppHostCapabilities['features'][number]
type ToolOptions = { write?: boolean; destructive?: boolean; feature?: Feature; registration?: boolean }

function options(input: { idempotencyKey: string }): MutationOptions {
  return { idempotencyKey: input.idempotencyKey }
}

function page<T>(items: T[], input: { offset: number; limit: number }) {
  const end = input.offset + input.limit
  return {
    items: items.slice(input.offset, end),
    total: items.length,
    nextOffset: end < items.length ? end : undefined,
  }
}

function deletion(result: { deletedPaths: string[]; deletedKeys: string[]; warnings?: string[]; errors: string[] }) {
  const { deletedPaths, deletedKeys, warnings, errors } = result
  return { deletedPaths, deletedKeys, warnings, errors }
}

function publicSchedule(task: ScheduledTask) {
  const {
    hostId,
    taskId,
    name,
    prompt,
    project,
    rule,
    newSessionEachRun,
    configuration,
    notification,
    status,
    createdAt,
    updatedAt,
    nextRunAt,
    error,
    unreadCount,
  } = task
  // 历史运行可能属于任务更新前的另一个项目；不把嵌套 lastRun/activeRun 或旧会话混入当前配置。
  return {
    hostId,
    taskId,
    name,
    prompt,
    project,
    rule,
    newSessionEachRun,
    configuration,
    notification,
    status,
    createdAt,
    updatedAt,
    nextRunAt,
    error,
    unreadCount,
  }
}

function publicStats(stats: Snapshot['stats']) {
  if (!stats) return undefined
  const { userMessages, assistantMessages, toolCalls, toolResults, totalMessages, tokens, cost, contextUsage } = stats
  return {
    userMessages,
    assistantMessages,
    toolCalls,
    toolResults,
    totalMessages,
    tokens: {
      input: tokens.input,
      output: tokens.output,
      cacheRead: tokens.cacheRead,
      cacheWrite: tokens.cacheWrite,
      total: tokens.total,
    },
    cost,
    contextUsage: contextUsage
      ? {
          tokens: contextUsage.tokens,
          contextWindow: contextUsage.contextWindow,
          percent: contextUsage.percent,
          estimated: contextUsage.estimated,
        }
      : undefined,
  }
}

function status(snapshot: Snapshot) {
  const state = snapshot.state
  return {
    state: {
      isStreaming: state.isStreaming,
      isCompacting: state.isCompacting,
      isPaused: state.isPaused,
      queuePaused: state.queuePaused,
      stopped: state.stopped,
      pendingMessageCount: state.pendingMessageCount,
      mode: state.mode,
      activeMode: state.activeMode,
      model: state.model,
      thinkingLevel: state.thinkingLevel,
      generationMetrics: state.generationMetrics,
      modelSelectionRequired: state.modelSelectionRequired,
    },
    goal: snapshot.goal,
    sessionAttention: snapshot.sessionAttention,
    stats: publicStats(snapshot.stats),
    interactions: snapshot.pendingInteractions?.map((item) => ({
      agentId: item.source.agentId,
      agentName: item.source.name,
      request: item.request,
    })),
  }
}

export function createMcpServer(registry: HostRegistry) {
  const server = new McpServer(
    { name: 'pi-meme', version: manifest.version },
    {
      maxToolInputElements: 10000,
      instructions:
        '先调用 pi_meme_hosts 和 pi_meme_capabilities。仅使用返回的稳定 ProjectRef/SessionRef；不要猜 ID、传 sessionKey 或临时 URL。' +
        '写操作使用调用方生成的稳定 idempotencyKey，同一操作重试保留原键，不同操作使用新键。' +
        '受理回执不代表完成，使用 sessions_receipt 与 sessions_messages 核对；超时不自动重放。' +
        '删除前向用户展示范围并获得确认。MCP 写权限与 Agent 会话 accessMode 是两个独立的权限。',
    },
  )

  function register<S extends z.ZodRawShape>(
    suffix: string,
    description: string,
    shape: S,
    run: (input: z.infer<z.ZodObject<S>>, context: HostContext) => unknown | Promise<unknown>,
    tool: ToolOptions = {},
  ) {
    if (tool.write && !registry.hasWrites) return
    if (tool.registration && !registry.hasRegistration) return
    const schema = z.object(shape)
    // 擦除 SDK 的 raw-shape 泛型推断，仍把 strict object 交给其运行时校验。
    const inputSchema: z.ZodType = z
      .object({
        ...shape,
        host: z
          .string()
          .regex(/^[a-z0-9][a-z0-9-]{0,47}$/)
          .optional(),
      })
      .strict()
    server.registerTool(
      `pi_meme_${suffix}`,
      {
        description,
        inputSchema,
        annotations: {
          readOnlyHint: !tool.write,
          destructiveHint: !!tool.destructive,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (args, extra) => {
        try {
          const host = (args as { host?: string }).host
          const value = await registry.run(host, !!tool.write, extra.signal, async (context) => {
            if (tool.feature && !context.capabilities.features.includes(tool.feature)) {
              throw new McpError('unsupported-capability', `Host 未提供 ${tool.feature} 能力，请升级或启用对应能力`)
            }
            const result = await run(schema.parse(args), context)
            return { host: context.configuration.name, hostId: context.capabilities.hostId, result: result ?? null }
          })
          const serialized = JSON.stringify(value)
          if (Buffer.byteLength(serialized) > 2 * 1024 * 1024) {
            throw new McpError('result-too-large', '结果超过 2 MiB；缩小分页或选择更小的读取范围')
          }
          return { content: [{ type: 'text' as const, text: serialized }], structuredContent: value }
        } catch (cause) {
          const error = registry.error(cause)
          return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error }) }] }
        }
      },
    )
  }

  server.registerTool(
    'pi_meme_hosts',
    {
      description:
        '列出服务所有者配置的 Host 名称与授权范围，不连接上游、不返回凭据。多个 Host 时其他工具必须显式传 host 名称。',
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    () => {
      const value = { hosts: registry.list() }
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }
    },
  )

  register('capabilities', '读取所选 Host 的真实身份、HostApi v2 能力及 MCP 授权范围。', {}, (_, ctx) => ({
    ...ctx.capabilities,
    allowWrites: ctx.configuration.allowWrites,
    allowProjectRegistration: ctx.configuration.allowProjectRegistration,
    projectIds: ctx.configuration.projectIds,
    allowStandaloneSessions: ctx.configuration.allowStandaloneSessions,
  }))
  register(
    'models_list',
    '列出 Host 可用模型的 provider/id 和能力；不读取 API Key 或模型连接配置。',
    {},
    (_, ctx) => ctx.client.models!.list(),
    { feature: 'models' },
  )

  register(
    'projects_list',
    '分页列出授权项目，返回稳定 ProjectRef；query 匹配名称或工作目录。',
    { ...pagination, query },
    async (input, ctx) => {
      const items = (await ctx.client.projects.list()).filter(
        (item) =>
          ctx.canAccessProject(item) &&
          (!input.query || `${item.name} ${item.cwd}`.toLowerCase().includes(input.query.toLowerCase())),
      )
      return page(items, input)
    },
    { feature: 'projects' },
  )
  register(
    'projects_get',
    '读取指定项目。',
    { project: projectRef },
    (input, ctx) => ctx.client.projects.get(ctx.project(input.project)),
    { feature: 'projects' },
  )
  register(
    'projects_delete_preview',
    '预览项目删除范围、会话数量和警告，取得 delete 所需 revision；本工具不删除。',
    { project: projectRef },
    (input, ctx) => ctx.client.projects.deletePreview(ctx.project(input.project)),
    { feature: 'project-management' },
  )
  register(
    'projects_create',
    '将 Host 上已有绝对目录登记为项目，不创建磁盘目录。需要额外 allowProjectRegistration 管理授权；应按授予整个目录树的读取、写入与 Agent 执行能力审慎开启。',
    { cwd: z.string().min(1).max(4096), name: name.optional(), ...mutation },
    (input, ctx) => {
      if (!ctx.configuration.allowProjectRegistration)
        throw new McpError('registration-disabled', '此 Host 未授权项目登记；请由所有者预先登记项目')
      return ctx.client.projects.create({ cwd: input.cwd, name: input.name }, options(input))
    },
    { write: true, feature: 'project-management', registration: true },
  )
  register(
    'projects_rename',
    '修改项目名称；1–500 字符的单行非空文本。',
    { project: projectRef, name, ...mutation },
    (input, ctx) => ctx.client.projects.rename(ctx.project(input.project), input.name, options(input)),
    { write: true, feature: 'project-management' },
  )
  register(
    'projects_set_pinned',
    '显式设置项目置顶状态。',
    { project: projectRef, pinned: z.boolean(), ...mutation },
    (input, ctx) => ctx.client.projects.setPinned(ctx.project(input.project), input.pinned, options(input)),
    { write: true, feature: 'project-management' },
  )
  register(
    'projects_delete',
    '删除项目记录和所属会话，保留工作目录。先展示 delete_preview 的范围并获用户确认；revision 过期时重新预览。检查返回 errors/warnings。',
    { project: projectRef, revision: id, confirm: z.literal(true), ...mutation },
    async (input, ctx) =>
      deletion(
        await ctx.client.projects.delete(ctx.project(input.project), { revision: input.revision }, options(input)),
      ),
    { write: true, destructive: true, feature: 'project-management' },
  )

  register(
    'sessions_list',
    '分页列出授权会话，可按 project 过滤；不切换工作台界面。',
    { project: projectRef.optional(), ...pagination, query },
    async (input, ctx) => {
      const project = input.project ? ctx.project(input.project) : undefined
      const sessions = await ctx.client.sessions.list(project ? { project } : undefined)
      return page(
        sessions
          .filter(
            (item) =>
              !item.temporary &&
              ctx.canAccessProject(item.project) &&
              (!input.query || `${item.name ?? ''} ${item.cwd}`.toLowerCase().includes(input.query.toLowerCase())),
          )
          .map(publicSession),
        input,
      )
    },
    { feature: 'sessions' },
  )
  register(
    'sessions_get',
    '读取稳定 SessionRef 的身份、配置和状态，不返回原始 JSONL 文件路径。',
    { session: sessionRef },
    async (input, ctx) => publicSession(await ctx.session(input.session)),
    { feature: 'sessions' },
  )
  register(
    'sessions_create',
    '创建新聊天但不发送消息或调用模型。传 project 创建项目内聊天；省略则创建独立聊天，受授权范围限制。',
    { project: projectRef.optional(), name: name.optional(), configuration: configuration.optional(), ...mutation },
    async (input, ctx) => {
      const project = input.project ? ctx.project(input.project) : undefined
      if (!project) ctx.standalone()
      return publicSession(
        await ctx.client.sessions.create(
          { project, name: input.name, configuration: input.configuration },
          options(input),
        ),
      )
    },
    { write: true, feature: 'sessions' },
  )
  register(
    'sessions_configure',
    '修改会话模型、思考等级、accessMode、mode 或已授权插件选择；运行中拒绝。实际权限/模式变化需与模型和插件变更分开调用。',
    {
      session: sessionRef,
      configuration: configuration.refine((value) => Object.keys(value).length > 0, '配置不能为空'),
      ...mutation,
    },
    async (input, ctx) => {
      await ctx.session(input.session)
      return publicSession(await ctx.client.sessions.configure(input.session, input.configuration, options(input)))
    },
    { write: true, feature: 'sessions' },
  )
  register(
    'sessions_rename',
    '修改会话名称，不修改历史正文。',
    { session: sessionRef, name, ...mutation },
    async (input, ctx) => {
      await ctx.session(input.session)
      return publicSession(await ctx.client.sessions.rename(input.session, input.name, options(input)))
    },
    { write: true, feature: 'session-management' },
  )
  register(
    'sessions_set_pinned',
    '显式设置会话置顶状态。',
    { session: sessionRef, pinned: z.boolean(), ...mutation },
    async (input, ctx) => {
      await ctx.session(input.session)
      return publicSession(await ctx.client.sessions.setPinned(input.session, input.pinned, options(input)))
    },
    { write: true, feature: 'session-management' },
  )
  register(
    'sessions_delete',
    '删除指定会话及关联资源。先获用户确认，调用方检查返回 errors/warnings。',
    { session: sessionRef, confirm: z.literal(true), ...mutation },
    async (input, ctx) => {
      await ctx.deletionTarget(input.session)
      return deletion(await ctx.client.sessions.delete(input.session, options(input)))
    },
    { write: true, destructive: true, feature: 'session-management' },
  )
  register(
    'sessions_snapshot',
    '读取会话运行状态、用量、目标、待回答交互和 controlCursor；正文用 sessions_messages 读取，不返回隐藏 thinking 或资源快照。',
    { session: sessionRef },
    async (input, ctx) => {
      const session = await ctx.session(input.session)
      const snapshot = await ctx.client.sessions.snapshot(input.session)
      return { session: publicSession(session), ...status(snapshot), controlCursor: snapshot.controlCursor }
    },
    { feature: 'sessions' },
  )
  register(
    'sessions_messages',
    '按 offset/limit 或 cursor 读取当前分支公共消息投影，不包含隐藏 thinking/图片 base64。分支变化出现 stale-cursor 时从首页重读。',
    {
      session: sessionRef,
      offset: z.number().int().min(0).optional(),
      limit: pagination.limit,
      cursor: z.string().min(1).max(4096).optional(),
    },
    async (input, ctx) => {
      await ctx.session(input.session)
      return ctx.client.sessions.messages(input.session, {
        offset: input.offset,
        limit: input.limit,
        cursor: input.cursor,
      })
    },
    { feature: 'messages' },
  )
  register(
    'sessions_message',
    '按返回的原生 entryId 读取单条公共消息；不要使用时间戳或数组下标。',
    { session: sessionRef, entryId: id },
    async (input, ctx) => {
      await ctx.session(input.session)
      return ctx.client.sessions.message(input.session, { entryId: input.entryId })
    },
    { feature: 'messages' },
  )
  register(
    'sessions_attention',
    '读取会话未读与待交互状态，不标记已读。',
    { session: sessionRef },
    async (input, ctx) => {
      await ctx.session(input.session)
      return ctx.client.sessions.attention(input.session)
    },
    { feature: 'session-attention' },
  )
  register(
    'sessions_submit',
    '发送文本任务，可能调用模型并产生费用。delivery=start 要求空闲，queue 入队，steer 插话要求运行中。只返回受理回执，需再读取 receipt/messages 判断结果；不自动重试。',
    {
      session: sessionRef,
      text,
      delivery: z.enum(['start', 'queue', 'steer']),
      mode: z.enum(['default', 'plan']).optional(),
      ...mutation,
    },
    async (input, ctx) => {
      await ctx.session(input.session)
      return ctx.client.sessions.submit(
        input.session,
        { text: input.text, delivery: input.delivery, mode: input.mode },
        options(input),
      )
    },
    { write: true, feature: 'sessions' },
  )
  register(
    'sessions_receipt',
    '按 operationId 查询提交状态。accepted/queued/running 不表示完成；失败、取消、中断及 outcomeUncertain 必须如实处理。',
    { operationId: id },
    (input, ctx) => ctx.receipt(input.operationId),
    { feature: 'sessions' },
  )
  register(
    'sessions_submissions',
    '列出指定会话的提交回执。',
    { session: sessionRef },
    async (input, ctx) => {
      await ctx.session(input.session)
      return ctx.client.sessions.submissions(input.session)
    },
    { feature: 'sessions' },
  )
  register(
    'sessions_control',
    '控制会话：stop 中断当前运行并撤销队列；stop_task 中断但保留队列；pause 暂停；resume 恢复后续调度。',
    { session: sessionRef, action: z.enum(['stop', 'stop_task', 'pause', 'resume']), ...mutation },
    async (input, ctx) => {
      await ctx.session(input.session)
      const method = input.action === 'stop_task' ? 'stopTask' : input.action
      await ctx.client.sessions[method](input.session, options(input))
      return { action: input.action }
    },
    { write: true, destructive: true, feature: 'sessions' },
  )
  register(
    'sessions_cancel_submission',
    '仅撤销尚未投递的排队提交；运行中的任务用 sessions_control 停止。',
    { operationId: id, ...mutation },
    async (input, ctx) => {
      await ctx.receipt(input.operationId)
      await ctx.client.sessions.cancelSubmission(input.operationId, options(input))
    },
    { write: true, destructive: true, feature: 'sessions' },
  )

  register(
    'files_list',
    '列出显式项目/会话工作目录内的文件；路径由 Host 校验，不能越界。',
    { workspace: workspaceRef, relativePath: relativePath.optional() },
    async (input, ctx) => ctx.client.files.list(await ctx.workspace(input.workspace), input.relativePath),
    { feature: 'files' },
  )
  register(
    'files_read',
    '读取工作目录内文本，支持时返回保存所需 revision；不内联图片。Host 拒绝越界、越界符号链接、非 UTF-8 及超限文件。',
    { workspace: workspaceRef, relativePath },
    async (input, ctx) => {
      const workspace = await ctx.workspace(input.workspace)
      if (!ctx.capabilities.fileOperations?.includes('preview'))
        return { ...(await ctx.client.files.read(workspace, input.relativePath)), readonly: true }
      const preview = await ctx.client.files.preview(workspace, input.relativePath)
      if (preview.kind === 'image')
        return { kind: preview.kind, relativePath: preview.relativePath, size: preview.size }
      return preview
    },
    { feature: 'files' },
  )
  register(
    'files_search',
    '按文件名搜索授权工作目录，cursor 用于继续分页。',
    { workspace: workspaceRef, query: z.string().min(1).max(500), cursor: z.string().min(1).max(4096).optional() },
    async (input, ctx) => {
      if (!ctx.capabilities.fileOperations?.includes('search'))
        throw new McpError('unsupported-capability', 'Host 不支持文件搜索')
      return ctx.client.files.search(await ctx.workspace(input.workspace), { query: input.query, cursor: input.cursor })
    },
    { feature: 'files' },
  )
  register(
    'files_write',
    '保存现有 UTF-8 文本文件，不新建文件。必须使用 files_read 返回的 revision；外部修改或越界时拒绝。',
    { workspace: workspaceRef, relativePath, content: z.string().max(1024 * 1024), revision: id, ...mutation },
    async (input, ctx) => {
      if (!ctx.capabilities.fileOperations?.includes('write'))
        throw new McpError('unsupported-capability', 'Host 不支持文件保存')
      return ctx.client.files.write(
        await ctx.workspace(input.workspace),
        { relativePath: input.relativePath, content: input.content, revision: input.revision },
        options(input),
      )
    },
    { write: true, feature: 'files' },
  )
  register(
    'git_snapshot',
    '读取显式工作目录的 Git 状态，不提交、推送或修改分支。',
    { workspace: workspaceRef },
    async (input, ctx) => ctx.client.git.snapshot(await ctx.workspace(input.workspace)),
    { feature: 'git' },
  )
  register(
    'git_diff',
    '读取单文件 Git diff，staged=true 查看暂存变更。',
    { workspace: workspaceRef, path: relativePath, staged: z.boolean().optional() },
    async (input, ctx) =>
      ctx.client.git.diff(await ctx.workspace(input.workspace), { path: input.path, staged: input.staged }),
    { feature: 'git' },
  )

  register(
    'agents_list',
    '列出指定会话的子 Agent、任务、报告和状态，不返回内部 sessionKey/JSONL 路径。',
    { session: sessionRef },
    async (input, ctx) => {
      await ctx.session(input.session)
      return (await ctx.client.agents.list(input.session)).map((agent) => ({
        agentId: agent.agentId,
        name: agent.name,
        taskPath: agent.taskPath,
        status: agent.status,
        task: agent.task,
        report: agent.report,
        error: agent.error,
        updatedAt: agent.updatedAt,
        cleanup: agent.cleanup,
      }))
    },
    { feature: 'agents' },
  )
  register(
    'agents_stop',
    '停止指定会话所属的子 Agent；拒绝跨会话 agentId。',
    { session: sessionRef, agentId: id, ...mutation },
    async (input, ctx) => {
      await ctx.agent(input.session, input.agentId)
      await ctx.client.agents.stop(input.agentId, options(input))
    },
    { write: true, destructive: true, feature: 'agents' },
  )
  register(
    'activities_list',
    '列出指定会话所属的 Agent 受管项目服务；运行状态不代表健康或应用就绪。',
    { session: sessionRef },
    async (input, ctx) => {
      await ctx.session(input.session)
      return ctx.client.activities.list(input.session)
    },
    { feature: 'activities' },
  )
  register(
    'activities_logs',
    '读取指定会话服务的有限日志尾部，检查 truncated。',
    { session: sessionRef, serviceId: id },
    async (input, ctx) => {
      await ctx.session(input.session)
      return ctx.client.activities.logs(input.session, input.serviceId)
    },
    { feature: 'activities' },
  )
  register(
    'activities_stop',
    '停止指定会话所属的受管服务，不接管任意 PID 或端口。',
    { session: sessionRef, serviceId: id, ...mutation },
    async (input, ctx) => {
      await ctx.session(input.session)
      return ctx.client.activities.stop(input.session, input.serviceId, options(input))
    },
    { write: true, destructive: true, feature: 'activities' },
  )
  register(
    'plans_list',
    '分页读取指定会话保存的计划正文。',
    { session: sessionRef, ...pagination },
    async (input, ctx) => {
      await ctx.session(input.session)
      return page(await ctx.client.plans.list(input.session), input)
    },
    { feature: 'plans' },
  )
  const answer = z.union([
    z.object({ value: z.string().max(100000) }).strict(),
    z.object({ confirmed: z.boolean() }).strict(),
    z.object({ cancelled: z.literal(true) }).strict(),
    z
      .object({
        answers: z
          .array(z.object({ id, value: z.string().max(100000).nullable() }).strict())
          .min(1)
          .max(3),
      })
      .strict(),
  ])
  register(
    'interaction_respond',
    '回答 sessions_snapshot 返回的真实交互 requestId；子 Agent 交互需要传其 agentId。跳过或取消不是批准。',
    { session: sessionRef, requestId: id, response: answer, agentId: id.optional(), ...mutation },
    async (input, ctx) => {
      await ctx.session(input.session)
      if (input.agentId) await ctx.agent(input.session, input.agentId)
      await ctx.client.interaction.respond(
        input.session,
        { requestId: input.requestId, response: input.response, agentId: input.agentId },
        options(input),
      )
    },
    { write: true, feature: 'interaction' },
  )

  register(
    'schedules_list',
    '分页列出授权范围内的定时任务。',
    { ...pagination },
    async (input, ctx) =>
      page(
        (await ctx.client.schedules.list()).filter((task) => ctx.canAccessProject(task.project)).map(publicSchedule),
        input,
      ),
    { feature: 'schedules' },
  )
  register(
    'schedules_get',
    '读取指定定时任务；运行记录另用 schedules_runs。',
    { task: taskRef },
    async (input, ctx) => publicSchedule(await ctx.task(input.task)),
    { feature: 'schedules' },
  )
  register(
    'schedules_runs',
    '分页读取授权范围内的定时任务运行记录；nextOffset 按 Host 原始页推进。',
    { task: taskRef, ...pagination },
    async (input, ctx) => {
      await ctx.task(input.task)
      const runs = await ctx.client.schedules.runs(input.task, { offset: input.offset, limit: input.limit })
      return {
        items: runs.filter((run) => ctx.canAccessProject(run.project)),
        nextOffset: runs.length === input.limit ? input.offset + input.limit : undefined,
      }
    },
    { feature: 'schedules' },
  )
  register(
    'schedules_create',
    '创建定时任务，后续会自动调用模型并可能产生费用。必须显式提供时间规则、模型、权限及通知策略。',
    { input: scheduleInput, ...mutation },
    async (input, ctx) => {
      if (input.input.project) ctx.project(input.input.project)
      else ctx.standalone()
      return publicSchedule(await ctx.client.schedules.create(input.input, options(input)))
    },
    { write: true, feature: 'schedules' },
  )
  register(
    'schedules_update',
    '替换定时任务配置；新旧项目都必须在授权范围内。',
    { task: taskRef, input: scheduleInput, ...mutation },
    async (input, ctx) => {
      await ctx.task(input.task)
      if (input.input.project) ctx.project(input.input.project)
      else ctx.standalone()
      return publicSchedule(await ctx.client.schedules.update(input.task, input.input, options(input)))
    },
    { write: true, feature: 'schedules' },
  )
  register(
    'schedules_control',
    '控制定时任务：pause/resume、run_now、stop_run、delete、reset_session。run_now 可能产生费用；delete/reset_session 须先获用户确认。',
    {
      task: taskRef,
      action: z.enum(['pause', 'resume', 'run_now', 'stop_run', 'delete', 'reset_session']),
      confirm: z.boolean().optional(),
      ...mutation,
    },
    async (input, ctx) => {
      if (input.action === 'delete') await ctx.deletionTarget(input.task)
      else await ctx.task(input.task)
      if (['delete', 'reset_session'].includes(input.action) && input.confirm !== true)
        throw new McpError('confirmation-required', '此操作必须先获用户确认并传 confirm=true')
      const methods = {
        pause: 'pause',
        resume: 'resume',
        run_now: 'runNow',
        stop_run: 'stopRun',
        delete: 'delete',
        reset_session: 'resetSession',
      } as const
      const result = await ctx.client.schedules[methods[input.action]](input.task, options(input))
      return result && 'taskId' in result ? ('rule' in result ? publicSchedule(result) : result) : result
    },
    { write: true, destructive: true, feature: 'schedules' },
  )

  register(
    'goals_get',
    '读取指定会话的持续目标；提交回执完成不表示持续目标完成。',
    { session: sessionRef },
    async (input, ctx) => {
      await ctx.session(input.session)
      return ctx.client.goals.get(input.session)
    },
    { feature: 'goals' },
  )
  register(
    'goals_start',
    '启动持续目标，可能多轮调用模型并产生费用；用 goals_get 跟踪目标状态。',
    { session: sessionRef, objective: text, ...mutation },
    async (input, ctx) => {
      await ctx.session(input.session)
      return ctx.client.goals.start(input.session, { objective: input.objective }, options(input))
    },
    { write: true, feature: 'goals' },
  )
  register(
    'goals_edit',
    '修改已停止目标的正文；必须使用 goals_get 返回的 goalId/revision。',
    { session: sessionRef, objective: text, goalId: id, revision: z.number().int().min(1), ...mutation },
    async (input, ctx) => {
      await ctx.session(input.session)
      return ctx.client.goals.edit(
        input.session,
        { objective: input.objective, goalId: input.goalId, revision: input.revision },
        options(input),
      )
    },
    { write: true, feature: 'goals' },
  )
  register(
    'goals_control',
    '暂停、恢复或清除目标；必须传 goalId/revision，clear 须先获用户确认。恢复可能产生费用。',
    {
      session: sessionRef,
      action: z.enum(['pause', 'resume', 'clear']),
      goalId: id,
      revision: z.number().int().min(1),
      confirm: z.boolean().optional(),
      ...mutation,
    },
    async (input, ctx) => {
      await ctx.session(input.session)
      if (input.action === 'clear' && input.confirm !== true)
        throw new McpError('confirmation-required', '清除目标必须先获用户确认并传 confirm=true')
      return ctx.client.goals[input.action](
        input.session,
        { goalId: input.goalId, revision: input.revision },
        options(input),
      )
    },
    { write: true, destructive: true, feature: 'goals' },
  )

  return server
}
