import type { Goal, GoalRequest, GoalRun } from '@pi-meme/contracts/goal'
import type { ServiceActivityRequest, ServiceActivityResult } from '@pi-meme/contracts/service-activity'
import { createAppAgent } from '@pi-meme/pi-runtime/sdk/app-agent'
import { createRestrictedAgent } from '@pi-meme/pi-runtime/sdk/restricted-agent'
import { createPluginServerClient } from '@pi-meme/plugin-sdk/rpc'
import type { PluginRuntimeRequest, PluginUiRequest } from '@pi-meme/contracts/plugin-call'
import type { AgentPluginEntry } from '@pi-meme/plugin-sdk/agent'
import { parentPort, workerData } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'
import type { CollaborationRequest, CollaborationResults } from '@pi-meme/contracts/collaboration'
import type { PlanDocument, SavePlanInput } from '@pi-meme/contracts/plan'
import type { InlineExtension, ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { DesktopSettings } from '@pi-meme/contracts/settings'
import type { AgentAccessMode } from '@pi-meme/contracts/agent-access'
import type { ResourceSnapshot } from '@pi-meme/contracts/resources'
import { SdkSession, type RuntimePolicy } from '@pi-meme/pi-runtime/sdk/session'
import { createPiRuntimePaths } from '@pi-meme/pi-runtime/runtime-paths'
import { MemoryCredentialStorage } from '@pi-meme/pi-runtime/secure-store'
import { loadPiSdk, loadPiAgentCore } from '@pi-meme/pi-runtime/sdk/load'

export type SessionWorkerContext = {
  sdk: typeof import('@earendil-works/pi-coding-agent')
  agentCore: typeof import('@earendil-works/pi-agent-core')
  paths: ReturnType<typeof createPiRuntimePaths>
  credentials: MemoryCredentialStorage
  settings: DesktopSettings
  cwd: string
  resourceSnapshot?: ResourceSnapshot
  taskMode: () => import('@pi-meme/contracts/plan').TaskMode
  requestCollaboration: (
    request: Omit<CollaborationRequest, 'id'>,
    signal?: AbortSignal,
  ) => Promise<CollaborationResults[keyof CollaborationResults]>
  requestGoal: (request: GoalRequest, signal?: AbortSignal) => Promise<Goal | undefined>
  currentGoalRun: () => GoalRun | undefined
  requestActivity: (request: ServiceActivityRequest, signal?: AbortSignal) => Promise<ServiceActivityResult>
  savePlan: (input: SavePlanInput, signal?: AbortSignal) => Promise<PlanDocument>
  requestUserInput: (
    questions: import('@pi-meme/contracts/user-input').UserInputQuestion[],
    signal?: AbortSignal,
  ) => Promise<import('@pi-meme/contracts/user-input').UserInputResult>
  registerInteractionPolicy: (enabled: boolean) => void
  registerResourcePolicy: (value: RuntimePolicy['resourcePaths']) => void
  registerSandbox: (factory: RuntimePolicy['createSandbox']) => void
  registerAccessExtension: (factory: RuntimePolicy['createAccessExtension']) => void
  planSandbox: () => import('@pi-meme/pi-runtime/sdk/access-sandbox').AccessSandboxOperations
  registerPlanTool: (name: string, source: import('@pi-meme/contracts/plan').PlanToolSource) => void
}
export type SessionWorkerFactory = (context: SessionWorkerContext) => InlineExtension[] | Promise<InlineExtension[]>
export function runSessionWorker(builtins: Record<string, SessionWorkerFactory> = {}) {
  const data = workerData as {
    cwd: string
    root: string
    settings: DesktopSettings
    agentEntries: AgentPluginEntry[]
    credentials: Array<[string, string]>
    access: AgentAccessMode
    capabilities: DesktopSettings
    initialGeneration?: number
    resourceSnapshot?: ResourceSnapshot
  }
  if (!parentPort) throw new Error('会话入口只能由 Worker 启动')
  const port = parentPort
  const paths = createPiRuntimePaths(data.root)
  const credentials = new MemoryCredentialStorage()
  for (const [key, value] of data.credentials) credentials.set(key, value)
  const pendingCredentials = new Map<number, { resolve: () => void; reject: (cause: Error) => void }>()
  let credentialId = 0
  let credentialWrites: Promise<void> = Promise.resolve()
  function mutate(key: string, value?: string) {
    const id = ++credentialId
    const pending = new Promise<void>((resolve, reject) => {
      pendingCredentials.set(id, { resolve, reject })
    })
    credentialWrites = Promise.all([credentialWrites, pending]).then(() => {})
    void credentialWrites.catch(() => {})
    port.postMessage({ credential: { id, key, value } })
  }
  const localSet = credentials.set.bind(credentials)
  credentials.set = (key, value) => {
    localSet(key, value)
    mutate(key, value)
  }
  const localDelete = credentials.delete.bind(credentials)
  credentials.delete = (key) => {
    const deleted = localDelete(key)
    if (deleted) mutate(key)
    return deleted
  }
  let session: SdkSession
  function send(value: object): void {
    return port.postMessage({ ...value, connection: session.connection(), active: session.getActiveSession() })
  }
  const policy: RuntimePolicy = {
    planTools: new Map(),
    resolvePlan: (reference, signal) => hostRequest('resolvePlan', { reference }, signal) as Promise<PlanDocument>,
    initialGeneration: data.initialGeneration,
    requireRestrictedPolicy: true,
    resourceSnapshot: data.resourceSnapshot,
    agentSources: data.agentEntries,
    externalTools: new Map(),
    pluginFailures: new Map(),
    onAdmission: (message, mode, continuation, signal, origin, expected) =>
      hostRequest('admission', { message, mode, continuation, origin, expected }, signal) as Promise<
        GoalRun | undefined
      >,
    onGoalGate: (tool) => hostRequest('goal', { goalRequest: { method: 'gate', tool }, goalRun: session.getGoalRun() }),
    onGoalUsage: (goalRun, entryId, usage, inputEntryId) =>
      hostRequest('goalUsage', { goalRun, entryId, usage, inputEntryId }) as Promise<void>,
  }
  session = new SdkSession(
    data.cwd,
    {
      connection: (value) => send({ notify: 'connection', value }),
      event: (value) => send({ notify: 'event', value }),
      error: (value) => send({ notify: 'error', value }),
      title: (value) => send({ notify: 'title', value }),
    },
    paths,
    credentials,
    undefined,
    policy,
  )
  const pendingHost = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (cause: Error) => void; cleanup: () => void }
  >()
  function hostRequest(
    kind: 'collaboration' | 'savePlan' | 'resolvePlan' | 'admission' | 'goal' | 'goalUsage' | 'activity' | 'plugin',
    request: object,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(new Error('协作请求已取消'))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const abort = () => {
        const pending = pendingHost.get(id)
        pendingHost.delete(id)
        pending?.cleanup()
        port.postMessage({ hostCancel: id })
        reject(new Error('协作请求已取消'))
      }
      const cleanup = () => signal?.removeEventListener('abort', abort)
      pendingHost.set(id, { resolve, reject, cleanup })
      signal?.addEventListener('abort', abort, { once: true })
      port.postMessage({ hostRequest: { kind, id, ...request } })
    })
  }
  const pluginUi = new Map<string, (input: PluginUiRequest) => Promise<unknown>>()
  const pluginUiControllers = new Map<string, AbortController>()
  const ready = (async () => {
    const sdk = await loadPiSdk()
    const agentCore = await loadPiAgentCore()
    const extensions: InlineExtension[] = []
    for (const create of Object.values(builtins)) {
      extensions.push(
        ...(await create({
          sdk,
          agentCore,
          paths,
          credentials,
          settings: data.settings,
          cwd: data.cwd,
          resourceSnapshot: data.resourceSnapshot,
          taskMode: () => session.getTaskMode(),
          planSandbox: () => session.getPlanSandbox(),
          registerPlanTool: (name, source) => policy.planTools!.set(name, source),
          requestCollaboration: (request, signal) =>
            hostRequest('collaboration', request, signal) as Promise<CollaborationResults[keyof CollaborationResults]>,
          requestActivity: (activityRequest, signal) =>
            hostRequest('activity', { activityRequest }, signal) as Promise<ServiceActivityResult>,
          requestGoal: (goalRequest, signal) =>
            hostRequest('goal', { goalRequest, goalRun: session.getGoalRun() }, signal) as Promise<Goal | undefined>,
          currentGoalRun: () => session.getGoalRun(),
          savePlan: (input, signal) =>
            hostRequest(
              'savePlan',
              { input: { ...input, reference: session.getPlanReference() } },
              signal,
            ) as Promise<PlanDocument>,
          requestUserInput: (questions, signal) => session.requestUserInput(questions, signal),
          registerInteractionPolicy: (enabled) => {
            policy.uiEnabled = enabled
          },
          registerResourcePolicy: (value) => {
            policy.resourcePaths = value
          },
          registerSandbox: (factory) => {
            policy.createSandbox = factory
          },
          registerAccessExtension: (factory) => {
            policy.createAccessExtension = factory
          },
        })),
      )
    }
    const reservedNames = new Set<string>()
    const instrumentBuiltin = (api: ExtensionAPI) =>
      new Proxy(api, {
        get(target, key, receiver) {
          if (key === 'registerTool')
            return (tool: ToolDefinition) => {
              reservedNames.add(tool.name)
              target.registerTool(tool)
            }
          return Reflect.get(target, key, receiver)
        },
      })
    for (let index = 0; index < extensions.length; index++) {
      const extension = extensions[index]
      const factory = typeof extension === 'function' ? extension : extension.factory
      extensions[index] = {
        ...(typeof extension === 'function' ? {} : extension),
        name: extension.name,
        factory: (api) => factory(instrumentBuiltin(api)),
      }
    }
    for (const entry of data.agentEntries) {
      if (entry.pluginId in builtins) throw new Error('外部 Agent 不能替换内置能力')
      const offset = extensions.length
      const pluginRequest = (request: PluginRuntimeRequest, signal?: AbortSignal) =>
        hostRequest('plugin', { pluginRequest: request }, signal)
      if (entry.restricted)
        extensions.push(
          createRestrictedAgent({
            entry,
            request: pluginRequest,
            registerUi: (id, handler) => pluginUi.set(id, handler),
            requestInput: (questions, signal) => session.requestUserInput(questions, signal),
            tools: policy.externalTools!,
            reservedNames,
          }),
        )
      if ((entry.trusted && entry.grant?.trusted.agent) || entry.path)
        extensions.push(
          createAppAgent(
            entry,
            (questions, signal) => session.requestUserInput(questions, signal),
            createPluginServerClient({
              pluginId: entry.pluginId,
              generation: entry.generation,
              policyHash: entry.grant?.policyHash,
              invoke: (request, signal) =>
                pluginRequest(
                  {
                    pluginId: entry.pluginId,
                    generation: entry.generation,
                    action: 'server',
                    name: request.operation,
                    input: request.input,
                  },
                  signal,
                ),
            }),
            policy.externalTools,
            reservedNames,
          ),
        )
      for (let index = offset; index < extensions.length; index++) {
        const extension = extensions[index]
        if (typeof extension === 'function') continue
        extensions[index] = {
          ...extension,
          factory: async (api) => {
            try {
              await extension.factory(api)
            } catch (cause) {
              policy.pluginFailures!.set(entry.pluginId, cause instanceof Error ? cause.message : String(cause))
              for (const [name, source] of policy.externalTools!)
                if (source.pluginId === entry.pluginId) policy.externalTools!.delete(name)
            }
          },
        }
      }
    }
    session.configureInlineExtensions(extensions)
    session.configureCapabilities({ codemodeEnabled: false, mcpEnabled: false })
    session.configureAccess(data.access)
  })()
  port.on(
    'message',
    (request: {
      id: number
      method: string
      args: unknown[]
      credentialReply?: number
      hostReply?: string
      result?: unknown
      error?: string
    }) => {
      if (request.hostReply) {
        const pending = pendingHost.get(request.hostReply)
        pendingHost.delete(request.hostReply)
        pending?.cleanup()
        if (request.error) pending?.reject(new Error(request.error))
        else pending?.resolve(request.result)
        return
      }
      if (request.credentialReply !== undefined) {
        const pending = pendingCredentials.get(request.credentialReply)
        pendingCredentials.delete(request.credentialReply)
        if (request.error) pending?.reject(new Error(request.error))
        else pending?.resolve()
        return
      }
      void ready
        .then(async () => {
          if (request.method === 'configureCapabilities') {
            send({ id: request.id })
            return
          }
          if (request.method === 'pluginUiCancel') {
            pluginUiControllers.get(String(request.args[0]))?.abort()
            send({ id: request.id })
            return
          }
          if (request.method === 'pluginUi') {
            const input = request.args[0] as PluginUiRequest
            const action = pluginUi.get(input.pluginId)
            if (!action || !input.scopeId || pluginUiControllers.has(input.scopeId))
              throw new Error('scope-expired: 插件交互已失效')
            const controller = new AbortController()
            pluginUiControllers.set(input.scopeId, controller)
            try {
              send({ id: request.id, result: await action({ ...input, signal: controller.signal }) })
            } finally {
              pluginUiControllers.delete(input.scopeId)
              controller.abort()
            }
            return
          }
          const method = Reflect.get(session, request.method) as unknown
          if (typeof method !== 'function' || request.method.startsWith('_')) throw new Error('Worker 操作无效')
          const result: unknown = await Reflect.apply(method, session, request.args)
          await credentialWrites
          send({ id: request.id, result })
        })
        .catch((cause: unknown) =>
          send({ id: request.id, error: cause instanceof Error ? cause.message : String(cause) }),
        )
    },
  )
}
