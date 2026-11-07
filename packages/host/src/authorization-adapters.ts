import type {
  AuthorizationContext,
  AuthorizationEffect,
  AuthorizationOperation,
} from '@pi-meme/contracts/authorization'
import type { AppSession } from '@pi-meme/contracts/app-host'
import { assertExecutionRequirements, type ExecutionCapability } from '@pi-meme/contracts/execution-capabilities'
import { getGitExecutionCapabilityReport } from '@pi-meme/git/server/git-service'

const reads = new Set([
  'capabilities',
  'models.list',
  'contextWindow.list',
  'contextWindow.get',
  'contextWindow.item',
  'contextWindow.reply',
  'contextWindow.piece',
  'contextWindow.image',
  'visualizations.list',
  'visualizations.get',
  'imageLibrary.list',
  'imageLibrary.read',
  'imageGeneration.getConfig',
  'schedules.list',
  'schedules.get',
  'schedules.runs',
  'plugins.getDefaultAgentPlugins',
  'projects.list',
  'projects.get',
  'sessions.list',
  'sessions.get',
  'sessions.attention',
  'sessions.snapshot',
  'sessions.history',
  'sessions.messages',
  'sessions.message',
  'sessions.receipt',
  'sessions.submissions',
  'events.read',
  'events.subscribe',
  'files.list',
  'files.read',
  'files.preview',
  'files.search',
  'terminal.list',
  'terminal.attach',
  'git.availability',
  'git.turnChangeSummaries',
  'git.turnFile',
  'git.environment',
  'git.review',
  'git.reviewFile',
  'git.reviewOptions',
  'git.snapshot',
  'git.diff',
  'agents.list',
  'agents.get',
  'activities.list',
  'activities.logs',
  'goals.get',
  'plans.list',
])
const controls = new Set([
  'sessions.create',
  'sessions.submit',
  'sessions.stop',
  'sessions.stopTask',
  'sessions.pause',
  'sessions.resume',
  'sessions.cancelSubmission',
  'agents.stop',
  'interaction.respond',
])
const policy = new Set([
  'plugins.setDefaultAgentPlugins',
  'sessions.configure',
  'imageGeneration.saveModel',
  'imageGeneration.deleteModel',
  'imageGeneration.setDefault',
  'goals.edit',
])
const writes = new Set([
  'imageLibrary.rename',
  'imageLibrary.remove',
  'imageGeneration.test',
  'schedules.create',
  'schedules.update',
  'schedules.pause',
  'schedules.resume',
  'schedules.delete',
  'schedules.runNow',
  'schedules.stopRun',
  'schedules.markRead',
  'schedules.resetSession',
  'projects.register',
  'sessions.continueTask',
  'sessions.markRead',
  'terminal.open',
  'terminal.input',
  'terminal.resize',
  'terminal.close',
  'activities.stop',
  'goals.start',
  'goals.pause',
  'goals.resume',
  'goals.clear',
  'files.write',
  'git.undoTurn',
])
/** These user-facing APIs cannot inherit an Agent's current Goal budget and delegation ceiling. */
const independentExecution = new Set([
  'sessions.create',
  'sessions.submit',
  'sessions.resume',
  'sessions.continueTask',
  'goals.start',
  'goals.resume',
  'schedules.runNow',
  'schedules.create',
  'schedules.update',
  'schedules.resume',
  'schedules.resetSession',
])
const authorizedUserControls = new Set([
  'imageGeneration.test',
  'sessions.create',
  'sessions.submit',
  'sessions.resume',
  'sessions.continueTask',
  'goals.start',
  'goals.resume',
])
const repositoryGit = new Set([
  // availability currently executes rev-parse AND status; it is not a fixed version probe.
  'git.availability',
  'git.environment',
  'git.review',
  'git.reviewFile',
  'git.reviewOptions',
  'git.snapshot',
  'git.diff',
])
const repositoryGitRequirements: ExecutionCapability[] = ['host-secrets', 'process-tree', 'environment-isolation']
const filesystemReads = new Set([
  'files.list',
  'files.read',
  'files.preview',
  'files.search',
  'imageLibrary.read',
  'git.turnFile',
  'git.turnChangeSummaries',
  'plans.list',
])

/** Args describe logical resources only; the executing adapter must still canonicalize and enforce FD boundaries. */
export function apiAuthorizationOperation(
  method: string,
  context: AuthorizationContext,
  session?: AppSession,
  args: unknown[] = [],
): AuthorizationOperation {
  const actor = context.principal.kind !== 'user'
  const untrustedActor = ['agent', 'plugin', 'mcp'].includes(context.principal.kind)
  if (method === 'imageGeneration.test' && context.principal.kind !== 'user')
    throw new Error(
      'permission-denied: 模型配置测试只允许已认证用户直接发起；任务内生成图片请使用受当前任务预算约束的 image_gen',
    )
  if (untrustedActor && independentExecution.has(method))
    throw new Error(
      `permission-denied: ${method} 不能继承当前任务预算和委托上限。请从用户界面或 Host 调度器启动；Agent 子任务请使用原生 collaboration.spawn。`,
    )
  // The actual executor is an Owner node-pty shell with Host env, not the Worker's sandbox.
  if (actor && ['terminal.open', 'terminal.input', 'terminal.resize', 'terminal.close'].includes(method))
    throw new Error(
      'unsupported: Owner PTY 尚无 Agent 受控执行后端，非 User 不能创建、输入、调整或关闭用户终端；请由真实用户主动操作，不能借用 Worker 沙箱能力或 SessionRef 冒领终端所有权',
    )
  if (actor && repositoryGit.has(method))
    assertExecutionRequirements(getGitExecutionCapabilityReport(), repositoryGitRequirements)
  let resource = session ? `session:${session.sessionId}:${method}` : `host:${context.scope.hostId}:${method}`
  let boundary: AuthorizationEffect['boundary'] = 'host'
  const target = args[0]
  if (method.startsWith('files.') || repositoryGit.has(method)) {
    if (session) {
      resource = `session:${session.sessionId}:workspace:${method}`
      boundary = context.scope.sessionId === session.sessionId ? 'workspace' : 'external'
    } else if (target && typeof target === 'object' && 'projectId' in target && typeof target.projectId === 'string') {
      resource = `project:${target.projectId}:${method}`
      boundary = context.scope.projectId === target.projectId ? 'workspace' : 'external'
    } else {
      // Never label an unresolved file target as this task's writable workspace.
      boundary = 'external'
    }
    const input = args[1]
    const name =
      typeof input === 'string'
        ? input
        : input && typeof input === 'object'
          ? 'relativePath' in input
            ? input.relativePath
            : 'path' in input
              ? input.path
              : undefined
          : undefined
    if (typeof name === 'string') resource += `:${name}`
  }
  let kind: AuthorizationEffect['kind']
  if (filesystemReads.has(method) || repositoryGit.has(method)) kind = 'fs.read'
  else if (reads.has(method)) kind = 'process.read'
  else if (controls.has(method)) kind = 'process.write'
  else if (policy.has(method)) kind = 'policy.write'
  else if (writes.has(method)) {
    kind = method === 'files.write' || method === 'git.undoTurn' ? 'fs.write' : 'host.write'
    if (method === 'git.undoTurn' && session)
      boundary = context.scope.sessionId === session.sessionId ? 'workspace' : 'external'
    if (
      method.startsWith('terminal.') ||
      method === 'activities.stop' ||
      method === 'sessions.continueTask' ||
      method.startsWith('goals.')
    )
      kind = 'process.write'
  } else throw new Error(`permission-denied: HostApi 操作没有效果定义：${method}`)
  const effects: AuthorizationEffect[] = [{ kind, resource, boundary }]
  if (repositoryGit.has(method)) effects.push({ kind: 'process.read', resource: `${resource}:git`, boundary })
  if (method === 'imageGeneration.test') {
    // This sends an authenticated paid request and saves an artifact; it is not a config read/probe.
    effects.push({
      kind: 'network.write',
      resource: `image-model:${typeof args[0] === 'string' ? args[0] : 'unresolved'}:generate`,
      boundary: 'external',
    })
  }
  const externalSession = Boolean(session && context.scope.sessionId && session.sessionId !== context.scope.sessionId)
  const hostRead =
    untrustedActor &&
    !session &&
    reads.has(method) &&
    !['capabilities', 'models.list', 'plugins.getDefaultAgentPlugins'].includes(method)
  return {
    id: `api.${method}`,
    summary: `${method}${session ? ` · ${session.name ?? session.sessionId}` : ''}`,
    effects,
    localReadOnly: method === 'events.read' || method === 'events.subscribe' ? true : undefined,
    approvalRequired: externalSession || hostRead,
    requiredCapabilities: actor && repositoryGit.has(method) ? [...repositoryGitRequirements] : [],
  }
}

export function apiManagesPolicy(method: string) {
  return policy.has(method) || authorizedUserControls.has(method)
}

export function auditInput(args: unknown[]) {
  return args.map((arg) => (typeof arg === 'function' ? '[Host callback]' : arg))
}
