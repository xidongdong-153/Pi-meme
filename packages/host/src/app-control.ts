import { randomUUID } from 'node:crypto'
import type {
  AppProject,
  AppSession,
  HostApi,
  HostControlRequest,
  HostControlResponse,
  SessionConfiguration,
  SessionRef,
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
import { getGitDiff, getGitEnvironment, getGitSnapshot } from '@pi-meme/git/server/git-service'
import type { CollaborationBridge } from '@pi-meme/contracts/collaboration'
import { ControlStore, ControlError } from './control-store'

type Options = {
  hostId: string
  root: string
  pi: PiSessionPool
  projects: ProjectStore
  sessions: SessionService
  collaboration: CollaborationBridge & {
    respondExtensionUI: (
      key: string,
      id: string,
      response: import('@pi-meme/contracts/pi').PiExtensionUIResponse,
    ) => Promise<unknown>
  }
  bindRoot: (key: string) => Promise<unknown>
  configureAgentPlugins: (key: string, ids: string[]) => Promise<void>
  defaultAgentPlugins: HostApi['plugins']
  availableAgentPlugins: () => string[]
  snapshot: () => Promise<import('@pi-meme/contracts/desktop').Snapshot>
  workspace: { files: HostApi['files']; terminal: HostApi['terminal']; terminalSupported: boolean }
  onError: (cause: unknown) => void
}
type Pending = { input: SubmissionInput; receipt: SubmissionReceipt }
type Active = { receipts: SubmissionReceipt[]; error?: string; cancelled?: boolean; runId?: string }
export async function createAppControl(options: Options) {
  const { hostId, pi, projects, sessions, collaboration } = options
  const store = new ControlStore(options.root, hostId)
  await store.init()
  const runtime = new Map<string, ClientView>()
  const rootAgents = new Map<string, string>()
  const restores = new Map<string, Promise<ClientView>>()
  const queues = new Map<string, Pending[]>()
  const active = new Map<string, Active>()
  const locks = new Map<string, Promise<unknown>>()
  const paused = new Set<string>()
  const jobs = new Set<Promise<unknown>>()
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
  const getSession = (ref: SessionRef) => {
    assertHost(ref)
    const session = store.state.sessions.find((item) => item.sessionId === ref.sessionId)
    if (!session) throw new Error('会话不存在')
    return session
  }
  const projectFor = async (cwd: string): Promise<AppProject | undefined> => {
    const source = projects.sourceProjectCwd(cwd) ?? cwd
    if (projects.kind(source) !== 'project') return
    let project = store.state.projects.find((item) => item.cwd === source)
    if (!project) {
      const registered = (await projects.list([source])).find((item) => item.cwd === source)!
      project = store.state.projects.find((item) => item.cwd === source)
      if (project) return project
      project = {
        hostId,
        projectId: randomUUID(),
        cwd: source,
        name: registered.name,
        unavailable: registered.unavailable,
      }
      store.state.projects.push(project)
      await store.save()
    }
    return project
  }
  const sync = async (session: AppSession, view: ClientView, persist = true) => {
    const context = pi.readSessionBinding(view.sessionKey!)
    session.sessionFile = context.sessionFile ?? session.sessionFile
    session.configuration = {
      ...session.configuration,
      model: context.state.model,
      thinkingLevel: context.state.thinkingLevel,
      accessMode: context.accessMode,
      mode: context.state.mode,
    }
    session.name = context.state.sessionName ?? session.name
    if (persist) await store.save()
  }
  const busy = (key: string) => Boolean(pi.getRuntimeSessions().find((item) => item.id === key)?.running)
  const configure = async (session: AppSession, view: ClientView, config: SessionConfiguration) => {
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('会话配置无效')
    if (config.mode !== undefined && config.mode !== 'default' && config.mode !== 'plan')
      throw new Error('会话模式无效')
    if (
      config.thinkingLevel !== undefined &&
      !['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(config.thinkingLevel)
    )
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
    if (active.has(session.sessionId) || busy(key)) throw new Error('会话正在运行，不能修改配置')
    if (config.agentPlugins !== undefined) await options.configureAgentPlugins(key, config.agentPlugins)
    if (config.mode !== undefined) await pi.setSessionMode(key, config.mode)
    if (config.accessMode !== undefined) await pi.setAccessMode(key, config.accessMode)
    if (config.model !== undefined) await pi.setModel(key, config.model)
    if (config.thinkingLevel !== undefined) await pi.setThinkingLevel(key, config.thinkingLevel)
    session.configuration = { ...session.configuration, ...config }
    await sync(session, view)
    return structuredClone(session)
  }
  const resolveSession = async (ref: SessionRef): Promise<ClientView> => {
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
          await configure(session, view, {
            ...session.configuration,
            agentPlugins: session.configuration.agentPlugins?.filter((id) =>
              options.availableAgentPlugins().includes(id),
            ),
          })
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
  ): Promise<T> => {
    const view = await resolveSession(ref)
    return pi.withClientView(view, () => action(view.sessionKey!, getSession(ref), view))
  }
  const resolveRoot = async (ref: WorkspaceRef) => {
    assertHost(ref)
    return 'projectId' in ref ? getProject(ref).cwd : getSession(ref).cwd
  }
  const refresh = async () => {
    const saved = await sessions.getSnapshot()
    const summaries = [
      ...saved.projects.flatMap((group) => group.sessions),
      ...(saved.standaloneSessions ?? []),
      ...saved.recents,
      ...pi.getRuntimeSessions(),
    ]
    for (const registered of await projects.list(summaries.map((item) => item.cwd))) {
      const project = await projectFor(registered.cwd)
      if (project) Object.assign(project, { name: registered.name, unavailable: registered.unavailable })
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
          store.state.sessions.push(session)
        }
      }
      if (!summary.path.startsWith('runtime:')) session.sessionFile = summary.path
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
      if (summary.running) session.status = 'running'
    }
    for (const session of store.state.sessions) {
      const view = runtime.get(session.sessionId)
      if (!view) continue
      try {
        await sync(session, view, false)
      } catch {
        runtime.delete(session.sessionId)
        continue
      }
      if (busy(view.sessionKey!)) session.status = 'running'
      else if (session.status === 'running' && !active.has(session.sessionId)) session.status = 'idle'
    }
    await store.save()
  }
  const publishReceipt = (session: AppSession, receipt: SubmissionReceipt) =>
    store.publish({
      type: 'submission',
      sessionId: session.sessionId,
      projectId: session.project?.projectId,
      value: receipt,
    })
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
          if (input.delivery === 'steer')
            await pi.steer(key, input.text, input.images, input.skills, { mode: input.mode })
          else await pi.prompt(key, input.text, input.images, input.skills, { mode: input.mode })
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
  const stop = (ref: SessionRef) =>
    target(ref, (key, session, view) =>
      serial(session.sessionId, async () => {
        const run = active.get(session.sessionId)
        if (run) run.cancelled = true
        for (const pending of queues.get(session.sessionId) ?? []) {
          pending.receipt.status = 'cancelled'
          await publishReceipt(session, pending.receipt)
        }
        queues.delete(session.sessionId)
        await pi.abort(key)
        if (run) await finish(session, view, run, true)
        else {
          session.status = 'interrupted'
          await publishSession(session)
        }
      }),
    )
  const mutate = <T>(
    clientId: string,
    method: string,
    args: unknown[],
    opts: MutationOptions,
    action: (operationId: string) => Promise<T>,
  ) => store.mutate(clientId, opts?.idempotencyKey, method, args, action)
  const apiFor = (clientId: string): HostApi => ({
    apiVersion: 2,
    capabilities: async () => ({
      apiVersion: 2,
      hostId,
      features: [
        'projects',
        'sessions',
        'files',
        'git',
        'interaction',
        'agents',
        'plans',
        ...(options.workspace.terminalSupported ? ['terminal' as const] : []),
      ],
    }),
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
          if (input.name) project.name = input.name
          await store.save()
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
          store.state.sessions.push(session)
          await store.save()
          await resolveSession(session)
          await publishSession(session)
          return session
        }),
      list: async (input = {}) => {
        if (input?.project) getProject(input.project)
        await refresh()
        return structuredClone(
          store.state.sessions.filter((item) => !input?.project || item.project?.projectId === input.project.projectId),
        )
      },
      get: async (ref) => {
        await refresh()
        return structuredClone(getSession(ref))
      },
      snapshot: (ref) =>
        target(ref, async (_key, session, view) => {
          const controlCursor = store.read().cursor
          const result = await options.snapshot()
          await sync(session, view)
          return { ...result, controlCursor }
        }),
      history: (ref, input) =>
        target(ref, async (key, session) => {
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
        }),
      configure: (ref, config, opts) =>
        mutate(clientId, 'sessions.configure', [ref, config], opts, () =>
          target(ref, (_key, session, view) => serial(session.sessionId, () => configure(session, view, config))),
        ),
      submit: (ref, input, opts) =>
        mutate(clientId, 'sessions.submit', [ref, input], opts, (operationId) =>
          target(ref, (key, session, view) =>
            serial(session.sessionId, async () => {
              if (
                typeof input?.text !== 'string' ||
                !input.text.trim() ||
                !['start', 'queue', 'steer'].includes(input.delivery)
              )
                throw new Error('提交正文或投递方式无效')
              if (input.mode !== undefined && input.mode !== 'default' && input.mode !== 'plan')
                throw new Error('会话模式无效')
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
              } else {
                const queue = queues.get(session.sessionId) ?? []
                queue.push({ input, receipt })
                queues.set(session.sessionId, queue)
                await startNext(session, view)
                if (receipt.status === 'accepted') {
                  receipt.status = 'queued'
                  await publishReceipt(session, receipt)
                }
              }
              return receipt
            }),
          ),
        ),
      stop: (ref, opts) => mutate(clientId, 'sessions.stop', [ref], opts, () => stop(ref)),
      pause: (ref, opts) =>
        mutate(clientId, 'sessions.pause', [ref], opts, () =>
          target(ref, async (key, session) => {
            paused.add(session.sessionId)
            await pi.pause(key)
          }),
        ),
      resume: (ref, opts) =>
        mutate(clientId, 'sessions.resume', [ref], opts, () =>
          target(ref, (key, session, view) =>
            serial(session.sessionId, async () => {
              await pi.resume(key)
              paused.delete(session.sessionId)
              await startNext(session, view)
            }),
          ),
        ),
      receipt: async (id) => {
        const receipt = store.state.receipts.find((item) => item.operationId === id)
        if (!receipt) throw new Error('提交回执不存在')
        return structuredClone(receipt)
      },
      submissions: async (ref) => {
        getSession(ref)
        return structuredClone(store.state.receipts.filter((item) => item.session.sessionId === ref.sessionId))
      },
      cancelSubmission: (id, opts) =>
        mutate(clientId, 'sessions.cancelSubmission', [id], opts, async () => {
          const receipt = store.state.receipts.find((item) => item.operationId === id)
          if (!receipt) throw new Error('提交回执不存在')
          await serial(receipt.session.sessionId, async () => {
            if (receipt.status === 'cancelled') return
            if (receipt.status !== 'queued') throw new Error('只能撤销排队提交；已投递的任务请停止会话')
            queues.set(
              receipt.session.sessionId,
              (queues.get(receipt.session.sessionId) ?? []).filter((item) => item.receipt !== receipt),
            )
            receipt.status = 'cancelled'
            await publishReceipt(getSession(receipt.session), receipt)
          })
        }),
    },
    events: {
      read: async (input = {}) => store.read(input ?? {}),
      subscribe: async (input, callback) => store.subscribe(input, callback),
    },
    files: options.workspace.files,
    terminal: {
      open: (ref, input, opts) =>
        mutate(clientId, 'terminal.open', [ref, input], opts, () => options.workspace.terminal.open(ref, input, opts)),
      attach: (ref) => options.workspace.terminal.attach(ref),
      input: (ref, data, opts) =>
        mutate(clientId, 'terminal.input', [ref, data], opts, () => options.workspace.terminal.input(ref, data, opts)),
      resize: (ref, size, opts) =>
        mutate(clientId, 'terminal.resize', [ref, size], opts, () =>
          options.workspace.terminal.resize(ref, size, opts),
        ),
      close: (ref, opts) =>
        mutate(clientId, 'terminal.close', [ref], opts, () => options.workspace.terminal.close(ref, opts)),
    },
    git: {
      environment: async (ref) => getGitEnvironment(await resolveRoot(ref)),
      snapshot: async (ref) => getGitSnapshot(await resolveRoot(ref)),
      diff: async (ref, input) => getGitDiff(await resolveRoot(ref), input.path, input.staged ? 'staged' : 'unstaged'),
    },
    interaction: {
      respond: (ref, input, opts) =>
        mutate(clientId, 'interaction.respond', [ref, input], opts, () =>
          target(ref, async (key) => {
            if (input.agentId) {
              const agents = await collaboration.getAgents(key)
              const agent = agents.find((item) => item.agentId === input.agentId)
              if (!agent) throw new Error('Agent 不属于目标会话')
              await collaboration.respondExtensionUI(agent.sessionKey, input.requestId, input.response)
            } else await pi.respondExtensionUI(key, input.requestId, input.response)
          }),
        ),
    },
    agents: {
      list: (ref) =>
        target(ref, async (key) => {
          await options.bindRoot(key)
          return collaboration.getAgents(key)
        }),
      get: (id) => collaboration.getAgentSnapshot(id),
      stop: (id, opts) => mutate(clientId, 'agents.stop', [id], opts, () => collaboration.interruptAgent(id)),
    },
    plans: { list: (ref) => target(ref, async () => (await options.snapshot()).planDocuments ?? []) },
  })
  const api = apiFor('host-internal')
  const writes = new Set([
    'plugins.setDefaultAgentPlugins',
    'projects.register',
    'sessions.create',
    'sessions.configure',
    'sessions.submit',
    'sessions.stop',
    'sessions.pause',
    'sessions.resume',
    'sessions.cancelSubmission',
    'terminal.open',
    'terminal.input',
    'terminal.resize',
    'terminal.close',
    'interaction.respond',
    'agents.stop',
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
    dispatch,
    observe,
    resolveRoot,
    async sessionForRuntime(key: string) {
      await refresh()
      let session = store.state.sessions.find((item) => runtime.get(item.sessionId)?.sessionKey === key)
      if (!session) {
        const context = pi.getSessionContext(key)
        session = context.sessionFile
          ? store.state.sessions.find((item) => item.sessionFile === context.sessionFile)
          : undefined
        if (!session) {
          const project = await projectFor(context.cwd)
          session = {
            hostId,
            sessionId: randomUUID(),
            project: project && { hostId, projectId: project.projectId },
            cwd: context.cwd,
            createdAt: new Date().toISOString(),
            sessionFile: context.sessionFile,
            configuration: { agentPlugins: await options.defaultAgentPlugins.getDefaultAgentPlugins() },
            status: busy(key) ? 'running' : 'idle',
          }
          store.state.sessions.push(session)
        }
        const view = pi.createClientView()
        view.clientId = `control:${session.sessionId}`
        view.sessionKey = key
        runtime.set(session.sessionId, view)
        await sync(session, view)
      }
      return structuredClone(session)
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
    async beginShutdown() {
      closing = true
      for (const run of active.values()) run.cancelled = true
      for (const receipt of store.state.receipts)
        if (['accepted', 'queued', 'running'].includes(receipt.status)) {
          receipt.status = 'interrupted'
          receipt.outcomeUncertain = Boolean(receipt.dispatchStartedAt)
          receipt.error = 'Host 已关闭，任务中断；不会重新执行'
          const session = getSession(receipt.session)
          session.status = 'interrupted'
          await publishReceipt(session, receipt)
        }
    },
    async dispose() {
      closing = true
      await Promise.allSettled(jobs)
      for (const view of runtime.values()) pi.releaseClientView(view)
      await store.flush()
    },
  }
}
