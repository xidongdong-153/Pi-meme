import type { HostApi, SessionRef, MutationOptions } from '@pi-meme/contracts/app-host'
import type { SystemOperation, SystemToolRequest } from '@pi-meme/contracts/system-tools'
import type { TerminalService } from './terminal-service'

export type SystemOperationContext = {
  api: HostApi
  session: SessionRef
  terminal: TerminalService
  canWrite: boolean
  clientAvailable: (operation: string) => boolean
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
    operations.set(name, { definition: { name, description, parameters, write, scope }, run })
  }
  const { api, session } = context
  const target = (value: unknown) => {
    if (value === undefined || value === null) return session
    if (
      typeof value !== 'object' ||
      !('hostId' in value) ||
      value.hostId !== session.hostId ||
      !('sessionId' in value) ||
      typeof value.sessionId !== 'string'
    )
      throw new Error('会话目标无效')
    return value as SessionRef
  }
  const terminalRef = (id: unknown) => {
    if (typeof id !== 'string' || !context.terminal.entries().some((entry) => entry.terminalId === id))
      throw new Error('终端不存在')
    return { hostId: session.hostId, terminalId: id }
  }
  register('terminal.list', '列出当前 Host 的终端及其所属会话或项目', '[]', false, 'host', () =>
    context.terminal.entries(),
  )
  register(
    'terminal.read',
    '读取终端当前屏幕和保留的滚动输出，返回纯文本、输出序号和退出状态',
    '[terminalId]',
    false,
    'host',
    ([id]) => context.terminal.read(terminalRef(id)),
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
  register('projects.list', '列出当前 Host 的项目', '[]', false, 'host', () => api.projects.list())
  register('models.list', '列出可用模型，不包含凭据', '[]', false, 'host', () => api.models?.list())
  register('sessions.list', '列出当前 Host 会话', '[{project?: ProjectRef}?]', false, 'host', ([input]) =>
    api.sessions.list(input as Parameters<HostApi['sessions']['list']>[0]),
  )
  register('sessions.get', '读取会话身份与状态', '[SessionRef?]', false, 'session', ([ref]) =>
    api.sessions.get(target(ref)),
  )
  register(
    'sessions.messages',
    '分页读取会话可见消息',
    '[{offset?,limit?}?, SessionRef?]',
    false,
    'session',
    ([input, ref]) => api.sessions.messages(target(ref), input as Parameters<HostApi['sessions']['messages']>[1]),
  )
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
    register('images.list', '查询图像素材', '[{projectId?,query?,cursor?,limit?}?]', false, 'host', ([query]) =>
      api.imageLibrary!.list(query as Parameters<NonNullable<HostApi['imageLibrary']>['list']>[0]),
    )
    register('images.read', '读取素材 PNG', '[id]', false, 'host', ([id]) => api.imageLibrary!.read(id as string))
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
    api.files.list(target(ref), name as string | undefined),
  )
  register('files.read', '读取会话目录内的文本文件', '[relativePath,SessionRef?]', false, 'session', ([name, ref]) =>
    api.files.read(target(ref), name as string),
  )
  register(
    'files.preview',
    '读取文件预览和修订；修改前先读取修订',
    '[relativePath,SessionRef?]',
    false,
    'session',
    ([name, ref]) => api.files.preview(target(ref), name as string),
  )
  register('files.search', '搜索会话目录文件', '[{query,cursor?},SessionRef?]', false, 'session', ([input, ref]) =>
    api.files.search(target(ref), input as { query: string; cursor?: string }),
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
    api.git.diff(target(ref), input as Parameters<HostApi['git']['diff']>[1]),
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
    api.git.snapshot(target(ref)),
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
  return {
    async execute(request: SystemToolRequest) {
      if (
        !request ||
        typeof request.operation !== 'string' ||
        !Array.isArray(request.args) ||
        request.args.length > 8 ||
        typeof request.callId !== 'string' ||
        request.callId.length > 256
      )
        throw new Error('工作台操作参数无效')
      if (request.operation === 'capabilities' && !request.write)
        return {
          session,
          operations: [...operations.values()].map((value) => ({
            ...value.definition,
            available: value.definition.scope !== 'client' || context.clientAvailable(value.definition.name),
            allowed: !value.definition.write || context.canWrite,
          })),
        }
      const operation = operations.get(request.operation)
      if (!operation) throw new Error(`内置操作不存在：${request.operation}，请先读取 capabilities`)
      if (operation.definition.write !== request.write) throw new Error('请使用与操作读写性质一致的工具')
      if (request.write && !context.canWrite) throw new Error('工作台写操作需要普通模式和完全权限')
      return operation.run(request.args, { idempotencyKey: request.callId })
    },
  }
}
