import { createSystemTools } from './system-tools'
import type { WorkerAdmission } from './worker-session'
import { SystemReadError } from '@pi-meme/contracts/system-read'
import { projectBranchVisualizations } from '@pi-meme/contracts/visualize'
import type { VisualizationRequest, VisualizationDocument } from '@pi-meme/contracts/visualize'
import type { Goal, GoalRequest, GoalRun } from '@pi-meme/contracts/goal'
import type { MemoryRuntimeBridge, MemoryRuntimeResult } from '@pi-meme/contracts/memory'
import type { ImageGenerationRequest, ImageGenerationReply } from '@pi-meme/contracts/image-generation'
import type { ServiceActivityRequest, ServiceActivityResult } from '@pi-meme/contracts/service-activity'
import { createAppAgent } from '@pi-meme/pi-runtime/sdk/app-agent'
import { createRestrictedAgent } from '@pi-meme/pi-runtime/sdk/restricted-agent'
import { createPluginServerClient } from '@pi-meme/plugin-sdk/rpc'
import type { PluginRuntimeRequest, PluginUiRequest } from '@pi-meme/contracts/plugin-call'
import {
  validateWorkerCommand,
  type HostWorkerMessage,
  type SessionWorkerData,
  type WorkerReply,
} from './worker-protocol'
import { parentPort, workerData } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'
import type { CollaborationRequest, CollaborationResults } from '@pi-meme/contracts/collaboration'
import type { PlanDocument, PlanState, SavePlanInput } from '@pi-meme/contracts/plan'
import type { InlineExtension, ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { DesktopSettings } from '@pi-meme/contracts/settings'
import { canUseExternalAgentTools, isAgentAccessMode, type AgentAccessMode } from '@pi-meme/contracts/agent-access'
import { isTaskMode } from '@pi-meme/contracts/plan'
import type { ResourceSnapshot } from '@pi-meme/contracts/resources'
import { SdkSession, type RuntimePolicy } from '@pi-meme/pi-runtime/sdk/session'
import { createPiRuntimePaths, createTemporaryRuntimePaths } from '@pi-meme/pi-runtime/runtime-paths'
import { MemoryCredentialStorage } from '@pi-meme/pi-runtime/secure-store'
import { loadPiSdk, loadPiAgentCore } from '@pi-meme/pi-runtime/sdk/load'
import { createStreamCoalescer } from './stream-coalescer'
import type { ContextCapture, ContextRuntimeCapture } from '@pi-meme/contracts/context-window'

export type SessionWorkerContext = {
  requestMemory: MemoryRuntimeBridge
  registerContextCaptureHandler: (handler: (event: ContextRuntimeCapture) => void) => void
  requestContextCapture: (capture: ContextCapture) => Promise<void>
  requestVisualization: (request: VisualizationRequest, signal?: AbortSignal) => Promise<VisualizationDocument>
  sdk: typeof import('@earendil-works/pi-coding-agent')
  agentCore: typeof import('@earendil-works/pi-agent-core')
  paths: ReturnType<typeof createPiRuntimePaths>
  credentials: MemoryCredentialStorage
  settings: DesktopSettings
  cwd: string
  resourceSnapshot?: ResourceSnapshot
  accessMode: () => AgentAccessMode
  requestImageGeneration: (request: ImageGenerationRequest, signal?: AbortSignal) => Promise<ImageGenerationReply>
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
  taskProgressEnabled: () => boolean
  acquireMcpRefreshLock: import('@pi-meme/contracts/mcp').AcquireMcpRefreshLock
  registerMcpReferences: (validate: NonNullable<RuntimePolicy['validateMcpReferences']>) => void
  registerInteractionPolicy: (enabled: boolean) => void
  registerResourcePolicy: (value: RuntimePolicy['resourcePaths']) => void
  registerSandbox: (factory: RuntimePolicy['createSandbox']) => void
  registerAccessExtension: (factory: RuntimePolicy['createAccessExtension']) => void
}
export type SessionWorkerFactory = (context: SessionWorkerContext) => InlineExtension[] | Promise<InlineExtension[]>
export function runSessionWorker(builtins: Record<string, SessionWorkerFactory> = {}) {
  const data = workerData as SessionWorkerData
  if (!parentPort) throw new Error('会话入口只能由 Worker 启动')
  if (!isAgentAccessMode(data.access) || !isTaskMode(data.taskMode)) throw new Error('Worker 执行权限或模式无效')
  const port = parentPort
  const basePaths = createPiRuntimePaths(data.root)
  const paths = data.temporaryRoot ? createTemporaryRuntimePaths(basePaths, data.temporaryRoot) : basePaths
  const credentials = new MemoryCredentialStorage()
  for (const [key, value] of data.credentials) credentials.set(key, value)
  const pendingCredentials = new Map<number, { resolve: () => void; reject: (cause: Error) => void }>()
  let credentialId = 0
  let credentialWrites: Promise<void> = Promise.resolve()
  function mutate(key: string, value?: string, previous?: string) {
    const id = ++credentialId
    const pending = new Promise<void>((resolve, reject) => {
      pendingCredentials.set(id, { resolve, reject })
    })
    credentialWrites = Promise.all([credentialWrites, pending]).then(() => {})
    void credentialWrites.catch(() => {})
    port.postMessage({ credential: { id, key, value, previous } })
  }
  const localSet = credentials.set.bind(credentials)
  credentials.set = (key, value) => {
    const previous = key.startsWith('mcp-oauth:') ? credentials.get(key) : undefined
    localSet(key, value)
    mutate(key, value, previous)
  }
  const localDelete = credentials.delete.bind(credentials)
  credentials.delete = (key) => {
    const previous = key.startsWith('mcp-oauth:') ? credentials.get(key) : undefined
    const deleted = localDelete(key)
    if (deleted) mutate(key, undefined, previous)
    return deleted
  }
  let taskProgressEnabled = data.settings.taskProgressEnabled !== false
  let session: SdkSession
  function send(value: Omit<WorkerReply, 'connection' | 'active'>): void {
    return port.postMessage({
      ...value,
      connection: session.connection(),
      active: session.getActiveSession(),
    } satisfies WorkerReply)
  }
  const stream = createStreamCoalescer((value) => send({ notify: 'event', value }))
  const policy: RuntimePolicy = {
    recordTurnChange: (change) => hostRequest('turnChange', { change }) as Promise<string>,
    readVisualization: async (reference) => {
      const { entries, leafId } = await session.getEntries()
      return hostRequest('visualize', {
        visualizationRequest: { action: 'read', reference, references: projectBranchVisualizations(entries, leafId) },
      }) as Promise<VisualizationDocument>
    },
    resolvePlan: (reference, signal) => hostRequest('resolvePlan', { reference }, signal) as Promise<PlanDocument>,
    syncPlan: (force) => hostRequest('syncPlan', { force }) as Promise<PlanState>,
    onHistoryEdited: () => hostRequest('historyEdited', {}) as Promise<void>,
    initialGeneration: data.initialGeneration,
    requireRestrictedPolicy: true,
    resourceSnapshot: data.resourceSnapshot,
    promptTemplates: data.promptTemplates,
    agentSources: data.agentEntries,
    externalTools: new Map(),
    pluginFailures: new Map(),
    onAdmission: async (message, mode, continuation, signal, origin, expected, sourceClientId, selectedModel) => {
      const admission = (await hostRequest(
        'admission',
        { message, mode, continuation, origin, expected, sourceClientId, selectedModel },
        signal,
      )) as WorkerAdmission | undefined
      taskProgressEnabled = admission?.taskProgressEnabled ?? data.settings.taskProgressEnabled !== false
      return admission?.goalRun
    },
    onGoalGate: (tool) => hostRequest('goal', { goalRequest: { method: 'gate', tool }, goalRun: session.getGoalRun() }),
    onGoalUsage: (goalRun, entryId, usage, inputEntryId) =>
      hostRequest('goalUsage', { goalRun, entryId, usage, inputEntryId }) as Promise<void>,
  }
  session = new SdkSession(
    data.cwd,
    {
      connection: (value) => {
        stream.flush()
        send({ notify: 'connection', value })
      },
      event: (value) => stream.push(value),
      error: (value) => {
        stream.flush()
        send({ notify: 'error', value })
      },
      title: (value) => {
        stream.flush()
        send({ notify: 'title', value })
      },
    },
    paths,
    credentials,
    undefined,
    policy,
  )
  session.configureComposerHint(data.settings.showComposerHint !== false)
  const pendingHost = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (cause: Error) => void; cleanup: () => void }
  >()
  function hostRequest(
    kind:
      | 'contextCapture'
      | 'mcpRefresh'
      | 'turnChange'
      | 'collaboration'
      | 'savePlan'
      | 'resolvePlan'
      | 'syncPlan'
      | 'historyEdited'
      | 'admission'
      | 'goal'
      | 'goalUsage'
      | 'visualize'
      | 'image-generation'
      | 'activity'
      | 'memory'
      | 'system'
      | 'plugin',
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
    const extensions: InlineExtension[] = [
      createSystemTools(
        (systemRequest, signal) => hostRequest('system', { systemRequest }, signal),
        () => session.getTaskMode(),
        () => session.getAccessMode(),
      ),
    ]
    for (const create of Object.values(builtins)) {
      extensions.push(
        ...(await create({
          sdk,
          registerContextCaptureHandler: (handler) => session.setContextCaptureHandler(handler),
          requestContextCapture: (capture) => hostRequest('contextCapture', { capture }).then(() => {}),
          requestMemory: (memoryRequest, signal) =>
            hostRequest('memory', { memoryRequest }, signal) as Promise<MemoryRuntimeResult>,
          agentCore,
          paths,
          credentials,
          settings: data.settings,
          cwd: data.cwd,
          resourceSnapshot: data.resourceSnapshot,
          taskMode: () => session.getTaskMode(),
          accessMode: () => session.getAccessMode(),
          requestVisualization: (visualizationRequest: VisualizationRequest, signal?: AbortSignal) =>
            hostRequest('visualize', { visualizationRequest }, signal) as Promise<VisualizationDocument>,
          requestImageGeneration: (imageRequest, signal) =>
            hostRequest('image-generation', { imageRequest }, signal) as Promise<ImageGenerationReply>,
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
          taskProgressEnabled: () => taskProgressEnabled,
          acquireMcpRefreshLock: async (key) => {
            const lock = (await hostRequest('mcpRefresh', { mcpKey: key })) as { id: string; value?: string }
            if (lock.value === undefined) localDelete(key)
            else localSet(key, lock.value)
            return async () => {
              try {
                await credentialWrites
              } finally {
                await hostRequest('mcpRefresh', { releaseLock: lock.id })
              }
            }
          },
          registerMcpReferences: (validate) => {
            policy.validateMcpReferences = validate
          },
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
    for (const entry of canUseExternalAgentTools(data.access, data.taskMode) ? data.agentEntries : []) {
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
    await session.setSessionMode(data.taskMode)
  })()
  port.on('message', (request: HostWorkerMessage) => {
    if ('mcpCredential' in request) {
      const { key, value } = request.mcpCredential
      if (key.startsWith('mcp-oauth:')) {
        if (value === undefined) localDelete(key)
        else localSet(key, value)
      }
      return
    }
    if ('hostReply' in request) {
      const pending = pendingHost.get(request.hostReply)
      pendingHost.delete(request.hostReply)
      pending?.cleanup()
      if (request.error)
        pending?.reject(
          request.errorCode
            ? new SystemReadError(request.errorCode, request.error, request.errorDetails)
            : new Error(request.error),
        )
      else pending?.resolve(request.result)
      return
    }
    if ('credentialReply' in request) {
      const pending = pendingCredentials.get(request.credentialReply)
      pendingCredentials.delete(request.credentialReply)
      if (request.error) pending?.reject(new Error(request.error))
      else pending?.resolve()
      return
    }
    void ready
      .then(async () => {
        validateWorkerCommand(request)
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
        stream.flush()
        const result: unknown = await Reflect.apply(method, session, request.args)
        stream.flush()
        await credentialWrites
        send({ id: request.id, result })
      })
      .catch((cause: unknown) => {
        stream.flush()
        send({ id: request.id, error: cause instanceof Error ? cause.message : String(cause) })
      })
  })
}
