import { createAppAgent } from '@pi-meme/pi-runtime/sdk/app-agent'
import { parentPort, workerData } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'
import type { CollaborationRequest, CollaborationResults } from '@pi-meme/contracts/collaboration'
import type { PlanDocument, SavePlanInput } from '@pi-meme/contracts/plan'
import type { InlineExtension } from '@earendil-works/pi-coding-agent'
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
  savePlan: (input: SavePlanInput, signal?: AbortSignal) => Promise<PlanDocument>
  requestUserInput: (
    questions: import('@pi-meme/contracts/user-input').UserInputQuestion[],
    signal?: AbortSignal,
  ) => Promise<import('@pi-meme/contracts/user-input').UserInputResult>
  registerInteractionPolicy: (enabled: boolean) => void
  registerResourcePolicy: (value: RuntimePolicy['resourcePaths']) => void
  registerSandbox: (factory: RuntimePolicy['createSandbox']) => void
  registerAccessExtension: (factory: RuntimePolicy['createAccessExtension']) => void
}
export type SessionWorkerFactory = (context: SessionWorkerContext) => InlineExtension[] | Promise<InlineExtension[]>
export function runSessionWorker(builtins: Record<string, SessionWorkerFactory> = {}) {
  const data = workerData as {
    cwd: string
    root: string
    settings: DesktopSettings
    agentEntries: Array<{ pluginId: string; generation: number; path: string }>
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
    initialGeneration: data.initialGeneration,
    requireRestrictedPolicy: true,
    resourceSnapshot: data.resourceSnapshot,
    agentSources: data.agentEntries,
    onAdmission: (message, mode, continuation, signal) =>
      hostRequest('admission', { message, mode, continuation }, signal) as Promise<void>,
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
    kind: 'collaboration' | 'savePlan' | 'admission',
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
  const ready = (async () => {
    const sdk = await loadPiSdk()
    const agentCore = await loadPiAgentCore()
    const extensions: InlineExtension[] = []
    for (const [pluginId, create] of Object.entries(builtins)) {
      if (pluginId === '@pi-meme/mcp' && data.access !== 'full-access') continue
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
          requestCollaboration: (request, signal) =>
            hostRequest('collaboration', request, signal) as Promise<CollaborationResults[keyof CollaborationResults]>,
          savePlan: (input, signal) => hostRequest('savePlan', { input }, signal) as Promise<PlanDocument>,
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
    for (const entry of data.agentEntries) {
      if (entry.pluginId in builtins) throw new Error('外部 Agent 不能替换内置能力')
      extensions.push(createAppAgent(entry, (questions, signal) => session.requestUserInput(questions, signal)))
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
