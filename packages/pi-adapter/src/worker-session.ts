import { Worker } from 'node:worker_threads'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Connection } from '@pi-meme/contracts/desktop'
import type { DesktopSettings } from '@pi-meme/contracts/settings'
import type { SdkSession } from '@pi-meme/pi-runtime/sdk/session'
import type { PiRuntimePaths } from '@pi-meme/pi-runtime/runtime-paths'
import type { SecureCredentialStorage } from '@pi-meme/contracts/secure-storage'
import type { RuntimeSdkSession } from '@pi-meme/pi-runtime/session-pool'

export type WorkerOptions = {
  credentials: SecureCredentialStorage & { flush?: () => Promise<void> }
  descriptors?: Array<{ id: string; enabled: boolean; builtin?: boolean }>
  dataRoot: string
  settings: DesktopSettings
  agentEntries: Array<{ pluginId: string; generation: number; path: string }>
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
  getOptions: () => WorkerOptions,
): RuntimeSdkSession {
  let worker: Worker | undefined
  let connection: Connection = { cwd, generation: 0, status: 'disconnected' }
  let active: { sessionFile?: string; sessionId?: string } = {}
  let serial = 0
  let release: (() => void | Promise<void>) | undefined
  let capabilities: Parameters<SdkSession['configureCapabilities']>[0] = { codemodeEnabled: false, mcpEnabled: false }
  let access: Parameters<SdkSession['configureAccess']>[0] = 'full-access'
  let releasing: Promise<void> = Promise.resolve()
  const pending = new Map<number, Pending>()
  const fail = (cause: Error) => {
    for (const request of pending.values()) request.reject(cause)
    pending.clear()
    connection = { ...connection, status: 'disconnected', error: cause.message }
    notify.connection(connection)
  }
  const ensure = () => {
    if (worker) return worker
    const options = getOptions()
    release = options.release
    const entry = options.workerPath ?? fileURLToPath(new URL('./session-worker.ts', import.meta.url))
    try {
      worker = new Worker(entry, {
        workerData: {
          cwd,
          root: options.dataRoot,
          settings: options.settings,
          agentEntries: options.agentEntries,
          credentials: options.credentials.entries(),
          descriptors: options.descriptors,
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
    current.on('message', (reply: WorkerReply & { credential?: { id: number; key: string; value?: string } }) => {
      if (worker !== current) return
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
    })
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
    return current
  }
  const callRaw = (method: string, args: unknown[]) =>
    new Promise<unknown>((resolve, reject) => {
      const id = ++serial
      pending.set(id, { resolve, reject })
      try {
        ensure().postMessage({ id, method, args })
      } catch (cause) {
        pending.delete(id)
        reject(cause)
      }
    })
  let stopping: Promise<void> | undefined
  const call = async (method: string, args: unknown[]) => {
    await stopping
    await releasing
    return callRaw(method, args)
  }
  const stopAndWait = () => {
    if (stopping) return stopping
    stopping = (async () => {
      const current = worker
      if (!current) {
        await releasing
        return
      }
      try {
        await callRaw('stopAndWait', [])
      } finally {
        worker = undefined
        await current.terminate()
        for (const request of pending.values()) request.reject(new Error('会话运行时已停止'))
        pending.clear()
        connection = { ...connection, generation: connection.generation + 1, status: 'disconnected' }
        await release?.()
        release = undefined
      }
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
    },
    stop: () => {
      void stopAndWait().catch((cause: unknown) => fail(new Error(String(cause))))
    },
    stopAndWait,
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
