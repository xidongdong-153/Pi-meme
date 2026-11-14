import type { HostApi, ProjectRef, SessionRef, WorkspaceRef, MutationOptions } from '@pi-meme/contracts/app-host'
import type { SystemOperation, SystemToolRequest, SystemOperationAvailability } from '@pi-meme/contracts/system-tools'
import {
  readInteger,
  readPage,
  readRecord,
  readString,
  SystemReadError,
  validateReadArguments,
} from '@pi-meme/contracts/system-read'
import { systemClientReadDefinitions } from '@pi-meme/contracts/system-client-reads'
import { systemSessionReadDefinitions } from './session-read-operations'
import { systemSettingsReadDefinitions } from './system-settings-reads'
import { systemResourceReadDefinitions } from './system-resource-reads'
import type { SystemReadResults } from './system-read-results'
import { systemReadInputSchema } from './system-read-schemas'
import type { TerminalService } from './terminal-service'

export type SystemOperationContext = {
  api: HostApi
  session: SessionRef
  terminal: TerminalService
  canWrite: boolean
  identity: string
  results: SystemReadResults
  clientAvailable: (operation: string) => boolean
  clientUnavailableReason?: () => 'not-supported' | 'disconnected'
  client: (operation: string, args: unknown[]) => Promise<unknown>
  read: (operation: string, args: unknown[]) => Promise<unknown>
  write: (operation: string, args: unknown[]) => Promise<unknown>
}

/** 内置能力只在此显式登记；不接受 Agent 提供的 RPC 名称或对象路径。 */
export function createSystemOperations(context: SystemOperationContext) {
  const operations = new Map<
    string,
    { definition: SystemOperation; run: (args: unknown[], mutation: MutationOptions) => unknown }
  >()
  const register = (
    name: string,
    description: string,
    parameters: string,
    write: boolean,
    scope: SystemOperation['scope'],
    run: (args: unknown[], mutation: MutationOptions) => unknown,
  ) => {
    if (operations.has(name)) throw new Error(`重复的内置操作：${name}`)
    operations.set(name, {
      definition: {
        name,
        description,
        parameters,
        write,
        scope,
        domain: name.split('.')[0],
        ...(!write ? { inputSchema: systemReadInputSchema(name) } : {}),
      },
      run,
    })
  }
  const { api } = context
  const session: SessionRef = { hostId: context.session.hostId, sessionId: context.session.sessionId }
  const target = (value: unknown) => {
    if (value === undefined || value === null) return session
    if (
      typeof value !== 'object' ||
      !('hostId' in value) ||
      value.hostId !== session.hostId ||
      !('sessionId' in value) ||
      typeof value.sessionId !== 'string'
    )
      throw new SystemReadError('invalid-input', '会话目标无效')
    return value as SessionRef
  }
  const projectTarget = (value: unknown): ProjectRef => {
    if (
      !value ||
      typeof value !== 'object' ||
      !('hostId' in value) ||
      value.hostId !== session.hostId ||
      !('projectId' in value) ||
      typeof value.projectId !== 'string' ||
      !value.projectId
    )
      throw new SystemReadError('invalid-input', '项目目标无效，请从 projects.list 获取 ProjectRef')
    return { hostId: value.hostId, projectId: value.projectId }
  }
  const workspaceTarget = (value: unknown): WorkspaceRef =>
    value && typeof value === 'object' && 'projectId' in value ? projectTarget(value) : target(value)
  const explicitSessionTarget = (value: unknown): SessionRef => {
    if (value === undefined || value === null) throw new Error('此操作必须显式提供 SessionRef')
    return target(value)
  }
  const terminalRef = (id: unknown) => {
    if (typeof id !== 'string' || !context.terminal.entries().some((entry) => entry.terminalId === id))
      throw new Error('终端不存在')
    return { hostId: session.hostId, terminalId: id }
  }
  register(
    'terminal.list',
    '分页列出有权读取的终端元数据，不包含输出',
    '[{cursor?,offset?,limit?,revision?}?]',
    false,
    'host',
    (args) => context.read('terminal.list', args),
  )
  register(
    'terminal.read',
    '读取终端当前屏幕和保留的滚动输出，返回纯文本、输出序号和退出状态',
    '[terminalId]',
    false,
    'host',
    (args) => context.read('terminal.read', args),
  )
  register(
    'terminal.open',
    '在指定会话目录创建终端，缺省使用当前会话',
    '[{command?,cols?,rows?}, SessionRef?]',
    true,
    'session',
    ([input, ref], mutation) =>
      api.terminal.open(target(ref), (input ?? {}) as Parameters<HostApi['terminal']['open']>[1], mutation),
  )
  register(
    'terminal.input',
    '向终端写入文本；执行命令时包含换行',
    '[terminalId, text]',
    true,
    'host',
    ([id, text], mutation) => api.terminal.input(terminalRef(id), text as string, mutation),
  )
  register('terminal.resize', '调整终端尺寸', '[terminalId, {cols,rows}]', true, 'host', ([id, size], mutation) =>
    api.terminal.resize(terminalRef(id), size as { cols: number; rows: number }, mutation),
  )
  register('terminal.close', '关闭终端进程', '[terminalId]', true, 'host', ([id], mutation) =>
    api.terminal.close(terminalRef(id), mutation),
  )
  register('projects.list', '列出当前 Host 的项目及置顶状态', '[]', false, 'host', () => api.projects.list())
  register('projects.get', '读取指定项目', '[ProjectRef]', false, 'host', ([ref]) =>
    api.projects.get(projectTarget(ref)),
  )
  register(
    'projects.create',
    '将 Host 上已有的绝对目录登记为项目，可指定名称',
    '[{cwd,name?}]',
    true,
    'host',
    ([input], mutation) => api.projects.create(input as Parameters<HostApi['projects']['create']>[0], mutation),
  )
  register('projects.rename', '修改指定项目的名称', '[ProjectRef,name]', true, 'host', ([ref, name], mutation) =>
    api.projects.rename(projectTarget(ref), name as string, mutation),
  )
  register(
    'projects.setPinned',
    '设置指定项目的置顶状态，true 置顶、false 取消',
    '[ProjectRef,pinned]',
    true,
    'host',
    ([ref, pinned], mutation) => api.projects.setPinned(projectTarget(ref), pinned as boolean, mutation),
  )
  register(
    'projects.deletePreview',
    '读取项目删除范围、警告及清单修订；删除会清理项目所属会话，保留项目工作目录',
    '[ProjectRef]',
    false,
    'host',
    ([ref]) => api.projects.deletePreview(projectTarget(ref)),
  )
  register(
    'projects.delete',
    '按预览修订删除项目及所属会话，保留项目工作目录；不能删除当前执行所属项目',
    '[ProjectRef,{revision}]',
    true,
    'host',
    async ([ref, input], mutation) => {
      const project = projectTarget(ref)
      const current = await api.sessions.get(session)
      if (current.project?.projectId === project.projectId) throw new Error('不能在执行中删除当前会话所属项目')
      return api.projects.delete(project, input as { revision: string }, mutation)
    },
  )
  register('models.list', '列出已加载的可用模型目录，不初始化模型运行时', '[]', false, 'host', () => {
    if (!api.models) throw new SystemReadError('not-supported', '当前 Host 不支持模型目录')
    return api.models.list()
  })
  if (api.memory) {
    for (const [name, description, parameters] of [
      ['status', '读取当前 Host 记忆开关、预算与当前项目任务状态', '[]'],
      ['list', '列出当前项目与通用记忆摘要，关闭记忆时不返回正文', '[{query?,cursor?,limit?:1..20}?]'],
      ['search', '搜索当前项目与通用记忆，返回摘要及来源', '[{query,cursor?,limit?:1..20}]'],
      ['get', '读取当前项目或通用记忆全文及来源', '[memoryId]'],
    ]) {
      register(`memory.${name}`, description, parameters, false, 'session', (args) =>
        context.read(`memory.${name}`, args),
      )
    }
    for (const [name, description, parameters] of [
      [
        'remember',
        '响应用户明确的记住请求，手动保存并保护记忆；默认当前项目',
        '[{title,content,scope?:{kind:"global"}}]',
      ],
      ['update', '响应用户明确的纠正请求，修改指定记忆并保护用户内容', '[memoryId,{title,content,scope?},revision]'],
      ['forget', '响应用户明确的忘记请求，删除条目并排除关联旧来源', '[memoryId,revision]'],
    ]) {
      register(`memory.${name}`, description, parameters, true, 'session', (args) =>
        context.write(`memory.${name}`, args),
      )
    }
  }
  register('sessions.list', '列出当前 Host 会话', '[{project?: ProjectRef}?]', false, 'host', ([input]) =>
    api.sessions.list(input as Parameters<HostApi['sessions']['list']>[0]),
  )
  register(
    'sessions.create',
    '创建新聊天；指定 project 创建项目会话，省略则创建独立聊天；返回稳定 SessionRef，不切换界面',
    '[{project?:ProjectRef,name?,configuration?:{model?,thinkingLevel?,accessMode?,mode?,agentPlugins?}}]',
    true,
    'host',
    ([input], mutation) => api.sessions.create(input as Parameters<HostApi['sessions']['create']>[0], mutation),
  )
  register('sessions.rename', '修改会话名称', '[name,SessionRef?]', true, 'session', ([name, ref], mutation) =>
    api.sessions.rename(target(ref), name as string, mutation),
  )
  register(
    'sessions.setPinned',
    '设置会话置顶状态，true 置顶、false 取消',
    '[pinned,SessionRef?]',
    true,
    'session',
    ([pinned, ref], mutation) => api.sessions.setPinned(target(ref), pinned as boolean, mutation),
  )
  register(
    'sessions.configure',
    '编辑空闲会话的模型、思考等级、权限、任务模式或插件；权限变更与其他配置分开提交',
    '[{model?,thinkingLevel?,accessMode?,mode?,agentPlugins?},SessionRef]',
    true,
    'session',
    ([input, ref], mutation) =>
      api.sessions.configure(
        explicitSessionTarget(ref),
        input as Parameters<HostApi['sessions']['configure']>[1],
        mutation,
      ),
  )
  register(
    'sessions.delete',
    '删除指定会话及关联状态；不能删除当前执行会话',
    '[SessionRef]',
    true,
    'session',
    ([ref], mutation) => {
      const selected = explicitSessionTarget(ref)
      if (selected.sessionId === session.sessionId) throw new Error('不能在执行中删除当前会话')
      return api.sessions.delete(selected, mutation)
    },
  )
  register('sessions.get', '读取会话身份、配置、置顶与运行状态', '[SessionRef?]', false, 'session', ([ref]) =>
    api.sessions.get(target(ref)),
  )
  register('sessions.attention', '读取 Host 共享的会话查看状态', '[SessionRef?]', false, 'session', ([ref]) =>
    api.sessions.attention(target(ref)),
  )
  register(
    'sessions.markRead',
    '确认明确回复版本或交互请求已查看；不回答交互',
    '[{completionToken?,inputRequestIds?}, SessionRef?]',
    true,
    'session',
    ([observed, ref], mutation) =>
      api.sessions.markRead(target(ref), observed as Parameters<HostApi['sessions']['markRead']>[1], mutation),
  )
  register(
    'sessions.messages',
    '分页读取会话可见消息',
    '[{offset?,limit?,cursor?}?, SessionRef?]',
    false,
    'session',
    ([input, ref]) => api.sessions.messages(target(ref), input as Parameters<HostApi['sessions']['messages']>[1]),
  )
  if (api.contextWindow) {
    for (const name of ['list', 'get', 'item', 'reply', 'piece', 'image'] as const) {
      const parameters = {
        list: '[{cursor?,limit?:1..100,includeAuxiliary?}?,SessionRef?]',
        get: '[requestId,SessionRef?]',
        item: '[{requestId,payloadRevision?,kind,itemId?,offset?,limit?:1..100},SessionRef?]',
        reply: '[requestId,SessionRef?]',
        piece: '[{requestId,payloadRevision?,kind,itemId?,pieceIndex,offset?,limit?:1..20000},SessionRef?]',
        image: '[{requestId,payloadRevision?,kind,itemId?,pieceIndex},SessionRef?]',
      }
      register(
        `contextWindow.${name}`,
        name === 'list' || name === 'get'
          ? '读取实际模型请求的上下文摘要，不含正文；默认仅主请求'
          : name === 'piece'
            ? '显式分页读取上下文正文，每页最多20000字符且JSON文本不超过48KiB'
            : name === 'image'
              ? '显式读取上下文内联位图，不访问远程URL或文件路径'
              : '读取上下文项目或回复的元数据；正文需显式调用contextWindow.piece',
        parameters[name],
        false,
        'session',
        async ([input, ref]) => {
          const result = await (api.contextWindow![name] as (ref: SessionRef, query?: unknown) => unknown)(
            target(ref),
            input,
          )
          if (
            name === 'image' &&
            result &&
            typeof result === 'object' &&
            'src' in result &&
            typeof result.src === 'string'
          ) {
            const image = /^data:(image\/(?:png|jpe?g|gif|webp));base64,/.exec(result.src)
            if (image)
              return {
                type: 'image',
                mimeType: image[1] === 'image/jpg' ? 'image/jpeg' : image[1],
                data: result.src.slice(image[0].length),
              }
          }
          return result
        },
      )
    }
  }
  for (const name of ['list', 'get', 'runs'] as const) {
    const descriptions = { list: '列出定时任务', get: '读取定时任务', runs: '读取定时任务运行记录' }
    register(
      `schedules.${name}`,
      descriptions[name],
      name === 'list' ? '[]' : name === 'get' ? '[{hostId,taskId}]' : '[{hostId,taskId},{offset?,limit?}?]',
      false,
      'host',
      (args) => (api.schedules[name] as (...args: unknown[]) => unknown)(...args),
    )
  }
  for (const name of [
    'create',
    'update',
    'pause',
    'resume',
    'delete',
    'runNow',
    'stopRun',
    'markRead',
    'resetSession',
  ] as const) {
    const parameters =
      name === 'create'
        ? '[ScheduledTaskInput：{name,prompt,rule,configuration,...}]；先 schedules.get 参考已有任务，或 schedules.schema 读取结构'
        : name === 'update'
          ? '[{hostId,taskId}, ScheduledTaskInput]'
          : name === 'markRead'
            ? '[{hostId,taskId},runId]'
            : '[{hostId,taskId}]'
    register(`schedules.${name}`, `定时任务操作：${name}`, parameters, true, 'host', (args, mutation) =>
      (api.schedules[name] as (...args: unknown[]) => unknown)(...args, mutation),
    )
  }
  register('schedules.schema', '读取定时任务创建参数说明', '[]', false, 'host', () =>
    context.read('schedules.schema', []),
  )
  if (api.imageLibrary) {
    register(
      'images.list',
      '查询生成或上传的图像素材',
      '[{origin?:all|generated|uploaded,projectId?,query?,cursor?,limit?}?]，默认仅生成图',
      false,
      'host',
      ([query]) => api.imageLibrary!.list(query as Parameters<NonNullable<HostApi['imageLibrary']>['list']>[0]),
    )
    register('images.get', '读取图像素材信息', '[id]', false, 'host', ([id]) => api.imageLibrary!.get(id as string))
    register('images.read', '读取原始 MIME 的 PNG、JPEG 或 WebP 图像', '[id]', false, 'host', ([id]) =>
      api.imageLibrary!.read(id as string),
    )
    register(
      'images.import',
      '收录当前 Host 附件目录内已有图片',
      '[{path,name?}]，路径必须位于当前 Host 的 data/attachments 内',
      true,
      'host',
      ([input], mutation) =>
        api.imageLibrary!.import(input as Parameters<NonNullable<HostApi['imageLibrary']>['import']>[0], mutation),
    )
    register('images.rename', '重命名素材', '[id,name]', true, 'host', ([id, name], mutation) =>
      api.imageLibrary!.rename(id as string, name as string, mutation),
    )
    register('images.remove', '从素材库移除，不删除原始文件', '[id]', true, 'host', ([id], mutation) =>
      api.imageLibrary!.remove(id as string, mutation),
    )
  }
  for (const name of ['list', 'read'] as const)
    register(
      `visualizations.${name}`,
      '查询当前会话可访问的草图版本；创建或更新使用 save_visualization',
      name === 'list' ? '[SessionRef?]' : '[{id,revision},SessionRef?]',
      false,
      'session',
      ([input, ref]) =>
        name === 'list'
          ? api.visualizations?.list(target(input))
          : api.visualizations?.get(target(ref), input as { id: string; revision: number }),
    )
  register('files.list', '列出会话目录内的文件', '[relativePath?,SessionRef?]', false, 'session', ([name, ref]) =>
    api.files.list(workspaceTarget(ref), name as string | undefined),
  )
  register('files.read', '读取会话目录内的文本文件', '[relativePath,SessionRef?]', false, 'session', ([name, ref]) =>
    api.files.read(workspaceTarget(ref), name as string),
  )
  register(
    'files.preview',
    '读取文件预览和修订；修改前先读取修订',
    '[relativePath,SessionRef?]',
    false,
    'session',
    ([name, ref]) => api.files.preview(workspaceTarget(ref), name as string),
  )
  register('files.search', '搜索会话目录文件', '[{query,cursor?},SessionRef?]', false, 'session', ([input, ref]) =>
    api.files.search(workspaceTarget(ref), input as { query: string; cursor?: string }),
  )
  register(
    'files.write',
    '按修订写入会话目录文件',
    '[{relativePath,content,revision},SessionRef?]',
    true,
    'session',
    ([input, ref], mutation) =>
      api.files.write(target(ref), input as Parameters<HostApi['files']['write']>[1], mutation),
  )
  register('plans.list', '读取会话计划文档', '[SessionRef?]', false, 'session', ([ref]) => api.plans.list(target(ref)))
  register('git.diff', '读取指定文件差异', '[{path,staged?,kind?},SessionRef?]', false, 'session', ([input, ref]) =>
    api.git.diff(workspaceTarget(ref), input as Parameters<HostApi['git']['diff']>[1]),
  )
  register('plugins.defaults', '读取默认 Agent 插件选择', '[]', false, 'host', () =>
    api.plugins.getDefaultAgentPlugins(),
  )
  register(
    'plugins.setDefaults',
    '修改默认 Agent 插件选择；安装和权限仍由插件管理校验',
    '[pluginIds]',
    true,
    'host',
    ([ids], mutation) => api.plugins.setDefaultAgentPlugins(ids as string[], mutation),
  )
  register('git.snapshot', '读取会话仓库状态', '[SessionRef?]', false, 'session', ([ref]) =>
    api.git.snapshot(workspaceTarget(ref)),
  )
  if (api.git.availability)
    register(
      'git.availability',
      '轻量读取当前会话工作区与当前分支轮次是否有可查看变更，不含文件正文或差异',
      '[SessionRef?]',
      false,
      'session',
      ([ref]) => api.git.availability!(target(ref)),
    )
  register('activities.list', '列出会话启动的后台服务', '[SessionRef?]', false, 'session', ([ref]) =>
    api.activities.list(target(ref)),
  )
  register('activities.logs', '读取后台服务输出', '[serviceId,SessionRef?]', false, 'session', ([id, ref]) =>
    api.activities.logs(target(ref), id as string),
  )
  register('activities.stop', '停止后台服务', '[serviceId,SessionRef?]', true, 'session', ([id, ref], mutation) =>
    api.activities.stop(target(ref), id as string, mutation),
  )
  register('agents.list', '查询会话的子代理', '[SessionRef?]', false, 'session', ([ref]) =>
    api.agents.list(target(ref)),
  )
  register('goals.get', '读取会话目标', '[SessionRef?]', false, 'session', ([ref]) => api.goals.get(target(ref)))
  for (const [name, description, parameters] of [
    ['profile.get', '读取个人资料摘要和修订，头像通过 profile.avatar 单独读取', '[]'],
    ['profile.avatar', '读取 Host 个人头像图片', '[]'],
    ['usage.get', '读取 Host 用量统计', '[]'],
    ['mcp.get', '读取 MCP 配置状态，不包含环境变量、请求头和凭据', '[]'],
    ['instructions.get', '读取指令来源、正文和修订', '[]'],
    ['resources.list', '读取技能和指令资源目录', '[]'],
    ['commands.list', '读取当前会话可用指令', '[]'],
  ])
    register(name, description, parameters, false, 'host', (args) => context.read(name, args))
  for (const [name, description, parameters] of [
    ['profile.save', '修改 Host 个人资料', '[{name?,username?,email?,avatarText?,avatarData?},revision]'],
    ['mcp.save', '保存 MCP 配置，后续执行使用新配置', '[{name,previousName?,config,revision}]'],
    ['mcp.delete', '删除 MCP 配置', '[{name,revision}]'],
    [
      'instructions.save',
      '保存可编辑的 Host 指令，后续执行使用新版本',
      '[{kind:"agents"|"system"|"append-system",content:string|null,revision}]',
    ],
  ])
    register(name, description, parameters, true, 'host', (args) => context.write(name, args))
  for (const [name, description, parameters, write] of [
    ['appearance.get', '读取发起客户端的外观与修订', '[]', false],
    [
      'appearance.save',
      '修改发起客户端的外观',
      '[patch,revision]；patch 支持 mode:"light"|"dark"|"system"、uiSize、codeSize、reducedMotion',
      true,
    ],
    ['browser.list', '列出当前会话的 Desktop 网页', '[]', false],
    ['browser.read', '读取网页可见文字和可操作元素', '[tabId]', false],
    ['browser.screenshot', '截取网页', '[tabId]', false],
    ['browser.open', '在所属会话打开网页', '[url]', true],
    ['browser.navigate', '导航已有网页', '[tabId,url]', true],
    ['browser.click', '点击上次读取的元素', '[tabId,documentId,elementId]', true],
    ['browser.input', '填写上次读取的输入元素', '[tabId,documentId,elementId,text]', true],
    ['browser.scroll', '滚动网页', '[tabId,documentId,deltaY]', true],
    ['browser.close', '关闭所属会话的网页', '[tabId]', true],
  ] as const)
    register(name, description, parameters, write, 'client', (args) => context.client(name, args))
  register('host.capabilities', '读取执行 Host 的实际业务能力与 API 版本', '[]', false, 'host', () =>
    api.capabilities(),
  )
  register('sessions.receipt', '读取指定提交回执，不代表目标已经完成', '[operationId]', false, 'session', ([id]) =>
    api.sessions.receipt(readString(id, '提交操作标识', 256)),
  )
  register(
    'sessions.submissions',
    '分页读取会话提交回执，与原生输入队列分开',
    '[{cursor?,offset?,limit?,revision?}?,SessionRef?]',
    false,
    'session',
    async ([input, ref]) => {
      const selected = target(ref)
      const query = readRecord(input, ['cursor', 'offset', 'limit', 'revision'])
      return readPage(await api.sessions.submissions(selected), query, JSON.stringify(selected))
    },
  )
  register('events.read', '读取有权访问的有界事件与补读游标，不创建订阅', '[query?]', false, 'host', (args) =>
    context.read('events.read', args),
  )
  register('git.environment', '读取工作区本地 Git 分支与环境，不 fetch', '[WorkspaceRef?]', false, 'session', ([ref]) =>
    api.git.environment(workspaceTarget(ref)),
  )
  for (const name of ['review', 'reviewFile', 'reviewOptions'] as const)
    register(
      `git.${name}`,
      name === 'review'
        ? '读取指定 Git 范围的变更文件'
        : name === 'reviewFile'
          ? '读取 Git 文件前后内容及 patch'
          : '读取可查看的分支与提交选项',
      name === 'review'
        ? '[{scope,ref?},WorkspaceRef?]'
        : name === 'reviewFile'
          ? '[{query:{scope,ref?},path},WorkspaceRef?]'
          : '[{search?,offset?},WorkspaceRef?]',
      false,
      'session',
      ([input, ref]) => (api.git[name] as (ref: WorkspaceRef, input: unknown) => unknown)(workspaceTarget(ref), input),
    )
  register(
    'files.listPage',
    '分页枚举项目或会话目录，支持超过 10000 项的目录',
    '[{relativePath?,cursor?,offset?,limit?,revision?}?,WorkspaceRef?]',
    false,
    'session',
    (args) => context.read('files.listPage', args),
  )
  register(
    'files.readPiece',
    '按文件修订流式分片读取工作区 UTF-8 文本，offset/nextOffset 为 UTF-8 字节偏移，不限于 1 MiB 预览',
    '[{relativePath,offset?,limit?,revision?},WorkspaceRef?]',
    false,
    'session',
    (args) => context.read('files.readPiece', args),
  )
  register(
    'memory.sources',
    '分页读取当前项目或通用记忆的全部保留来源',
    '[memoryId,{cursor?,limit?,revision?}?]',
    false,
    'session',
    (args) => context.read('memory.sources', args),
  )
  for (const definition of [
    ...systemSessionReadDefinitions,
    ...systemSettingsReadDefinitions,
    ...systemResourceReadDefinitions,
    ...systemClientReadDefinitions,
  ]) {
    const existing = operations.get(definition.name)
    if (existing?.definition.write || definition.write) throw new Error(`读取目录包含写操作：${definition.name}`)
    operations.set(definition.name, {
      definition: { domain: definition.name.split('.')[0], ...definition },
      run: (args) =>
        definition.scope === 'client' ? context.client(definition.name, args) : context.read(definition.name, args),
    })
  }
  const availability = (definition: SystemOperation): SystemOperationAvailability => {
    const allowed = !definition.write || context.canWrite
    if (definition.scope === 'client' && !context.clientAvailable(definition.name))
      return { available: false, allowed, reason: context.clientUnavailableReason?.() ?? 'disconnected' }
    const supported = definition.name.startsWith('contextWindow.')
      ? Boolean(api.contextWindow)
      : definition.name.startsWith('visualizations.')
        ? Boolean(api.visualizations)
        : definition.name.startsWith('images.')
          ? Boolean(api.imageLibrary)
          : definition.name.startsWith('memory.')
            ? Boolean(api.memory)
            : definition.name === 'models.list'
              ? Boolean(api.models)
              : true
    return supported
      ? { available: true, allowed, ...(!allowed ? { reason: 'permission-denied' as const } : {}) }
      : { available: false, allowed, reason: 'not-supported' }
  }
  const invokeRead = async (name: string, args: unknown[]): Promise<unknown> => {
    const entry = operations.get(name)
    if (!entry || entry.definition.write)
      throw new SystemReadError('not-supported', '读取操作不存在，请先查询 capabilities')
    const state = availability(entry.definition)
    if (!state.available) throw new SystemReadError(state.reason ?? 'not-supported', '此读取能力在当前上下文不可用')
    validateReadArguments(entry.definition.inputSchema, args)
    return entry.run(args, { idempotencyKey: '' })
  }
  register(
    'results.read',
    '分片续读超出工具预算的完整 JSON 结果；每次重新校验原目标权限',
    '[{id,revision,offset?,limit?}]',
    false,
    'session',
    ([input]) => context.results.read(context.identity, input, invokeRead),
  )
  register(
    'capabilities.describe',
    '读取单项操作的参数、结果、范围与限制',
    '[operationName]',
    false,
    'host',
    ([name]) => {
      const entry = operations.get(readString(name, '操作名称', 128))
      if (!entry) throw new SystemReadError('not-supported', '操作不存在，请先查询 capabilities')
      return {
        ...entry.definition,
        inputSchema: entry.definition.inputSchema ?? {
          type: 'array',
          maxItems: 8,
          description: entry.definition.parameters,
        },
        outputSchema: entry.definition.outputSchema ?? {
          description: '保留原业务公共投影；超长结果使用 results.read 返回的 JSON 分片',
          oneOf: [
            { type: 'object' },
            { type: 'array' },
            { type: 'string' },
            { type: 'number' },
            { type: 'boolean' },
            { type: 'null' },
          ],
        },
        ...availability(entry.definition),
        limits: { textBytes: 48 * 1024, maxPageSize: 100, ...entry.definition.limits },
        continuation: {
          operation: 'results.read',
          parameters: '[{id,revision,offset?,limit?}]',
          retentionSeconds: 300,
        },
      }
    },
  )
  register(
    'capabilities',
    '分页读取当前执行可发现的操作目录与可用原因',
    '[{domain?,scope?,write?,query?,cursor?,offset?,limit?}?]',
    false,
    'host',
    ([input]) => {
      const query = readRecord(input, ['domain', 'scope', 'write', 'query', 'cursor', 'offset', 'limit'])
      if (query.write !== undefined && typeof query.write !== 'boolean')
        throw new SystemReadError('invalid-input', 'write 筛选必须是布尔值')
      if (query.scope !== undefined && !['host', 'session', 'client'].includes(query.scope as string))
        throw new SystemReadError('invalid-input', 'scope 筛选无效')
      const domain = query.domain === undefined ? undefined : readString(query.domain, '能力域', 128)
      const search = query.query === undefined ? '' : readString(query.query, '能力搜索词', 500).toLocaleLowerCase()
      const definitions = [...operations.values()]
        .map(({ definition }) => ({
          name: definition.name,
          description: definition.description,
          parameters: definition.parameters,
          write: definition.write,
          scope: definition.scope,
          domain: definition.domain,
          ...availability(definition),
        }))
        .filter(
          (definition) =>
            (!domain || definition.domain === domain) &&
            (!query.scope || definition.scope === query.scope) &&
            (query.write === undefined || definition.write === query.write) &&
            (!search || `${definition.name} ${definition.description}`.toLocaleLowerCase().includes(search)),
        )
      const page = readPage(
        definitions,
        { ...query, limit: readInteger(query.limit, 50, 100, 1) },
        JSON.stringify([session, domain, query.scope, query.write, search]),
      )
      return {
        session,
        operations: page.items,
        total: page.total,
        revision: page.revision,
        nextCursor: page.nextCursor,
        observedAt: page.observedAt,
      }
    },
  )
  return {
    async execute(request: SystemToolRequest) {
      if (
        !request ||
        typeof request.operation !== 'string' ||
        request.operation.length > 128 ||
        !Array.isArray(request.args) ||
        request.args.length > 8 ||
        typeof request.callId !== 'string' ||
        request.callId.length > 256
      )
        throw new SystemReadError('invalid-input', '工作台操作参数无效')
      const operation = operations.get(request.operation)
      if (!operation) throw new SystemReadError('not-supported', '操作不存在，请先查询 capabilities')
      if (operation.definition.write !== request.write)
        throw new SystemReadError('invalid-input', '请使用与操作读写性质一致的工具')
      if (request.write) {
        if (!context.canWrite) throw new SystemReadError('permission-denied', '工作台写操作需要普通模式和完全权限')
        return operation.run(request.args, { idempotencyKey: request.callId })
      }
      if (Buffer.byteLength(JSON.stringify(request.args)) > 64 * 1024)
        throw new SystemReadError('invalid-input', '读取参数超过 64 KiB，请缩小查询')
      try {
        const result = await invokeRead(request.operation, request.args)
        return context.results.capture(context.identity, request.operation, request.args, result)
      } catch (cause) {
        if (cause instanceof SystemReadError) throw cause
        const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : ''
        if (code === 'stale-cursor') throw new SystemReadError('stale-cursor', '数据或游标已变化，请重新读取')
        if (code === 'ENOENT') throw new SystemReadError('not-found', '目标不存在或已删除')
        if (code === 'EACCES' || code === 'EPERM') throw new SystemReadError('permission-denied', '没有读取目标的权限')
        throw new SystemReadError('internal-error', '读取失败；请核对目标、权限和参数，或查询对应域的诊断状态')
      }
    },
  }
}
