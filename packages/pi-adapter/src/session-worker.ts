import { parentPort, workerData } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'
import type { InlineExtension } from '@earendil-works/pi-coding-agent'
import type { DesktopSettings } from '@pi-meme/contracts/settings'
import type { AgentAccessMode } from '@pi-meme/contracts/agent-access'
import { SdkSession, type RuntimePolicy } from '@pi-meme/pi-runtime/sdk/session'
import { createPiRuntimePaths } from '@pi-meme/pi-runtime/runtime-paths'
import { MemoryCredentialStorage } from '@pi-meme/pi-runtime/secure-store'
import { loadPiSdk, loadPiAgentCore } from '@pi-meme/pi-runtime/sdk/load'

const data = workerData as {
  cwd: string
  root: string
  settings: DesktopSettings
  agentEntries: Array<{ pluginId: string; generation: number; path: string }>
  descriptors?: Array<{ id: string; enabled: boolean; builtin?: boolean }>
  credentials: Array<[string, string]>
  access: AgentAccessMode
  capabilities: DesktopSettings
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
const policy: RuntimePolicy = { requireRestrictedPolicy: true }
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
const ready = (async () => {
  const sdk = await loadPiSdk()
  const agentCore = await loadPiAgentCore()
  const extensions: InlineExtension[] = []
  policy.agentPaths = []
  for (const entry of data.agentEntries) {
    if (entry.pluginId === '@pi-meme/codemode' && !data.capabilities.codemodeEnabled && !data.capabilities.mcpEnabled)
      continue
    if (entry.pluginId === '@pi-meme/mcp' && data.access !== 'full-access') continue
    if (!data.descriptors?.some((descriptor) => descriptor.id === entry.pluginId && descriptor.builtin)) {
      policy.agentPaths.push(entry.path)
      continue
    }
    const module = (await import(pathToFileURL(entry.path).href)) as {
      default?: import('@earendil-works/pi-coding-agent').ExtensionFactory
      create?: (context: object) => InlineExtension[] | Promise<InlineExtension[]>
    }
    if (module.create)
      extensions.push(
        ...(await module.create({
          sdk,
          agentCore,
          paths,
          credentials,
          settings: data.settings,
          cwd: data.cwd,
          registerInteractionPolicy: (enabled: boolean) => {
            policy.uiEnabled = enabled
          },
          registerResourcePolicy: (value: RuntimePolicy['resourcePaths']) => {
            policy.resourcePaths = value
          },
          registerSandbox: (factory: RuntimePolicy['createSandbox']) => {
            policy.createSandbox = factory
          },
          registerAccessExtension: (factory: RuntimePolicy['createAccessExtension']) => {
            policy.createAccessExtension = factory
          },
        })),
      )
    else if (typeof module.default === 'function') extensions.push({ name: entry.pluginId, factory: module.default })
    else throw new Error(`插件 Agent 入口没有导出 Pi 扩展：${entry.path}`)
  }
  session.configureInlineExtensions(extensions)
  session.configureCapabilities({ codemodeEnabled: false, mcpEnabled: false })
  session.configureAccess(data.access)
})()
port.on(
  'message',
  (request: { id: number; method: string; args: unknown[]; credentialReply?: number; error?: string }) => {
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
