import type { GoalService } from '@pi-meme/goals/server/service'
import type { ActivityService } from '@pi-meme/activities/server/service'
import { isLiveServiceActivity } from '@pi-meme/contracts/service-activity'
import { isAgentAccessMode } from '@pi-meme/contracts/agent-access'
import {
  parseGoalCommand,
  validateGoalControl,
  type GoalControl,
  type GoalInput,
  type GoalStartResult,
} from '@pi-meme/contracts/goal'
import { skillMessageText } from '@pi-meme/contracts/skills'
import { messageOptions } from '@pi-meme/contracts/ipc'
import { thinkingLevels } from '@pi-meme/contracts/pi'
import { randomUUID, createHash } from 'node:crypto'
import path from 'node:path'
import { projectUiMessage } from '@pi-meme/contracts/plugin-ui-message'
import type {
  AppProject,
  AppSession,
  HostApi,
  HostControlRequest,
  HostControlResponse,
  SessionConfiguration,
  SessionRef,
  TerminalRef,
  ProjectRef,
  WorkspaceRef,
  SubmissionInput,
  SubmissionReceipt,
  MutationOptions,
} from '@pi-meme/contracts/app-host'
import type { HostEvent } from '@pi-meme/contracts/host'
import type { PiSessionPool, ClientView } from '@pi-meme/pi-runtime/session-pool'
import type { ProjectStore } from '@pi-meme/workspace/server/project-store'
import type { SessionService } from '@pi-meme/workspace/server/session-service'
import { readSessionHistory } from '@pi-meme/pi-runtime/session-history'
import { readTurnChanges, undoTurnChanges } from '@pi-meme/pi-runtime/turn-change-store'
import { getGitDiff, getGitEnvironment, getGitSnapshot } from '@pi-meme/git/server/git-service'
import type { CollaborationBridge } from '@pi-meme/contracts/collaboration'
import { ControlStore, ControlError, createControlStorePaths, type ControlStorePaths } from './control-store'

type Options = {
  models?: import('@pi-meme/contracts/model-config').ModelsReadonlyApi
  imageGeneration?: import('@pi-meme/contracts/image-generation').ImageGenerationApi
  schedules?: import('@pi-meme/schedules/server/service').ScheduleService
  goals: GoalService
  activities?: Pick<ActivityService, 'list' | 'logs' | 'stop'>
  hostId: string
  root: string
  controlPaths?: ControlStorePaths
  pi: PiSessionPool
  projects: ProjectStore
  sessions: SessionService
  collaboration: CollaborationBridge & {
    resolveSessionPlan?: (
      key: string,
      reference: import('@pi-meme/contracts/plan').PlanRef,
    ) => Promise<import('@pi-meme/contracts/plan').PlanDocument>
    goalReady: (key: string, completion?: boolean) => Promise<boolean>
    respondExtensionUI: (
      key: string,
      id: string,
      response: import('@pi-meme/contracts/pi').PiExtensionUIResponse,
    ) => Promise<unknown>
  }
  bindRoot: (key: string) => Promise<unknown>
  configureAgentPlugins: (key: string, ids: string[], input?: { restore?: boolean }) => Promise<void>
  defaultAgentPlugins: HostApi['plugins']
  snapshot: () => Promise<import('@pi-meme/contracts/desktop').Snapshot>
  workspace: { files: HostApi['files']; terminal: HostApi['terminal']; terminalSupported: boolean }
  withFileUndo?: (cwd: string, operation: () => Promise<void>) => Promise<void>
  isSessionClosing?: (session: AppSession) => boolean
  onError: (cause: unknown) => void
}
type Pending = { input: SubmissionInput; receipt: SubmissionReceipt; goal?: GoalControl }
type Active = { receipts: SubmissionReceipt[]; error?: string; cancelled?: boolean; runId?: string }
export async function createAppControl(options: Options) {
  const { hostId, pi, projects, sessions, collaboration, goals } = options
  const paths = options.controlPaths ?? createControlStorePaths(path.join(options.root, 'state/control'))
  const store = new ControlStore(paths, hostId)
  await store.init()
  const runtime = new Map<string, ClientView>()
  const runtimeBindings = new Map<string, Promise<AppSession>>()
  const rootAgents = new Map<string, string>()
  const restores = new Map<string, Promise<ClientView>>()
  const queues = new Map<string, Pending[]>()
  const active = new Map<string, Active>()
  const locks = new Map<string, Promise<unknown>>()
  const paused = new Set<string>()
  const jobs = new Set<Promise<unknown>>()
  const goalTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const goalNextConfiguration = new Map<string, import('@pi-meme/contracts/plan').MessageConfiguration>()
  const goalErrors = new Map<string, { source?: string; reason: string }>()
  let closing = false
  function track(job: Promise<unknown>) {
    jobs.add(job)
    void job.catch(options.onError).finally(() => jobs.delete(job))
  }
  function serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const pending = (locks.get(id) ?? Promise.resolve()).catch(() => {}).then(action)
    locks.set(id, pending)
    void pending
      .finally(() => {
        if (locks.get(id) === pending) locks.delete(id)
      })
      .catch(() => {})
    return pending
  }
  const assertHost = (ref: { hostId: string }) => {
    if (!ref || ref.hostId !== hostId) throw new Error('目标 Host 身份不匹配')
  }
  const getProject = (ref: ProjectRef) => {
    assertHost(ref)
    const project = store.state.projects.find((item) => item.projectId === ref.projectId)
    if (!project) throw new Error('项目不存在')
    return project
  }
  const getSession = (ref: SessionRef, callerClientId?: string) => {
    assertHost(ref)
    const session = store.state.sessions.find((item) => item.sessionId === ref.sessionId)
    if (!session) throw new Error('会话不存在')
    if (
      session.temporary &&
      session.ownerClientId &&
      callerClientId &&
      callerClientId !== 'host-internal' &&
      session.ownerClientId !== callerClientId
    ) {
      throw new Error('无权访问其他窗口的临时会话')
    }
    if (callerClientId !== 'host-internal' && options.isSessionClosing?.(session)) {
      throw new Error('临时会话正在关闭，操作未执行')
    }
    return session
  }
  const assertActivityAccess = (ref: SessionRef, mode: unknown) => {
    if (!isAgentAccessMode(mode)) throw new Error('会话权限无效')
    const rank = { 'read-only': 0, 'workspace-write': 1, 'full-access': 2 }
    const activities = options.activities?.list(ref).activities ?? []
    if (activities.some((activity) => isLiveServiceActivity(activity) && rank[activity.accessMode] > rank[mode]))
      throw new Error('仍有更高权限的项目服务运行，请先在活动面板停止，再降低权限')
  }
  const projectFor = async (cwd: string): Promise<AppProject | undefined> => {
    const source = projects.sourceProjectCwd(cwd) ?? cwd
    if (projects.kind(source) !== 'project') return
    let project = store.state.projects.find((item) => item.cwd === source)
    if (!project) {
      const registered = (await projects.get?.(source)) ?? (await projects.list([source]))[0]
      if (!registered) return
      project = store.state.projects.find((item) => item.cwd === source)
      if (project) return project
      project = {
        hostId,
        projectId: randomUUID(),
        cwd: source,
        name: registered.name,
        unavailable: registered.unavailable,
      }
      await store.saveProject(project)
    }
    return project
  }
  const sync = async (session: AppSession, view: ClientView, persist = true) => {
    const context = pi.readSessionBinding(view.sessionKey!)
    const nextFile = context.sessionFile ?? session.sessionFile
    const nextConfig = {
      ...session.configuration,
      model: context.state.model,
      thinkingLevel: context.state.thinkingLevel,
      accessMode: context.accessMode,
      mode: context.state.mode,
    }
    const nextName = context.state.sessionName ?? session.name
    const changed =
      session.sessionFile !== nextFile ||
      session.name !== nextName ||
      session.configuration.model?.provider !== nextConfig.model?.provider ||
      session.configuration.model?.id !== nextConfig.model?.id ||
      session.configuration.thinkingLevel !== nextConfig.thinkingLevel ||
      session.configuration.accessMode !== nextConfig.accessMode ||
      session.configuration.mode !== nextConfig.mode
    session.sessionFile = nextFile
    session.configuration = nextConfig
    session.name = nextName
    if (persist && changed) await store.saveSession(session)
  }
  const busy = (key: string) => Boolean(pi.getRuntimeSessions().find((item) => item.id === key)?.running)
  const configure = async (session: AppSession, view: ClientView, config: SessionConfiguration, restore = false) => {
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('会话配置无效')
    if (config.mode !== undefined && config.mode !== 'default' && config.mode !== 'plan')
      throw new Error('会话模式无效')
    if (config.thinkingLevel !== undefined && !thinkingLevels.includes(config.thinkingLevel))
      throw new Error('思考强度无效')
    if (
      config.model !== undefined &&
      (!config.model ||
        typeof config.model.provider !== 'string' ||
        !config.model.provider ||
        typeof config.model.id !== 'string' ||
        !config.model.id)
    )
      throw new Error('模型标识无效')
    const key = view.sessionKey!
    if (config.mode === 'plan' && goals.get(session)?.status === 'active') {
      await goals.stop(session, 'paused', '进入规划模式，目标已暂停')
      paused.add(session.sessionId)
      for (const pending of queues.get(session.sessionId) ?? []) {
        pending.receipt.status = 'cancelled'
        await publishReceipt(session, pending.receipt)
      }
      queues.delete(session.sessionId)
      const run = active.get(session.sessionId)
      if (run) run.cancelled = true
      await pi.abort(key)
      if (run) await finish(session, view, run, true)
    }
    if (active.has(session.sessionId) || busy(key)) throw new Error('会话正在运行，不能修改配置')
    if (config.agentPlugins !== undefined) await options.configureAgentPlugins(key, config.agentPlugins, { restore })
    if (config.mode !== undefined) await pi.setSessionMode(key, config.mode)
    if (config.accessMode !== undefined) {
      assertActivityAccess(session, config.accessMode)
      await pi.setAccessMode(key, config.accessMode)
    }
    if (config.model !== undefined) await pi.setModel(key, config.model)
    if (config.thinkingLevel !== undefined) await pi.setThinkingLevel(key, config.thinkingLevel)
    session.configuration = { ...session.configuration, ...config }
    await sync(session, view)
    return structuredClone(session)
  }
  const resolveSession = async (ref: SessionRef, restore = true): Promise<ClientView> => {
    const session = getSession(ref)
    const current = runtime.get(session.sessionId)
    if (current) {
      try {
        pi.getSessionContext(current.sessionKey!)
        return current
      } catch {
        runtime.delete(session.sessionId)
      }
    }
    if (restores.has(session.sessionId)) return restores.get(session.sessionId)!
    const pending = (async () => {
      const view = pi.createClientView()
      view.clientId = `control:${session.sessionId}`
      try {
        await pi.withClientView(view, async () => {
          if (session.sessionFile) {
            const selected = await pi.switchSession(session.sessionFile)
            if (selected.cancelled) throw new Error('会话恢复已取消')
          } else pi.initializeClient(session.cwd)
          runtime.set(session.sessionId, view)
          await configure(session, view, session.configuration, restore)
        })
        return view
      } catch (cause) {
        runtime.delete(session.sessionId)
        pi.releaseClientView(view)
        throw cause
      }
    })()
    restores.set(session.sessionId, pending)
    try {
      return await pending
    } finally {
      restores.delete(session.sessionId)
    }
  }
  const target = async <T>(
    ref: SessionRef,
    action: (key: string, session: AppSession, view: ClientView) => Promise<T>,
    callerClientId?: string,
  ): Promise<T> => {
    const session = getSession(ref, callerClientId)
    const view = await resolveSession(session)
    getSession(ref, callerClientId)
    return pi.withClientView(view, () => action(view.sessionKey!, session, view))
  }
  const resolveRoot = async (ref: WorkspaceRef, callerClientId?: string) => {
    assertHost(ref)
    return 'projectId' in ref ? getProject(ref).cwd : getSession(ref, callerClientId).cwd
  }
  const assertSessionAccess = (ref: WorkspaceRef, callerClientId?: string) => {
    if (ref && typeof ref === 'object' && 'sessionId' in ref) {
      getSession(ref as SessionRef, callerClientId)
    }
  }
  const terminalRoots = new Map<string, WorkspaceRef>()
  const assertTerminalAccess = (ref: TerminalRef, callerClientId?: string) => {
    const root = terminalRoots.get(ref.terminalId)
    if (root) assertSessionAccess(root, callerClientId)
  }
  const refresh = async () => {
    const saved = await sessions.getSnapshot()
    const summaries = [
      ...new Map(
        [
          ...saved.projects.flatMap((group) => group.sessions),
          ...(saved.standaloneSessions ?? []),
          ...saved.recents,
          ...pi.getRuntimeSessions().filter((item) => !(item as { temporary?: boolean }).temporary),
        ].map((summary) => [summary.path, summary]),
      ).values(),
    ].filter((summary) => !(summary as { temporary?: boolean }).temporary)
    for (const registered of await projects.list(summaries.map((item) => item.cwd))) {
      const project = await projectFor(registered.cwd)
      if (project && (project.name !== registered.name || project.unavailable !== registered.unavailable)) {
        Object.assign(project, { name: registered.name, unavailable: registered.unavailable })
        await store.saveProject(project)
      }
    }
    for (const summary of summaries) {
      let session = store.state.sessions.find(
        (item) => item.sessionFile === summary.path || runtime.get(item.sessionId)?.sessionKey === summary.id,
      )
      if (!session) {
        const project = await projectFor(summary.cwd)
        const agentPlugins = await options.defaultAgentPlugins.getDefaultAgentPlugins()
        session = store.state.sessions.find(
          (item) => item.sessionFile === summary.path || runtime.get(item.sessionId)?.sessionKey === summary.id,
        )
        if (!session) {
          session = {
            hostId,
            sessionId: randomUUID(),
            project: project && { hostId, projectId: project.projectId },
            cwd: summary.cwd,
            createdAt: summary.created,
            name: summary.name,
            configuration: { agentPlugins },
            status: summary.running ? 'running' : 'idle',
          }
          if (!summary.path.startsWith('runtime:')) session.sessionFile = summary.path
          await store.saveSession(session)
        }
      }
      if (!summary.path.startsWith('runtime:') && session.sessionFile !== summary.path) {
        session.sessionFile = summary.path
        await store.saveSession(session)
      }
      if (!runtime.has(session.sessionId)) {
        try {
          pi.getSessionContext(summary.id)
          const view = pi.createClientView()
          view.clientId = `control:${session.sessionId}`
          view.sessionKey = summary.id
          runtime.set(session.sessionId, view)
        } catch {
          /* 历史会话按首次请求恢复。 */
        }
      }
      if (summary.running && session.status !== 'running') {
        session.status = 'running'
        await store.saveSession(session)
      }
    }
    for (const session of store.state.sessions) {
      const view = runtime.get(session.sessionId)
      if (!view) continue
      try {
        await sync(session, view, true)
      } catch {
        runtime.delete(session.sessionId)
        continue
      }
      const prevStatus = session.status
      if (busy(view.sessionKey!)) session.status = 'running'
      else if (session.status === 'running' && !active.has(session.sessionId)) session.status = 'idle'
      if (session.status !== prevStatus) {
        await store.saveSession(session)
      }
    }
  }
  function publishReceipt(session: AppSession, receipt: SubmissionReceipt) {
    return store.publish(
      {
        type: 'submission',
        sessionId: session.sessionId,
        projectId: session.project?.projectId,
        value: receipt,
      },
      session,
    )
  }
  const publishSession = (session: AppSession) =>
    store.publish({
      type: 'session',
      sessionId: session.sessionId,
      projectId: session.project?.projectId,
      value: session,
    })
  const dispatchInput = async (session: AppSession, view: ClientView, pending: Pending, run: Active) => {
    const { input, receipt } = pending
    receipt.status = 'running'
    receipt.dispatchStartedAt = new Date().toISOString()
    session.status = 'running'
    await publishReceipt(session, receipt)
    track(
      pi.withClientView(view, async () => {
        try {
          const key = view.sessionKey!
          await options.bindRoot(key)
          if (run.cancelled) return
          if (pending.goal) await pi.continueGoalTask(key, input.text, pending.goal)
          else if (input.delivery === 'steer')
            await pi.steer(key, input.text, input.images, input.skills, { mode: input.mode })
          else
            await pi.prompt(
              key,
              input.text,
              input.images,
              input.skills,
              messageOptions({
                mode: input.mode,
                plan: input.plan,
                model: input.model,
                thinkingLevel: input.thinkingLevel,
                clientProcessingAudit: input.clientProcessingAudit,
              }),
            )
          await sync(session, view)
          // /plan 等只修改模式的命令不会产生 agent_settled。
          if (input.delivery !== 'steer' && !busy(key))
            await serial(session.sessionId, async () => {
              if (active.get(session.sessionId) === run) await finish(session, view, run)
            })
        } catch (cause) {
          await serial(session.sessionId, async () => {
            if (input.delivery === 'steer') {
              receipt.status = 'failed'
              receipt.error = cause instanceof Error ? cause.message : String(cause)
              await publishReceipt(session, receipt)
            } else if (active.get(session.sessionId) === run) {
              run.error = cause instanceof Error ? cause.message : String(cause)
              await finish(session, view, run)
            }
          })
        }
      }),
    )
  }
  const startNext = async (session: AppSession, view: ClientView) => {
    if (closing || paused.has(session.sessionId) || active.has(session.sessionId) || busy(view.sessionKey!)) return
    const pending = queues.get(session.sessionId)?.shift()
    if (!pending) return
    const run: Active = { receipts: [pending.receipt] }
    active.set(session.sessionId, run)
    await dispatchInput(session, view, pending, run)
  }
  async function finish(session: AppSession, view: ClientView, run: Active, aborted = false) {
    if (active.get(session.sessionId) !== run) return
    for (const receipt of run.receipts) {
      if (receipt.status !== 'running') continue
      receipt.status = run.cancelled || aborted ? 'interrupted' : run.error ? 'failed' : 'completed'
      if (run.error) receipt.error = run.error
      await publishReceipt(session, receipt)
    }
    active.delete(session.sessionId)
    session.status = run.cancelled || aborted ? 'interrupted' : 'idle'
    await sync(session, view)
    await publishSession(session)
    await startNext(session, view)
  }
  const submitInput = async (
    session: AppSession,
    view: ClientView,
    input: SubmissionInput,
    operationId: string,
    goal?: GoalControl,
  ): Promise<SubmissionReceipt> => {
    const key = view.sessionKey!
    if (typeof input?.text !== 'string' || !input.text.trim() || !['start', 'queue', 'steer'].includes(input.delivery))
      throw new Error('提交正文或投递方式无效')
    if (input.mode !== undefined && input.mode !== 'default' && input.mode !== 'plan') throw new Error('会话模式无效')
    if (input.plan) {
      messageOptions({
        mode: input.mode,
        plan: input.plan,
        model: input.model,
        thinkingLevel: input.thinkingLevel,
        clientProcessingAudit: input.clientProcessingAudit,
      })
      if (input.delivery !== 'start') throw new Error('计划操作只能在空闲会话直接开始')
      await options.bindRoot(key)
      if (!collaboration.resolveSessionPlan) throw new Error('当前 Host 不支持计划引用提交')
      await collaboration.resolveSessionPlan(key, input.plan.reference)
      if (input.plan.intent === 'execute' && pi.getSessionContext(key).accessMode === 'read-only')
        throw new Error('请先选择允许实施的访问权限')
    }
    const running = active.has(session.sessionId) || busy(key)
    if (input.delivery === 'start' && running) throw new Error('会话正在运行，请使用 queue 或 steer')
    if (input.delivery === 'steer' && !running) throw new Error('会话未运行，不能 steer')
    const receipt: SubmissionReceipt = {
      operationId,
      submissionId: randomUUID(),
      session: { hostId, sessionId: session.sessionId },
      delivery: input.delivery,
      status: input.delivery === 'queue' && running ? 'queued' : 'accepted',
    }
    store.state.receipts.push(receipt)
    await publishReceipt(session, receipt)
    if (input.delivery === 'steer') {
      let run = active.get(session.sessionId)
      if (!run) {
        run = { receipts: [] }
        active.set(session.sessionId, run)
      }
      run.receipts.push(receipt)
      receipt.runId = run.runId
      await dispatchInput(session, view, { input, receipt }, run)
    } else if (
      input.delivery === 'start' &&
      !running &&
      (pi.getSessionContext(key).state.stopped || goals.get(session)?.status === 'paused')
    ) {
      // 停止后的新输入独立执行；旧队列继续等待用户明确恢复。
      const run: Active = { receipts: [receipt] }
      active.set(session.sessionId, run)
      await dispatchInput(session, view, { input, receipt, goal }, run)
    } else {
      const queue = queues.get(session.sessionId) ?? []
      queue.push({ input, receipt, goal })
      queues.set(session.sessionId, queue)
      await startNext(session, view)
      if (receipt.status === 'accepted') {
        receipt.status = 'queued'
        await publishReceipt(session, receipt)
      }
    }
    return receipt
  }
  async function createGoalSubmission(
    key: string,
    session: AppSession,
    view: ClientView,
    input: GoalInput,
    operationId: string,
  ): Promise<GoalStartResult> {
    if (!pi.isSessionIdle(key) || active.has(session.sessionId) || queues.get(session.sessionId)?.length)
      throw new Error('请等待当前会话停止后再创建目标')
    let inputEntryId: string | undefined
    if (input?.sourceMessageTimestamp !== undefined) {
      if (!Number.isFinite(input.sourceMessageTimestamp)) throw new Error('来源消息时间戳无效')
      const snapshot = await options.snapshot()
      const source = snapshot.messages.find(
        (message) => message.role === 'user' && message.timestamp === input.sourceMessageTimestamp,
      )
      const entries = snapshot.sessionEntries?.entries ?? []
      const byId = new Map(entries.map((entry) => [entry.id, entry]))
      let entry = snapshot.sessionEntries?.leafId ? byId.get(snapshot.sessionEntries.leafId) : undefined
      const visited = new Set<string>()
      while (entry && !visited.has(entry.id)) {
        visited.add(entry.id)
        if (entry.role === 'user' && entry.messageTimestamp === input.sourceMessageTimestamp) {
          inputEntryId = entry.id
          break
        }
        entry = entry.parentId ? byId.get(entry.parentId) : undefined
      }
      if (!source || source.role !== 'user' || !inputEntryId) throw new Error('来源消息不在当前会话分支')
      const content = source.content
      input = {
        objective: skillMessageText(
          typeof content === 'string'
            ? content
            : content
                .filter((part) => part.type === 'text')
                .map((part) => part.text)
                .join('\n'),
        ),
        sourceMessageTimestamp: input.sourceMessageTimestamp,
      }
    }
    await pi.setSessionMode(key, 'default')
    const goal = await goals.start(session, input, inputEntryId)
    goalErrors.delete(session.sessionId)
    paused.delete(session.sessionId)
    try {
      const receipt = await submitInput(
        session,
        view,
        {
          text: inputEntryId
            ? 'Treat the selected existing user message as the persistent goal. Check the current state and recorded progress, then continue execution and verify the original requirements.'
            : input.objective,
          images: input.images,
          skills: input.skills,
          mode: 'default',
          delivery: 'start',
        },
        operationId,
        inputEntryId ? goal : undefined,
      )
      return { goal, receipt }
    } catch (cause) {
      await goals.stop(session, 'paused', `首轮启动失败：${String(cause)}`)
      throw cause
    }
  }
  const stop = (ref: SessionRef, callerClientId?: string) =>
    target(
      ref,
      (key, session, view) =>
        serial(session.sessionId, async () => {
          const run = active.get(session.sessionId)
          if (run) run.cancelled = true
          for (const pending of queues.get(session.sessionId) ?? []) {
            pending.receipt.status = 'cancelled'
            await publishReceipt(session, pending.receipt)
          }
          queues.delete(session.sessionId)
          const goal = goals.get(session)
          if (goal?.status === 'active') await goals.stop(session, 'paused', '用户停止了目标执行')
          await pi.abort(key)
          if (run) await finish(session, view, run, true)
          else {
            session.status = 'interrupted'
            await publishSession(session)
          }
        }),
      callerClientId,
    )
  const sessionTargetMethods = new Set([
    'sessions.configure',
    'sessions.submit',
    'sessions.stop',
    'sessions.stopTask',
    'sessions.continueTask',
    'sessions.pause',
    'sessions.resume',
    'goals.start',
    'goals.edit',
    'goals.pause',
    'goals.resume',
    'goals.clear',
    'activities.stop',
    'interaction.respond',
    'files.write',
    'terminal.open',
  ])

  const mutate = <T>(
    clientId: string,
    method: string,
    args: unknown[],
    opts: MutationOptions,
    action: (operationId: string) => Promise<T>,
    options?: { ephemeral?: boolean; sessionId?: string },
  ) => {
    if (closing) return Promise.reject<T>(new Error('Host 正在退出，操作未接纳'))
    let targetSessionId = options?.sessionId
    if (!targetSessionId) {
      if (sessionTargetMethods.has(method)) {
        const ref = args[0]
        if (ref && typeof ref === 'object' && 'sessionId' in ref && typeof (ref as any).sessionId === 'string') {
          targetSessionId = (ref as SessionRef).sessionId
        }
      } else if (method === 'sessions.cancelSubmission' && typeof args[0] === 'string') {
        targetSessionId = store.state.receipts.find((r) => r.operationId === args[0])?.session.sessionId
      } else if (method.startsWith('terminal.') && args[0] && typeof args[0] === 'object' && 'terminalId' in args[0]) {
        const root = terminalRoots.get((args[0] as any).terminalId)
        if (root && 'sessionId' in root) targetSessionId = root.sessionId
      }
    }

    const session = targetSessionId ? store.state.sessions.find((s) => s.sessionId === targetSessionId) : undefined
    const isEphemeral = Boolean(options?.ephemeral || session?.temporary)
    return store.mutate(clientId, opts?.idempotencyKey, method, args, action, {
      ephemeral: isEphemeral,
      sessionId: targetSessionId,
    })
  }
  const requireSchedules = () => {
    if (!options.schedules) throw new Error('当前 Host 不支持定时任务')
    return options.schedules
  }
  const apiFor = (clientId: string): HostApi => ({
    apiVersion: 2,
    imageGeneration: options.imageGeneration,
    models: options.models,
    capabilities: async () => ({
      apiVersion: 2,
      hostId,
      fileOperations: ['preview', 'search', 'write'],
      features: [
        ...(options.imageGeneration ? ['image-generation' as const] : []),
        ...(options.models ? ['models' as const] : []),
        ...(options.schedules ? ['schedules' as const] : []),
        'projects',
        'sessions',
        'messages',
        'files',
        'git',
        'interaction',
        'agents',
        'plans',
        'goals',
        ...(options.activities ? ['activities' as const] : []),
        ...(options.workspace.terminalSupported ? ['terminal' as const] : []),
      ],
    }),
    schedules: {
      list: () => requireSchedules().list(),
      get: (ref) => requireSchedules().get(ref),
      create: (input, opts) =>
        mutate(clientId, 'schedules.create', [input], opts, () => requireSchedules().create(input)),
      update: (ref, input, opts) =>
        mutate(clientId, 'schedules.update', [ref, input], opts, () => requireSchedules().update(ref, input)),
      pause: (ref, opts) => mutate(clientId, 'schedules.pause', [ref], opts, () => requireSchedules().pause(ref)),
      resume: (ref, opts) => mutate(clientId, 'schedules.resume', [ref], opts, () => requireSchedules().resume(ref)),
      delete: (ref, opts) => mutate(clientId, 'schedules.delete', [ref], opts, () => requireSchedules().delete(ref)),
      runNow: (ref, opts) => mutate(clientId, 'schedules.runNow', [ref], opts, () => requireSchedules().runNow(ref)),
      stopRun: (ref, opts) => mutate(clientId, 'schedules.stopRun', [ref], opts, () => requireSchedules().stopRun(ref)),
      runs: (ref, input) => requireSchedules().runs(ref, input),
      markRead: (ref, runId, opts) =>
        mutate(clientId, 'schedules.markRead', [ref, runId], opts, () => requireSchedules().markRead(ref, runId)),
      resetSession: (ref, opts) =>
        mutate(clientId, 'schedules.resetSession', [ref], opts, () => requireSchedules().resetSession(ref)),
    },
    plugins: {
      getDefaultAgentPlugins: () => options.defaultAgentPlugins.getDefaultAgentPlugins(),
      setDefaultAgentPlugins: (ids, opts) =>
        mutate(clientId, 'plugins.setDefaultAgentPlugins', [ids], opts, () =>
          options.defaultAgentPlugins.setDefaultAgentPlugins(ids, opts),
        ),
    },
    projects: {
      list: async () => {
        await refresh()
        return structuredClone(store.state.projects)
      },
      get: async (ref) => {
        await refresh()
        return structuredClone(getProject(ref))
      },
      register: (input, opts) =>
        mutate(clientId, 'projects.register', [input], opts, async () => {
          const registered = await projects.register(input.cwd)
          if (input.name) await projects.renameProject(registered.cwd, input.name)
          const project = (await projectFor(registered.cwd))!
          if (input.name && project.name !== input.name) {
            project.name = input.name
            await store.saveProject(project)
          }
          return project
        }),
    },
    sessions: {
      create: (input, opts) =>
        mutate(clientId, 'sessions.create', [input], opts, async () => {
          const cwd = input.project ? getProject(input.project).cwd : await projects.createStandaloneDirectory()
          const session: AppSession = {
            hostId,
            sessionId: randomUUID(),
            project: input.project,
            cwd,
            createdAt: new Date().toISOString(),
            name: input.name,
            configuration: {
              agentPlugins: await options.defaultAgentPlugins.getDefaultAgentPlugins(),
              ...input.configuration,
            },
            status: 'idle',
          }
          await store.saveSession(session)
          await resolveSession(session, false)
          await publishSession(session)
          return session
        }),
      list: async (input = {}) => {
        if (input?.project) getProject(input.project)
        await refresh()
        return structuredClone(
          store.state.sessions.filter(
            (item) => !item.temporary && (!input?.project || item.project?.projectId === input.project.projectId),
          ),
        )
      },
      get: async (ref) => {
        await refresh()
        return structuredClone(getSession(ref, clientId))
      },
      snapshot: (ref) =>
        target(
          ref,
          async (_key, session, view) => {
            const controlCursor = store.read().cursor
            const result = await options.snapshot()
            await sync(session, view)
            return { ...result, goal: goals.get(session), goalsSupported: true, controlCursor }
          },
          clientId,
        ),
      history: (ref, input) =>
        target(
          ref,
          async (key, session) => {
            const offset = input?.offset ?? 0
            const limit = input?.limit ?? 100
            if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500)
              throw new Error('历史分页参数无效')
            const history = session.sessionFile
              ? await readSessionHistory(session.sessionFile)
              : pi.getRuntimeHistory(key)!
            const totalMessages = history.messages.length
            return {
              ...history,
              messages: history.messages.slice(offset, offset + limit),
              totalMessages,
              nextOffset: offset + limit < totalMessages ? offset + limit : undefined,
            }
          },
          clientId,
        ),
      messages: (ref, input = {}) =>
        target(
          ref,
          async (key, session) => {
            const limit = input.limit ?? 100
            let offset = input.offset ?? 0
            if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500 || !Number.isSafeInteger(offset) || offset < 0)
              throw new ControlError('invalid-input', '消息分页参数无效')
            const history = session.sessionFile
              ? await readSessionHistory(session.sessionFile)
              : pi.getRuntimeHistory(key)!
            const leafId = 'sessionEntries' in history ? (history.sessionEntries?.leafId ?? null) : null
            const branchRevision = createHash('sha256')
              .update(
                JSON.stringify([
                  ref.sessionId,
                  leafId,
                  'sessionEntries' in history
                    ? history.sessionEntries?.entries.map((entry) => [entry.id, entry.parentId, entry.type])
                    : [],
                  history.messages.map((m) => m.sourceEntry),
                ]),
              )
              .digest('hex')
            if (input.cursor) {
              let cursor: { sessionId?: string; revision?: string; offset?: number }
              try {
                cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString())
              } catch {
                throw new ControlError('stale-cursor', '消息游标无效')
              }
              if (
                cursor.sessionId !== ref.sessionId ||
                cursor.revision !== branchRevision ||
                !Number.isSafeInteger(cursor.offset) ||
                cursor.offset! < 0
              )
                throw new ControlError('stale-cursor', '消息分支已变化，请重新读取')
              offset = cursor.offset!
            }
            const messages = history.messages.flatMap((m) => {
              const projected = projectUiMessage(m, ref)
              return projected?.ref ? [projected] : []
            })
            const nextOffset = offset + limit < messages.length ? offset + limit : undefined
            return {
              messages: messages.slice(offset, offset + limit),
              totalMessages: messages.length,
              nextOffset,
              nextCursor:
                nextOffset === undefined
                  ? undefined
                  : Buffer.from(
                      JSON.stringify({ sessionId: ref.sessionId, revision: branchRevision, offset: nextOffset }),
                    ).toString('base64url'),
              branchRevision,
              leafId,
            }
          },
          clientId,
        ),
      message: (ref, input) =>
        target(
          ref,
          async (key, session) => {
            const history = session.sessionFile
              ? await readSessionHistory(session.sessionFile)
              : pi.getRuntimeHistory(key)!
            const message = history.messages.find((m) => m.sourceEntry?.id === input.entryId)
            const projected = message && projectUiMessage(message, ref)
            if (!projected?.ref) throw new ControlError('message-not-found', '消息不存在于当前分支')
            return projected
          },
          clientId,
        ),
      configure: (ref, config, opts) =>
        mutate(clientId, 'sessions.configure', [ref, config], opts, () =>
          target(
            ref,
            (_key, session, view) => serial(session.sessionId, () => configure(session, view, config)),
            clientId,
          ),
        ),
      submit: (ref, input, opts) =>
        mutate(clientId, 'sessions.submit', [ref, input], opts, async (operationId) => {
          const command = !input?.plan && typeof input?.text === 'string' ? parseGoalCommand(input.text) : undefined
          if (command && command.action !== 'start') {
            const session = getSession(ref, clientId)
            if (command.action !== 'open') {
              const goal = goals.get(session)
              if (!goal) throw new Error('当前会话没有目标')
              const method = command.action === 'edit' ? 'pause' : command.action
              await apiFor(clientId).goals[method](ref, goal, { idempotencyKey: `${operationId}:goal-control` })
            }
            const receipt: SubmissionReceipt = {
              operationId,
              submissionId: randomUUID(),
              session: { hostId, sessionId: ref.sessionId },
              delivery: input.delivery,
              status: 'completed',
            }
            store.state.receipts.push(receipt)
            await publishReceipt(session, receipt)
            return receipt
          }
          return target(
            ref,
            (key, session, view) =>
              serial(session.sessionId, async () => {
                const command = input.plan ? undefined : parseGoalCommand(input.text)
                if (command) {
                  if (command.action !== 'start') throw new Error('纯目标命令请使用目标控制接口')
                  return (
                    await createGoalSubmission(
                      key,
                      session,
                      view,
                      {
                        objective: command.objective,
                        images: input.images,
                        skills: input.skills,
                      },
                      operationId,
                    )
                  ).receipt
                }
                return submitInput(session, view, input, operationId)
              }),
            clientId,
          )
        }),
      stop: (ref, opts) => mutate(clientId, 'sessions.stop', [ref], opts, () => stop(ref, clientId)),
      stopTask: (ref, opts) =>
        mutate(clientId, 'sessions.stopTask', [ref], opts, () =>
          target(
            ref,
            (key, session, view) =>
              serial(session.sessionId, async () => {
                const run = active.get(session.sessionId)
                if (run) run.cancelled = true
                const goal = goals.get(session)
                if (goal?.status === 'active') await goals.stop(session, 'paused', '用户停止了目标执行')
                paused.add(session.sessionId)
                await pi.stopTask(key)
                if (run) await finish(session, view, run, true)
                else {
                  session.status = 'interrupted'
                  await publishSession(session)
                }
              }),
            clientId,
          ),
        ),
      continueTask: (ref, configuration, opts) =>
        mutate(clientId, 'sessions.continueTask', [ref, configuration], opts, () =>
          target(
            ref,
            (key, session, view) =>
              serial(session.sessionId, async () => {
                if (goals.get(session)?.status === 'paused') throw new Error('目标已暂停，请使用目标恢复操作')
                if (!pi.isSessionIdle(key, true) || pi.getSessionContext(key).state.isPaused)
                  throw new Error('当前任务仍在执行或暂停中')
                await pi.continueStopped(key, configuration ?? undefined)
                session.status = 'running'
                await publishSession(session)
                await sync(session, view)
              }),
            clientId,
          ),
        ),
      pause: (ref, opts) =>
        mutate(clientId, 'sessions.pause', [ref], opts, () =>
          target(
            ref,
            async (key, session) => {
              paused.add(session.sessionId)
              await pi.pause(key)
            },
            clientId,
          ),
        ),
      resume: (ref, opts) =>
        mutate(clientId, 'sessions.resume', [ref], opts, () =>
          target(
            ref,
            (key, session, view) =>
              serial(session.sessionId, async () => {
                await pi.resume(key)
                paused.delete(session.sessionId)
                await startNext(session, view)
              }),
            clientId,
          ),
        ),
      receipt: async (id) => {
        const receipt = store.state.receipts.find((item) => item.operationId === id)
        if (!receipt) throw new Error('提交回执不存在')
        getSession(receipt.session, clientId)
        return structuredClone(receipt)
      },
      submissions: async (ref) => {
        getSession(ref, clientId)
        return structuredClone(store.state.receipts.filter((item) => item.session.sessionId === ref.sessionId))
      },
      cancelSubmission: (id, opts) => {
        const receipt = store.state.receipts.find((item) => item.operationId === id)
        if (!receipt) throw new Error('提交回执不存在')
        const session = getSession(receipt.session, clientId)
        return mutate(
          clientId,
          'sessions.cancelSubmission',
          [id],
          opts,
          async () => {
            await serial(receipt.session.sessionId, async () => {
              if (receipt.status === 'cancelled') return
              if (receipt.status !== 'queued') throw new Error('只能撤销排队提交；已投递的任务请停止会话')
              queues.set(
                receipt.session.sessionId,
                (queues.get(receipt.session.sessionId) ?? []).filter((item) => item.receipt.operationId !== id),
              )
              receipt.status = 'cancelled'
              await publishReceipt(session, receipt)
            })
          },
          session.temporary ? { ephemeral: true } : undefined,
        )
      },
    },
    events: {
      read: async (input = {}) => {
        const page = store.read(input ?? {})
        return {
          ...page,
          events: page.events.filter((event) => {
            const sessionId = event.sessionId
            if (!sessionId) return true
            const session = store.state.sessions.find((s) => s.sessionId === sessionId)
            if (session?.temporary && session.ownerClientId) {
              return clientId === 'host-internal' || session.ownerClientId === clientId
            }
            return true
          }),
        }
      },
      subscribe: async (input, callback) => {
        if (input.sessionId) {
          const session = store.state.sessions.find((s) => s.sessionId === input.sessionId)
          if (
            session?.temporary &&
            session.ownerClientId &&
            clientId !== 'host-internal' &&
            session.ownerClientId !== clientId
          ) {
            throw new Error('无权订阅其他窗口的临时会话')
          }
        }
        return store.subscribe(input, callback, clientId)
      },
    },
    files: {
      ...options.workspace.files,
      list: (ref, rel) => {
        assertSessionAccess(ref, clientId)
        return options.workspace.files.list(ref, rel)
      },
      read: (ref, rel) => {
        assertSessionAccess(ref, clientId)
        return options.workspace.files.read(ref, rel)
      },
      preview: (ref, rel) => {
        assertSessionAccess(ref, clientId)
        return options.workspace.files.preview(ref, rel)
      },
      search: (ref, input) => {
        assertSessionAccess(ref, clientId)
        return options.workspace.files.search(ref, input)
      },
      write: (ref, input, opts) => {
        assertSessionAccess(ref, clientId)
        return mutate(clientId, 'files.write', [ref, input], opts, () =>
          options.workspace.files.write(ref, input, opts),
        )
      },
    },
    terminal: {
      open: (ref, input, opts) => {
        assertSessionAccess(ref, clientId)
        return mutate(clientId, 'terminal.open', [ref, input], opts, async () => {
          const snapshot = await options.workspace.terminal.open(ref, input, opts)
          terminalRoots.set(snapshot.terminalId, ref)
          return snapshot
        })
      },
      attach: (ref) => {
        assertTerminalAccess(ref, clientId)
        return options.workspace.terminal.attach(ref)
      },
      input: (ref, data, opts) => {
        assertTerminalAccess(ref, clientId)
        return mutate(clientId, 'terminal.input', [ref, data], opts, () =>
          options.workspace.terminal.input(ref, data, opts),
        )
      },
      resize: (ref, size, opts) => {
        assertTerminalAccess(ref, clientId)
        return mutate(clientId, 'terminal.resize', [ref, size], opts, () =>
          options.workspace.terminal.resize(ref, size, opts),
        )
      },
      close: (ref, opts) => {
        assertTerminalAccess(ref, clientId)
        return mutate(clientId, 'terminal.close', [ref], opts, async () => {
          const result = await options.workspace.terminal.close(ref, opts)
          terminalRoots.delete(ref.terminalId)
          return result
        })
      },
    },
    git: {
      turnChanges: (ref, entryIds) =>
        target(
          ref,
          async (key) => {
            if (!Array.isArray(entryIds) || entryIds.length > 200 || entryIds.some((id) => typeof id !== 'string'))
              throw new Error('变更轮次参数无效')
            const file = pi.getSessionContext(key).sessionFile
            return file ? readTurnChanges(file, entryIds) : []
          },
          clientId,
        ),
      undoTurn: (ref, entryId, opts) =>
        mutate(clientId, 'git.undoTurn', [ref, entryId], opts, () =>
          target(
            ref,
            (key, session) =>
              serial(session.sessionId, async () => {
                const context = pi.getSessionContext(key)
                if (context.accessMode === 'read-only') throw new Error('只读权限不允许撤销文件变更')
                if (!context.sessionFile) throw new Error('会话尚未保存变更记录')
                if (!options.withFileUndo) throw new Error('当前 Host 不支持撤销文件变更')
                await options.withFileUndo(context.cwd, async () => {
                  await undoTurnChanges(
                    context.sessionFile!,
                    entryId,
                    context.cwd,
                    context.accessMode === 'full-access',
                  )
                })
              }),
            clientId,
          ),
        ),
      environment: async (ref) => getGitEnvironment(await resolveRoot(ref, clientId)),
      snapshot: async (ref) => getGitSnapshot(await resolveRoot(ref, clientId)),
      diff: async (ref, input) =>
        getGitDiff(await resolveRoot(ref, clientId), input.path, input.kind ?? (input.staged ? 'staged' : 'unstaged')),
    },
    interaction: {
      respond: (ref, input, opts) =>
        mutate(clientId, 'interaction.respond', [ref, input], opts, () =>
          target(
            ref,
            async (key) => {
              if (input.agentId) {
                const agents = await collaboration.getAgents(key)
                const agent = agents.find((item) => item.agentId === input.agentId)
                if (!agent) throw new Error('Agent 不属于目标会话')
                await collaboration.respondExtensionUI(agent.sessionKey, input.requestId, input.response)
              } else await pi.respondExtensionUI(key, input.requestId, input.response)
            },
            clientId,
          ),
        ),
    },
    agents: {
      list: (ref) =>
        target(
          ref,
          async (key) => {
            await options.bindRoot(key)
            return collaboration.getAgents(key)
          },
          clientId,
        ),
      get: async (id) => {
        const rootKey = collaboration.rootSessionKey?.(id)
        if (rootKey) {
          const rootSession = store.state.sessions.find((s) => runtime.get(s.sessionId)?.sessionKey === rootKey)
          if (rootSession) {
            getSession(rootSession, clientId)
          } else if (collaboration.isTemporarySession?.(rootKey)) {
            throw new Error('会话不存在或已关闭')
          }
        }
        return collaboration.getAgentSnapshot(id)
      },
      stop: async (id, opts) => {
        const rootKey = collaboration.rootSessionKey?.(id)
        let rootSession: AppSession | undefined
        if (rootKey) {
          rootSession = store.state.sessions.find((s) => runtime.get(s.sessionId)?.sessionKey === rootKey)
          if (rootSession) {
            getSession(rootSession, clientId)
          } else if (collaboration.isTemporarySession?.(rootKey)) {
            throw new Error('会话不存在或已关闭')
          }
        }
        return mutate(clientId, 'agents.stop', [id], opts, () => collaboration.interruptAgent(id), {
          ephemeral: rootSession?.temporary,
          sessionId: rootSession?.sessionId,
        })
      },
    },
    activities: {
      list: async (ref) => {
        getSession(ref, clientId)
        if (!options.activities) throw new Error('当前 Host 不支持活动服务')
        const cursor = store.read().cursor
        return { ...options.activities.list(ref), cursor }
      },
      logs: async (ref, id) => {
        getSession(ref, clientId)
        if (!options.activities) throw new Error('当前 Host 不支持活动服务')
        return options.activities.logs(ref, id)
      },
      stop: (ref, id, opts) =>
        mutate(clientId, 'activities.stop', [ref, id], opts, async () => {
          getSession(ref, clientId)
          if (!options.activities) throw new Error('当前 Host 不支持活动服务')
          return options.activities.stop(ref, id, '用户停止')
        }),
    },
    goals: {
      get: async (ref) => {
        getSession(ref, clientId)
        return goals.get(ref)
      },
      start: (ref, input, opts) =>
        mutate(clientId, 'goals.start', [ref, input], opts, (operationId) =>
          target(
            ref,
            (key, session, view) =>
              serial(session.sessionId, () => createGoalSubmission(key, session, view, input, operationId)),
            clientId,
          ),
        ),
      edit: (ref, input, opts) =>
        mutate(clientId, 'goals.edit', [ref, input], opts, () =>
          target(
            ref,
            (key, session) =>
              serial(session.sessionId, async () => {
                if (!pi.isSessionIdle(key, true)) throw new Error('请等待目标完全停止后再编辑')
                return goals.edit(session, input)
              }),
            clientId,
          ),
        ),
      pause: (ref, input, opts) =>
        mutate(clientId, 'goals.pause', [ref, input], opts, async () => {
          getSession(ref, clientId)
          validateGoalControl(input)
          await goals.stop(ref, 'paused', '用户暂停了目标', input)
          await target(ref, (key) => pi.stopTask(key), clientId)
          return goals.get(ref)!
        }),
      resume: (ref, input, opts) =>
        mutate(clientId, 'goals.resume', [ref, input], opts, () =>
          target(
            ref,
            (key, session) =>
              serial(session.sessionId, async () => {
                if (
                  !pi.isSessionIdle(key, true) ||
                  pi.getSessionContext(key).state.isPaused ||
                  active.has(session.sessionId)
                )
                  throw new Error('请先结束当前执行和排队输入')
                const state = pi.getSessionContext(key).state
                if ((!state.model || state.modelSelectionRequired) && !input.configuration?.model)
                  throw new Error('请先选择可用模型')
                await pi.setSessionMode(key, 'default')
                paused.delete(session.sessionId)
                const goal = await goals.resume(session, input)
                if (input.configuration) goalNextConfiguration.set(session.sessionId, input.configuration)
                goalErrors.delete(session.sessionId)
                scheduleGoal(session)
                return goal
              }),
            clientId,
          ),
        ),
      clear: (ref, input, opts) =>
        mutate(clientId, 'goals.clear', [ref, input], opts, async () => {
          getSession(ref, clientId)
          const goal = goals.get(ref)
          if (!goal || goal.goalId !== input?.goalId || goal.revision !== input?.revision)
            throw new Error('目标已更新，请刷新后重试')
          if (goal.status === 'active') await goals.stop(ref, 'paused', '正在清除目标', input)
          await stop(ref, clientId)
          await goals.clear(ref, goals.get(ref)!)
        }),
    },
    plans: { list: (ref) => target(ref, async () => (await options.snapshot()).planDocuments ?? [], clientId) },
  })
  const api = apiFor('host-internal')
  const writes = new Set([
    'schedules.create',
    'schedules.update',
    'schedules.pause',
    'schedules.resume',
    'schedules.delete',
    'schedules.runNow',
    'schedules.stopRun',
    'schedules.markRead',
    'schedules.resetSession',
    'files.write',
    'plugins.setDefaultAgentPlugins',
    'projects.register',
    'sessions.create',
    'sessions.configure',
    'sessions.submit',
    'sessions.stop',
    'sessions.stopTask',
    'sessions.continueTask',
    'sessions.pause',
    'sessions.resume',
    'sessions.cancelSubmission',
    'terminal.open',
    'terminal.input',
    'terminal.resize',
    'terminal.close',
    'interaction.respond',
    'agents.stop',
    'activities.stop',
    'goals.start',
    'goals.edit',
    'goals.pause',
    'goals.resume',
    'goals.clear',
    'git.undoTurn',
  ])
  const dispatch = async (request: HostControlRequest): Promise<HostControlResponse> => {
    try {
      if (closing) throw new Error('Host 正在退出')
      if (
        request?.apiVersion !== 2 ||
        typeof request.clientId !== 'string' ||
        !request.clientId ||
        request.clientId.length > 128 ||
        typeof request.method !== 'string' ||
        !Array.isArray(request.args)
      )
        throw new Error('控制请求参数无效')
      if (request.hostId && request.hostId !== hostId) throw new Error('目标 Host 身份不匹配')
      const [group, name, ...extra] = request.method.split('.')
      const scoped = apiFor(request.clientId)
      let action: unknown
      if (request.method === 'capabilities') action = scoped.capabilities
      else if (!extra.length && Object.hasOwn(scoped, group)) {
        const domain = scoped[group as keyof HostApi]
        if (domain && typeof domain === 'object' && Object.hasOwn(domain, name))
          action = (domain as Record<string, unknown>)[name]
      }
      if (typeof action !== 'function' || request.method === 'events.subscribe') throw new Error('控制接口不存在')
      const args = [...request.args]
      if (writes.has(request.method)) args.push({ idempotencyKey: request.idempotencyKey })
      return { hostId, result: await (action as (...args: unknown[]) => Promise<unknown>)(...args) }
    } catch (cause) {
      return {
        hostId,
        error: {
          code: cause instanceof ControlError ? cause.code : 'operation-failed',
          message: cause instanceof Error ? cause.message : String(cause),
        },
      }
    }
  }
  function scheduleGoal(session: AppSession) {
    if (closing || goalTimers.has(session.sessionId) || goals.get(session)?.status !== 'active') return
    const timer = setTimeout(() => {
      goalTimers.delete(session.sessionId)
      track(
        target(session, (key, current, view) =>
          serial(current.sessionId, async () => {
            if (
              closing ||
              pi.getSessionContext(key).state.isPaused ||
              active.has(current.sessionId) ||
              !pi.isSessionIdle(key, true)
            )
              return
            const goal = goals.get(current)
            if (goal?.status !== 'active') return
            await options.bindRoot(key)
            const previousRun = goals.currentRun(current)
            if (previousRun && !(await collaboration.goalReady(key))) return
            if (previousRun) await goals.settled(previousRun)
            const latest = goals.get(current)
            if (latest?.status !== 'active' || closing || !pi.isSessionIdle(key, true)) return
            try {
              const initial = goals.pendingInput(current)
              const configuration = goalNextConfiguration.get(current.sessionId)
              if (initial)
                await pi.prompt(key, initial.objective, initial.images, initial.skills, {
                  mode: 'default',
                  ...configuration,
                })
              else {
                await pi.continueGoalTask(
                  key,
                  'Continue the active persistent goal. Recheck current facts and latest progress, then take the next concrete step. Before completing the goal, provide evidence for every original requirement.',
                  latest,
                  configuration,
                )
              }
              goalNextConfiguration.delete(current.sessionId)
              current.status = 'running'
              await sync(current, view)
              await publishSession(current)
            } catch (cause) {
              await goals.stop(current, 'paused', `目标续跑失败：${String(cause)}`)
            }
          }),
        ),
      )
    }, 0)
    goalTimers.set(session.sessionId, timer)
  }
  const observe = (event: HostEvent) => {
    if (closing || !event.value || !('sessionKey' in event.value)) return
    const eventKey = event.value.sessionKey
    const rootId = event.type === 'event' ? event.value.rootAgentId : undefined
    const session = store.state.sessions.find(
      (item) =>
        runtime.get(item.sessionId)?.sessionKey === eventKey || (rootId && rootAgents.get(rootId) === item.sessionId),
    )
    if (!session) return
    const view = runtime.get(session.sessionId)!
    const isRoot = view.sessionKey === eventKey
    if (rootId && isRoot) rootAgents.set(rootId, session.sessionId)
    const observedRun = isRoot ? active.get(session.sessionId) : undefined
    const value = event.value
    const piEvent = event.type === 'event' ? event.value.event : undefined
    const live = piEvent && ['message_update', 'tool_execution_update'].includes(piEvent.type)
    if (live) {
      store.publishLive({
        type: 'runtime',
        sessionId: session.sessionId,
        projectId: session.project?.projectId,
        value: value as Record<string, unknown>,
      })
      return
    }
    track(
      serial(session.sessionId, async () => {
        if (observedRun && active.get(session.sessionId) === observedRun) {
          if (event.type === 'error') observedRun.error = event.value.message
          if (
            piEvent?.type === 'message_end' &&
            piEvent.message.role === 'assistant' &&
            piEvent.message.stopReason === 'error'
          )
            observedRun.error = piEvent.message.errorMessage ?? '模型执行失败'
          if (piEvent?.type === 'agent_start' && event.type === 'event' && event.value.runId) {
            observedRun.runId = event.value.runId
            for (const receipt of observedRun.receipts) {
              receipt.runId = observedRun.runId
              await publishReceipt(session, receipt)
            }
          }
          if (piEvent?.type === 'agent_settled') await finish(session, view, observedRun, piEvent.aborted)
        } else if (isRoot && piEvent?.type === 'agent_settled' && !active.has(session.sessionId)) {
          session.status = piEvent.aborted ? 'interrupted' : 'idle'
          await sync(session, view)
          await startNext(session, view)
        }
        if (isRoot && piEvent?.type === 'pause_update') {
          if (piEvent.isPaused || piEvent.queuePaused) paused.add(session.sessionId)
          else {
            paused.delete(session.sessionId)
            await startNext(session, view)
          }
        }
        const goal = goals.get(session)
        if (goal?.status === 'complete' && isRoot && piEvent?.type === 'agent_settled') {
          const run = goals.currentRun(session)
          if (run) await goals.settled(run)
        }
        if (goal?.status === 'active') {
          if (
            (event.type === 'error' && isRoot) ||
            (piEvent?.type === 'message_end' &&
              piEvent.message.role === 'assistant' &&
              piEvent.message.stopReason === 'error')
          ) {
            const reason =
              event.type === 'error'
                ? event.value.message
                : piEvent?.type === 'message_end' && piEvent.message.role === 'assistant'
                  ? (piEvent.message.errorMessage ?? '模型执行失败')
                  : '执行失败'
            goalErrors.set(session.sessionId, { source: eventKey, reason })
          }
          if (
            (piEvent?.type === 'message_end' &&
              piEvent.message.role === 'assistant' &&
              !['error', 'aborted'].includes(piEvent.message.stopReason)) ||
            (piEvent?.type === 'auto_retry_end' && piEvent.success)
          ) {
            if (goalErrors.get(session.sessionId)?.source === eventKey) goalErrors.delete(session.sessionId)
          }
          const failure = goalErrors.get(session.sessionId)
          if (piEvent?.type === 'agent_settled' && failure && failure.source === eventKey) {
            goalErrors.delete(session.sessionId)
            const quota =
              /insufficient_quota|quota_exceeded|billing_hard_limit|credit balance is too low|exceeded your current quota/i.test(
                failure.reason,
              )
            await goals.stop(session, quota ? 'usage_limited' : 'paused', failure.reason)
          }
          const run = goals.currentRun(session)
          if (run && piEvent?.type === 'tool_execution_end' && !['get_goal', 'update_goal'].includes(piEvent.toolName))
            goals.activity(run)
          const agents = await collaboration.getAgents(view.sessionKey!)
          goals.setRunning(
            session,
            agents.some((agent) => ['running', 'starting'].includes(agent.status) && !agent.isPaused),
          )
          scheduleGoal(session)
        }
        // 消息正文由 Pi JSONL 保存；控制日志只保留状态及关联信息。
        const fullStateEvents = new Set([
          'agent_start',
          'agent_settled',
          'pause_update',
          'agents_update',
          'extension_ui_request',
          'extension_ui_closed',
          'extension_ui_timeout',
          'plan_saved',
          'plan_state_changed',
          'goal_updated',
          'goal_cleared',
          'composer_hint',
        ])
        const stored =
          event.type === 'event'
            ? {
                ...event.value,
                event:
                  event.value.event.type === 'agents_update'
                    ? {
                        ...event.value.event,
                        agents: event.value.event.agents.map(({ task: _task, report: _report, ...agent }) => agent),
                      }
                    : fullStateEvents.has(event.value.event.type)
                      ? event.value.event
                      : { type: event.value.event.type },
              }
            : (value as Record<string, unknown>)
        await store.publish({
          type: 'runtime',
          sessionId: session.sessionId,
          projectId: session.project?.projectId,
          value: stored,
        })
      }),
    )
  }
  await refresh()
  return {
    api,
    apiFor,
    assertActivityAccess,
    waitForSessionOperations: (sessionId: string) => store.waitForSessionOperations(sessionId),
    goalRuntimeKey: (ref: SessionRef) => runtime.get(ref.sessionId)?.sessionKey,
    async admitGoal(key: string, origin: import('@pi-meme/contracts/goal').PromptOrigin, expected?: GoalControl) {
      const session = await this.sessionForRuntime(key)
      const goal = goals.get(session)
      if (
        origin === 'goal' &&
        (!goal || goal.status !== 'active' || goal.goalId !== expected?.goalId || goal.revision !== expected.revision)
      )
        throw new Error('目标已停止或发生变更')
      return goals.begin(session, origin === 'collaboration')
    },
    async goalForRuntime(key: string) {
      return goals.get(await this.sessionForRuntime(key))
    },
    async goalRunForRuntime(key: string) {
      return goals.currentRun(await this.sessionForRuntime(key))
    },
    async goalCanComplete(key: string) {
      const session = await this.sessionForRuntime(key)
      return (
        !queues.get(session.sessionId)?.length &&
        !pi.hasRunningGoalTools(key) &&
        !pi.hasPendingGoalInput(key) &&
        (await collaboration.goalReady(key, true))
      )
    },
    dispatch,
    observe,
    resolveRoot,
    async sessionForRuntime(key: string) {
      const existing = runtimeBindings.get(key)
      if (existing) return structuredClone(await existing)
      const pending = (async () => {
        const context = pi.readSessionBinding(key)
        let session = store.state.sessions.find(
          (item) =>
            runtime.get(item.sessionId)?.sessionKey === key ||
            (context.sessionFile && item.sessionFile === context.sessionFile),
        )
        if (!session) {
          const isTemporary = Boolean(
            (context as { temporary?: boolean }).temporary ||
            pi.getRuntimeHistory(key)?.temporary ||
            key.startsWith('temporary:'),
          )
          const project = await projectFor(context.cwd)
          const agentPlugins = await options.defaultAgentPlugins.getDefaultAgentPlugins()
          session = store.state.sessions.find(
            (item) =>
              runtime.get(item.sessionId)?.sessionKey === key ||
              (context.sessionFile && item.sessionFile === context.sessionFile),
          )
          if (!session) {
            session = {
              hostId,
              sessionId: randomUUID(),
              project: project && { hostId, projectId: project.projectId },
              cwd: context.cwd,
              createdAt: pi.getRuntimeHistory(key)?.created ?? new Date().toISOString(),
              sessionFile: context.sessionFile,
              configuration: { agentPlugins },
              status: busy(key) ? 'running' : 'idle',
              temporary: isTemporary || undefined,
            }
            await store.saveSession(session)
          }
        }
        let view = runtime.get(session.sessionId)
        if (!view || view.sessionKey !== key) {
          if (view) pi.releaseClientView(view)
          view = pi.createClientView()
          view.clientId = `control:${session.sessionId}`
          view.sessionKey = key
          runtime.set(session.sessionId, view)
        }
        await sync(session, view)
        const status = busy(key)
          ? 'running'
          : session.status === 'running' && !active.has(session.sessionId)
            ? 'idle'
            : session.status
        if (session.status !== status) {
          session.status = status
          await store.saveSession(session)
        }
        return session
      })()
      runtimeBindings.set(key, pending)
      try {
        return structuredClone(await pending)
      } finally {
        if (runtimeBindings.get(key) === pending) runtimeBindings.delete(key)
      }
    },
    selectedAgentPlugins(key: string) {
      let session = store.state.sessions.find((item) => runtime.get(item.sessionId)?.sessionKey === key)
      // 分叉会先创建 Worker，再登记会话；此时还没有可读取的绑定。
      if (!session && pi.getRuntimeHistory(key)) {
        const sessionFile = pi.readSessionBinding(key).sessionFile
        if (sessionFile) session = store.state.sessions.find((item) => item.sessionFile === sessionFile)
      }
      return session?.configuration.agentPlugins
    },
    publish: store.publish.bind(store),
    publishLive: store.publishLive.bind(store),
    subscribe: store.subscribe.bind(store),
    store,
    async lookupSessionIds(paths: string[], keys: string[]): Promise<Record<string, string>> {
      const result: Record<string, string> = {}
      for (const session of store.state.sessions) {
        if (session.sessionFile && paths.includes(session.sessionFile)) {
          result[session.sessionFile] = session.sessionId
        }
        const runtimeView = runtime.get(session.sessionId)
        if (runtimeView?.sessionKey && keys.includes(runtimeView.sessionKey)) {
          result[runtimeView.sessionKey] = session.sessionId
        }
      }
      return result
    },
    async deleteSessions(result: {
      deletedPaths: string[]
      deletedKeys: string[]
      deletedSessionIds?: string[]
    }): Promise<{ deletedSessionIds: string[] }> {
      const deletedPaths = new Set(result.deletedPaths)
      const deletedKeys = new Set(result.deletedKeys)
      const deletedSessionIdsInput = new Set(result.deletedSessionIds ?? [])
      const targetSessions = store.state.sessions.filter(
        (item) =>
          deletedSessionIdsInput.has(item.sessionId) ||
          (item.sessionFile && deletedPaths.has(item.sessionFile)) ||
          (runtime.has(item.sessionId) && deletedKeys.has(runtime.get(item.sessionId)!.sessionKey!)),
      )

      const allSessionIds = new Set([...deletedSessionIdsInput, ...targetSessions.map((s) => s.sessionId)])

      for (const sid of allSessionIds) {
        await store.waitForSessionOperations(sid)
      }

      for (const sid of allSessionIds) {
        for (const [terminalId, root] of [...terminalRoots.entries()]) {
          if ('sessionId' in root && root.sessionId === sid) {
            await options.workspace.terminal.close({ hostId, terminalId }, { idempotencyKey: randomUUID() })
            terminalRoots.delete(terminalId)
          }
        }
      }

      const deletedSessionIds: string[] = []
      for (const session of targetSessions) {
        deletedSessionIds.push(session.sessionId)
        // 1. 终结排队提交，发布 cancelled 回执
        const queue = queues.get(session.sessionId)
        if (queue) {
          for (const pending of queue) {
            pending.receipt.status = 'cancelled'
            await publishReceipt(session, pending.receipt)
          }
          queues.delete(session.sessionId)
        }
        // 2. 终结活跃提交
        const run = active.get(session.sessionId)
        if (run) {
          run.cancelled = true
          for (const receipt of run.receipts) {
            if (['accepted', 'queued', 'running'].includes(receipt.status)) {
              receipt.status = 'cancelled'
              await publishReceipt(session, receipt)
            }
          }
          active.delete(session.sessionId)
        }
        // 3. 从 store 逻辑删除 session，追加 session_delete 日志并移出 sessions
        await store.deleteSession(session.sessionId)
        // 4. 释放 runtime view
        const view = runtime.get(session.sessionId)
        if (view) {
          runtime.delete(session.sessionId)
          pi.releaseClientView(view)
        }
      }

      for (const sid of deletedSessionIdsInput) {
        if (!deletedSessionIds.includes(sid)) {
          queues.delete(sid)
          active.delete(sid)
          await store.deleteSession(sid)
          const view = runtime.get(sid)
          if (view) {
            runtime.delete(sid)
            pi.releaseClientView(view)
          }
          deletedSessionIds.push(sid)
        }
      }

      return { deletedSessionIds }
    },
    registerTemporarySession: async (session: AppSession, runtimeKey?: string) => {
      session.temporary = true
      if (runtimeKey) {
        let view = runtime.get(session.sessionId)
        if (!view || view.sessionKey !== runtimeKey) {
          if (view) pi.releaseClientView(view)
          view = pi.createClientView()
          view.clientId = `control:${session.sessionId}`
          view.sessionKey = runtimeKey
          runtime.set(session.sessionId, view)
        }
      }
      await store.saveSession(session)
      await publishSession(session)
      return session
    },
    prepareMaintenance() {
      store.assertIdle()
      if (active.size || locks.size || jobs.size || restores.size || [...queues.values()].some((queue) => queue.length))
        throw new Error('仍有运行或排队的任务，请先处理后再维护存储')
      closing = true
    },
    async beginShutdown() {
      closing = true
      for (const timer of goalTimers.values()) clearTimeout(timer)
      goalTimers.clear()
      for (const goal of goals.list())
        if (goal.status === 'active') await goals.stop(goal.session, 'paused', 'Host 已关闭，请手动恢复目标')
      for (const run of active.values()) run.cancelled = true
      for (const receipt of store.state.receipts)
        if (['accepted', 'queued', 'running'].includes(receipt.status)) {
          receipt.status = 'interrupted'
          receipt.outcomeUncertain = Boolean(receipt.dispatchStartedAt)
          receipt.error = 'Host 已关闭，任务中断；不会重新执行'
          const session = getSession(receipt.session, 'host-internal')
          session.status = 'interrupted'
          await publishReceipt(session, receipt)
        }
    },
    async dispose() {
      closing = true
      await Promise.allSettled(jobs)
      for (const view of runtime.values()) pi.releaseClientView(view)
      await store.flush()
      await goals.flush()
    },
  }
}
