import type { Goal, GoalControl, GoalRequest, GoalRun, PromptOrigin } from '@pi-meme/contracts/goal'
import type { ServiceActivityRequest, ServiceActivityResult } from '@pi-meme/contracts/service-activity'
import type { CollaborationRequest, CollaborationResults } from '@pi-meme/contracts/collaboration'
import type { PlanDocument, PlanRef, PlanState, SavePlanInput, TaskMode } from '@pi-meme/contracts/plan'
import { Worker } from 'node:worker_threads'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Connection } from '@pi-meme/contracts/desktop'
import type { DesktopSettings } from '@pi-meme/contracts/settings'
import type { SdkSession } from '@pi-meme/pi-runtime/sdk/session'
import type { PiRuntimePaths } from '@pi-meme/pi-runtime/runtime-paths'
import type { SecureCredentialStorage } from '@pi-meme/contracts/secure-storage'
import type { RuntimeSdkSession } from '@pi-meme/pi-runtime/session-pool'
import type { ResourceSnapshot } from '@pi-meme/contracts/resources'
import type { PluginRuntimeRequest } from '@pi-meme/contracts/plugin-call'
import type { AgentPluginEntry } from '@pi-meme/plugin-sdk/agent'

export type WorkerOptions = {
  admit?: (
    message: string,
    mode: TaskMode,
    continuation: boolean,
    signal: AbortSignal,
    origin?: PromptOrigin,
    expected?: GoalControl,
  ) => Promise<void | GoalRun>
  collaboration?: (
    request: CollaborationRequest,
    signal: AbortSignal,
  ) => Promise<CollaborationResults[keyof CollaborationResults]>
  savePlan?: (input: SavePlanInput, signal: AbortSignal) => Promise<PlanDocument>
  syncPlan?: (force: boolean) => Promise<PlanState>
  resolvePlan?: (reference: PlanRef, signal: AbortSignal) => Promise<PlanDocument>
  goal?: (request: GoalRequest, run: GoalRun | undefined, signal: AbortSignal) => Promise<Goal | undefined>
  goalUsage?: (run: GoalRun, entryId: string, usage: unknown, inputEntryId?: string) => Promise<void>
  activity?: (request: ServiceActivityRequest, signal: AbortSignal) => Promise<ServiceActivityResult>
  credentials: SecureCredentialStorage & { flush?: () => Promise<void> }
  dataRoot: string
  settings: DesktopSettings
  agentEntries: AgentPluginEntry[]
  plugin?: (request: PluginRuntimeRequest, signal: AbortSignal) => Promise<unknown>
  resourceSnapshot?: ResourceSnapshot
  workerPath?: string
  release?: () => void | Promise<void>
}
type Notify = ConstructorParameters<typeof SdkSession>[1]
type Pending = { resolve: (value: unknown) => void; reject: (cause: Error) => void }
type WorkerReply = {
  id?: number
  result?: unknown
  error?: string
  notify?: keyof Notify
  value?: unknown
  connection: Connection
  active: { sessionFile?: string; sessionId?: string }
}

/** Worker 只在第一次 SDK 操作时创建；每个 Worker 拥有独立 SDK 缓存与全局状态。 */
export function createWorkerSession(
  cwd: string,
  notify: Notify,
  paths: PiRuntimePaths,
  getOptions: () => WorkerOptions | Promise<WorkerOptions>,
): RuntimeSdkSession {
  let worker: Worker | undefined
  let connection: Connection = { cwd, generation: 0, status: 'disconnected' }
  let active: { sessionFile?: string; sessionId?: string } = {}
  let serial = 0
  let paused = false
  let pauseRevision = -1
  let release: (() => void | Promise<void>) | undefined
  let capabilities: Parameters<SdkSession['configureCapabilities']>[0] = { codemodeEnabled: false, mcpEnabled: false }
  let access: Parameters<SdkSession['configureAccess']>[0] = 'full-access'
  let releasing: Promise<void> = Promise.resolve()
  const hostRequests = new Map<string, AbortController>()
  const pending = new Map<number, Pending>()
  let initializing: Promise<Worker> | undefined
  let initializationEpoch = 0
  const fail = (cause: Error) => {
    for (const controller of hostRequests.values()) controller.abort()
    hostRequests.clear()
    for (const request of pending.values()) request.reject(cause)
    pending.clear()
    connection = { ...connection, status: 'disconnected', error: cause.message }
    notify.connection(connection)
  }
  const initialize = async () => {
    const epoch = initializationEpoch
    const options = await getOptions()
    if (epoch !== initializationEpoch) {
      await options.release?.()
      throw new Error('会话 Worker 启动已取消')
    }
    release = options.release
    const entry = options.workerPath ?? fileURLToPath(new URL('./generic-worker.ts', import.meta.url))
    try {
      worker = new Worker(entry, {
        workerData: {
          cwd,
          initialGeneration: connection.generation,
          root: options.dataRoot,
          temporaryRoot: paths.temporaryRoot,
          settings: options.settings,
          agentEntries: options.agentEntries,
          resourceSnapshot: options.resourceSnapshot,
          credentials: options.credentials.entries().filter(([key]) => !key.startsWith('plugin:')),
          capabilities,
          access,
        },
        execArgv: entry.endsWith('.ts') ? ['--import', 'tsx'] : [],
      })
    } catch (cause) {
      releasing = Promise.resolve(release?.())
      release = undefined
      throw cause
    }
    const current = worker
    current.on(
      'message',
      (
        reply: WorkerReply & {
          hostCancel?: string
          hostRequest?: {
            kind:
              | 'collaboration'
              | 'savePlan'
              | 'resolvePlan'
              | 'syncPlan'
              | 'admission'
              | 'goal'
              | 'goalUsage'
              | 'activity'
              | 'plugin'
            reference?: PlanRef
            pluginRequest?: PluginRuntimeRequest
            activityRequest?: ServiceActivityRequest
            message?: string
            mode?: TaskMode
            continuation?: boolean
            origin?: PromptOrigin
            expected?: GoalControl
            goalRequest?: GoalRequest
            goalRun?: GoalRun
            entryId?: string
            usage?: unknown
            inputEntryId?: string
            id: string
            force?: boolean
            input?: SavePlanInput
          } & CollaborationRequest
          credential?: { id: number; key: string; value?: string }
        },
      ) => {
        if (worker !== current) return
        if (reply.hostCancel) {
          hostRequests.get(reply.hostCancel)?.abort()
          hostRequests.delete(reply.hostCancel)
          return
        }
        if (reply.hostRequest) {
          const request = reply.hostRequest
          const controller = new AbortController()
          hostRequests.set(request.id, controller)
          void Promise.resolve()
            .then(async () => {
              if (request.kind === 'plugin') {
                if (!options.plugin || !request.pluginRequest)
                  throw new Error('operation-unavailable-in-runtime: 插件桥未配置')
                return options.plugin(request.pluginRequest, controller.signal)
              }
              if (request.kind === 'admission') {
                return options.admit?.(
                  request.message!,
                  request.mode!,
                  Boolean(request.continuation),
                  controller.signal,
                  request.origin,
                  request.expected,
                )
              }
              if (request.kind === 'goal') {
                if (!options.goal || !request.goalRequest) return undefined
                return options.goal(request.goalRequest, request.goalRun, controller.signal)
              }
              if (request.kind === 'goalUsage') {
                if (!options.goalUsage || !request.goalRun || !request.entryId) throw new Error('目标用量桥未配置')
                return options.goalUsage(request.goalRun, request.entryId, request.usage, request.inputEntryId)
              }
              if (request.kind === 'activity') {
                if (!options.activity || !request.activityRequest) throw new Error('活动服务桥未配置')
                return options.activity(request.activityRequest, controller.signal)
              }
              if (request.kind === 'syncPlan') {
                if (!options.syncPlan) throw new Error('计划同步桥未配置')
                return options.syncPlan(request.force === true)
              }
              if (request.kind === 'savePlan') {
                if (!options.savePlan || !request.input) throw new Error('计划保存桥未配置')
                return options.savePlan(request.input, controller.signal)
              }
              if (request.kind === 'resolvePlan') {
                if (!options.resolvePlan || !request.reference) throw new Error('计划引用桥未配置')
                return options.resolvePlan(request.reference, controller.signal)
              }
              if (!options.collaboration) throw new Error('协作桥未配置')
              return options.collaboration(request, controller.signal)
            })
            .then((result) => {
              if (worker === current && !controller.signal.aborted)
                current.postMessage({ hostReply: request.id, result })
            })
            .catch((cause: unknown) => {
              if (worker === current && !controller.signal.aborted)
                current.postMessage({ hostReply: request.id, error: String(cause) })
            })
            .finally(() => hostRequests.delete(request.id))
          return
        }
        if (reply.credential) {
          const mutation = reply.credential
          void Promise.resolve()
            .then(async () => {
              if (mutation.value === undefined) options.credentials.delete(mutation.key)
              else options.credentials.set(mutation.key, mutation.value)
              await options.credentials.flush?.()
              current.postMessage({ credentialReply: mutation.id })
            })
            .catch((cause: unknown) => current.postMessage({ credentialReply: mutation.id, error: String(cause) }))
          return
        }
        if (worker !== current) return
        connection = reply.connection
        active = reply.active
        if (reply.notify) {
          const callback = notify[reply.notify] as ((value: unknown) => void) | undefined
          callback?.(reply.value)
        }
        if (reply.id !== undefined) {
          const request = pending.get(reply.id)
          pending.delete(reply.id)
          if (reply.error) request?.reject(new Error(reply.error))
          else request?.resolve(reply.result)
        }
      },
    )
    current.on('error', (cause) => {
      if (worker === current) fail(cause)
    })
    current.on('exit', (code) => {
      if (worker !== current) return
      worker = undefined
      releasing = Promise.resolve(release?.())
      release = undefined
      fail(new Error(`会话 Worker 已退出（${code}）`))
    })
    if (pauseRevision >= 0) {
      const id = ++serial
      pending.set(id, { resolve: () => {}, reject: (cause) => fail(new Error(String(cause))) })
      current.postMessage({ id, method: 'setPaused', args: [paused, pauseRevision] })
    }
    return current
  }
  const ensure = () => {
    if (worker) return Promise.resolve(worker)
    if (initializing) return initializing
    initializing = initialize().finally(() => {
      initializing = undefined
    })
    return initializing
  }
  const callRaw = (method: string, args: unknown[]) =>
    new Promise<unknown>((resolve, reject) => {
      const id = ++serial
      pending.set(id, { resolve, reject })
      void ensure()
        .then((current) => current.postMessage({ id, method, args }))
        .catch((cause: unknown) => {
          pending.delete(id)
          reject(cause)
        })
    })
  let stopping: Promise<void> | undefined
  const within = async <T>(operation: Promise<T>, milliseconds: number, label: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label}超过 ${milliseconds} 毫秒`)), milliseconds)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  const call = async (method: string, args: unknown[]) => {
    await stopping
    await releasing
    return callRaw(method, args)
  }
  const stopAndWait = () => {
    paused = false
    if (stopping) return stopping
    stopping = (async () => {
      initializationEpoch += 1
      let initializationError: unknown
      if (initializing) {
        try {
          await within(
            initializing.catch(() => undefined),
            5000,
            'Worker 初始化取消',
          )
        } catch (cause) {
          initializationError = cause
        }
      }
      const current = worker
      if (!current) {
        await within(releasing, 5000, 'Worker 释放')
        if (initializationError) throw initializationError
        if (connection.error) throw new Error(`Worker 异常退出，无法确认执行资源：${connection.error}`)
        return
      }
      let gracefulError: unknown = initializationError
      try {
        for (const controller of hostRequests.values()) controller.abort()
        hostRequests.clear()
        await within(callRaw('stopAndWait', []), 5000, 'Worker 正常停止')
      } catch (cause) {
        gracefulError = gracefulError ? `${String(gracefulError)}；${String(cause)}` : cause
      }
      worker = undefined
      try {
        await within(current.terminate(), 5000, 'Worker 强制退出')
      } catch (cause) {
        worker = current
        throw cause
      }
      for (const request of pending.values()) request.reject(new Error('会话运行时已停止'))
      pending.clear()
      connection = { ...connection, generation: connection.generation + 1, status: 'disconnected' }
      const cleanup = release
      release = undefined
      try {
        // SDK 的 start/reconnect 也会调用 stop；这里只在 Worker 真正退出后发布断开。
        notify.connection(connection)
      } finally {
        await cleanup?.()
      }
      if (gracefulError) throw new Error(`Worker 已退出，但正常清理未确认：${String(gracefulError)}`)
    })().finally(() => {
      stopping = undefined
    })
    return stopping
  }
  const sync: Record<string, unknown> = {
    cwd,
    connection: () => connection,
    getActiveSession: () => active,
    configureInlineExtensions: () => {},
    configureCapabilities: (value: typeof capabilities) => {
      capabilities = value
      if (worker) void call('configureCapabilities', [value])
    },
    configureAccess: (value: typeof access) => {
      access = value
      if (worker) void call('configureAccess', [value])
    },
    start: (directory: string, sessionFile?: string) => {
      active = { sessionFile }
      connection = { ...connection, cwd: directory, status: 'connecting' }
      void call('start', [directory, sessionFile]).catch((cause: unknown) => fail(new Error(String(cause))))
      if (pauseRevision >= 0)
        void call('setPaused', [paused, pauseRevision]).catch((cause: unknown) => fail(new Error(String(cause))))
    },
    stop: () => {
      void stopAndWait().catch((cause: unknown) => fail(new Error(String(cause))))
    },
    stopAndWait,
    abort: () => {
      paused = false
      return worker ? call('abort', []) : Promise.resolve()
    },
    setPaused: (value: boolean, revision: number) => {
      if (revision < pauseRevision) return Promise.resolve()
      paused = value
      pauseRevision = revision
      return worker ? call('setPaused', [value, revision]) : Promise.resolve()
    },
    releaseQueueEdits: (clientId: string) => (worker ? call('releaseQueueEdits', [clientId]) : Promise.resolve()),
    idle: async <T>(action: () => Promise<T>, allowDisconnected?: boolean) => {
      if (worker) await call('assertIdle', [allowDisconnected])
      return action()
    },
    assertIdle: (allowDisconnected?: boolean) => (worker ? call('assertIdle', [allowDisconnected]) : Promise.resolve()),
  }
  void paths
  return new Proxy(sync, {
    get: (target, property) => {
      if (typeof property !== 'string') return undefined
      return property in target ? target[property] : (...args: unknown[]) => call(property, args)
    },
  }) as unknown as RuntimeSdkSession
}

export function packagedWorkerPath(directory: string) {
  return path.join(directory, 'session-worker.js')
}
