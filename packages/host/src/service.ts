import { PluginManager, type PluginDescriptor, type PluginLease } from '@pi-meme/plugin-runtime/manager'
import { fileURLToPath } from 'node:url'
import * as builtin0 from '@pi-meme/chat/server/entry'
import * as builtin1 from '@pi-meme/workspace/server/entry'
import * as builtin2 from '@pi-meme/git/server/entry'
import * as builtin3 from '@pi-meme/models/server/entry'
import * as builtin4 from '@pi-meme/settings/server/entry'
import * as builtin5 from '@pi-meme/pi-extensions/server/entry'
import * as builtin6 from '@pi-meme/mcp/server/entry'
import * as builtin7 from '@pi-meme/history/server/entry'
import * as builtin8 from '@pi-meme/usage/server/entry'
import * as builtin9 from '@pi-meme/resources/server/entry'
import * as builtin10 from '@pi-meme/sandbox-macos/server/entry'
import * as builtin11 from '@pi-meme/permissions/server/entry'
import * as builtin12 from '@pi-meme/codemode/server/entry'
import * as builtin13 from '@pi-meme/subagents/server/entry'
import { mkdir, readdir, realpath, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { HostEvent, HostRpcRequest } from '@pi-meme/contracts/host'
import type { DesktopEvent, Connection, DesktopError } from '@pi-meme/contracts/desktop'
import type { SelectWorkspace } from '@pi-meme/contracts/sessions'
import { PiSessionPool, type ClientView } from '@pi-meme/pi-runtime/session-pool'
import { AgentAccessStore } from '@pi-meme/pi-runtime/access-store'
import { createPiRuntimePaths } from '@pi-meme/pi-runtime/runtime-paths'
import { createWorkerSession } from '@pi-meme/pi-adapter/worker-session'
import type { SecureCredentialStorage } from '@pi-meme/contracts/secure-storage'
import { MemoryCredentialStorage } from '@pi-meme/pi-runtime/secure-store'
import { KeychainCredentialStore } from '@pi-meme/pi-adapter/credentials'
import { ModelConfigStore } from '@pi-meme/models/server/config-store'
import { SettingsStore } from '@pi-meme/settings/server/store'
import { InstructionsStore } from '@pi-meme/settings/server/instructions'
import { parseTheme } from '@pi-meme/settings/shared/themes'
import { ProjectStore } from '@pi-meme/workspace/server/project-store'
import { SessionService } from '@pi-meme/workspace/server/session-service'
import { McpConfigStore } from '@pi-meme/mcp/server/config-store'
import { optionalRuntimeExtensions } from './runtime-extensions'
import { RequestRegistry } from './request-registry'
import { hostDataRoot, lockDataRoot } from './data-root'

export type HostOptions = {
  dataRoot?: string
  workerPath?: string
  builtinDirectory?: string
  clientGraceMs?: number
  credentials?: SecureCredentialStorage & { flush?: () => Promise<void> }
  testCredentials?: boolean
}
type Action = (...args: unknown[]) => unknown
const sessionWrites = new Set([
  'pi:prompt',
  'pi:steer',
  'pi:follow-up',
  'pi:clear-queue',
  'pi:steering-mode',
  'pi:follow-up-mode',
  'pi:access-mode',
  'pi:abort',
  'pi:set-model',
  'pi:set-thinking-level',
  'pi:extension-ui-response',
  'pi:edit-and-prompt',
  'pi:switch-message-version',
  'pi:fork-reply',
])
const reads = new Set([
  'pi:connection',
  'pi:snapshot',
  'pi:sessions',
  'pi:commands',
  'pi:thinking-levels',
  'pi:session-stats',
  'pi:history',
  'pi:prefetch',
  'workspace:projects',
  'project:delete-preview',
  'chat:project-files',
  'git:snapshot',
  'git:diff',
  'models:get',
  'models:default',
  'settings:get',
  'settings:instructions',
  'settings:fonts',
  'mcp:get',
  'host:directories',
  'plugins:list',
  'plugins:session',
  'settings:theme-directories',
  'session:history',
  'session:prefetch',
  'history:query',
  'history:export',
  'resources:list',
  'settings:usage-stats',
  'settings:subagents',
])
const selections = new Set(['pi:fork-reply', 'pi:new-session', 'pi:switch-session', 'workspace:select', 'pi:directory'])

export async function createHost(options: HostOptions = {}) {
  const root = hostDataRoot(options.dataRoot)
  const instanceId = randomUUID()
  const unlock = await lockDataRoot(root)
  let cleanup: (() => Promise<void>) | undefined
  try {
    const hostIdFile = path.join(root, 'host-id')
    const { readFile } = await import('node:fs/promises')
    let hostId = await readFile(hostIdFile, 'utf8').catch(() => '')
    if (!hostId) {
      hostId = randomUUID()
      await writeFile(hostIdFile, hostId, { mode: 0o600 })
    }
    const paths = createPiRuntimePaths(root)
    await mkdir(paths.sessionsDirectory, { recursive: true })
    const settings = new SettingsStore(root)
    const projects = new ProjectStore(root)
    await settings.load()
    await projects.load()
    const sessions = new SessionService(paths.sessionsDirectory, path.join(root, 'sessions-cache.json'))
    await sessions.init()
    if (options.testCredentials && !options.dataRoot) throw new Error('测试凭据必须同时配置临时数据目录')
    const credentials =
      options.credentials ??
      (options.testCredentials ? new MemoryCredentialStorage() : await KeychainCredentialStore.create(root))
    if (options.testCredentials) {
      const seed = await readFile(path.join(root, 'test-credentials.json'), 'utf8').catch(() => '{}')
      const values: unknown = JSON.parse(seed)
      if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('测试凭据文件格式无效')
      for (const [key, value] of Object.entries(values)) {
        if (typeof value !== 'string') throw new Error('测试凭据必须为字符串')
        credentials.set(key, value)
      }
    }
    const listeners = new Map<string, Set<(event: HostEvent) => void>>()
    const views = new Map<string, ClientView>()
    const selectionEpochs = new Map<string, number>()
    const sessionQueues = new Map<string, Promise<unknown>>()
    const controls = new Set([
      'pi:abort',
      'pi:extension-ui-response',
      'pi:steer',
      'pi:follow-up',
      'pi:clear-queue',
      'plugins:install-directory',
      'plugins:install-package',
      'plugins:reload',
      'plugins:enable',
      'plugins:disable',
      'plugins:remove',
    ])
    const clientRequests = new Map<string, number>()
    const clientTimers = new Map<string, ReturnType<typeof setTimeout>>()
    let pi: PiSessionPool
    const scheduleClientRelease = (clientId: string) => {
      const previous = clientTimers.get(clientId)
      if (previous) clearTimeout(previous)
      clientTimers.delete(clientId)
      if (listeners.get(clientId)?.size || clientRequests.get(clientId)) return
      const timer = setTimeout(() => {
        clientTimers.delete(clientId)
        const view = views.get(clientId)
        if (view) {
          pi.releaseClientView(view)
          views.delete(clientId)
          selectionEpochs.delete(clientId)
        }
      }, options.clientGraceMs ?? 120000)
      timer.unref()
      clientTimers.set(clientId, timer)
    }
    const emit = (type: HostEvent['type'], value?: DesktopEvent | Connection | DesktopError) => {
      for (const [clientId, subscribers] of listeners) {
        const view = views.get(clientId)
        if (!view) continue
        if (type === 'connection' && (value as Connection)?.sessionKey !== view.sessionKey) continue
        const adjusted = value ? { ...value, generation: view.generation } : undefined
        for (const subscriber of subscribers) subscriber({ hostId, type, value: adjusted } as HostEvent)
      }
    }
    let plugins: PluginManager
    const workerPlugins = new Map<string, PluginDescriptor[]>()
    const workerPluginIds = new Map<string, Set<string>>()
    const workerLeases = new Map<string, PluginLease>()
    pi = new PiSessionPool(
      paths.workspaceDataRoot,
      {
        connection: (value) => emit('connection', value),
        event: (value) => emit('event', value),
        error: (value) => emit('error', value),
        sessionsChanged: () => {
          sessions.invalidate()
          emit('sessions-changed')
        },
      },
      new AgentAccessStore(path.join(root, 'agent-permissions.json')),
      paths,
      credentials,
      (cwd, notify, runtimePaths, _credentials, _mcp, sessionKey) =>
        createWorkerSession(cwd, notify, runtimePaths, () => {
          const lease = plugins.acquire()
          if (sessionKey) {
            workerPlugins.set(sessionKey, lease.descriptors)
            workerPluginIds.set(sessionKey, new Set(lease.retainedIds))
            workerLeases.set(sessionKey, lease)
          }
          return {
            credentials,
            dataRoot: root,
            settings: settings.settings,
            agentEntries: lease.agentEntries,
            descriptors: lease.descriptors,
            workerPath: options.workerPath,
            release: async () => {
              await lease.release()
              if (sessionKey) {
                workerPlugins.delete(sessionKey)
                workerPluginIds.delete(sessionKey)
                workerLeases.delete(sessionKey)
              }
            },
          }
        }),
    )
    cleanup = async () => {
      await pi.stopAndWait()
      await plugins?.dispose()
      await (credentials as SecureCredentialStorage & { flush?: () => Promise<void> }).flush?.()
    }
    pi.configureWorkspaces({
      kind: (cwd) => projects.kind(cwd),
      createStandaloneDirectory: () => projects.createStandaloneDirectory(),
    })
    pi.configureCapabilities({
      codemodeEnabled: settings.settings.codemodeEnabled ?? false,
      mcpEnabled: settings.settings.mcpEnabled ?? false,
    })
    if (settings.settings.defaultAccessMode) await pi.configureDefaultAccessMode(settings.settings.defaultAccessMode)
    const models = new ModelConfigStore(path.join(paths.agentDir, 'models.json'), credentials, paths.agentDir)
    const mcp = new McpConfigStore(path.join(paths.agentDir, 'mcp.json'), credentials)
    const uiDescriptors = (descriptors: PluginDescriptor[]) =>
      descriptors.map((descriptor) => ({
        ...descriptor,
        ui: descriptor.ui
          ? descriptor.builtin
            ? `builtin:${descriptor.id}`
            : `/api/plugins/${instanceId}/${encodeURIComponent(descriptor.id)}/${descriptor.generation}/${descriptor.ui}`
          : undefined,
      }))
    const sessionDescriptors = (sessionId?: string) => {
      const current = new Map(plugins.list().map((entry) => [entry.id, entry]))
      if (sessionId && workerPlugins.has(sessionId)) {
        const retained = workerPlugins.get(sessionId)!
        for (const entry of current.values())
          if (entry.agent && !retained.some((old) => old.id === entry.id)) current.delete(entry.id)
        for (const entry of retained) current.set(entry.id, entry)
      }
      return uiDescriptors([...current.values()])
    }
    const snapshot = async () => ({
      ...(await pi.snapshot()),
      uiPlugins: sessionDescriptors(pi.connection().sessionKey),
    })
    const workspaceHandlers: Record<string, Action> = {
      'pi:directory': async (input: unknown) => {
        if (typeof input !== 'string' || !input.trim()) throw new Error('项目目录参数无效')
        const cwd = await projects.validateDirectory(input.trim())
        pi.assertWorkspaceAvailable(cwd)
        if (projects.kind(cwd) === 'standalone') {
          if (!projects.isStandaloneDirectory(cwd)) throw new Error('请选择具体的无项目会话目录')
        } else await projects.register(cwd)
        return pi.selectWorkspaceDirectory(cwd)
      },
      'workspace:select': async (input: unknown) => {
        const value = input as SelectWorkspace | undefined
        if (!value || !['project', 'standalone'].includes(value.kind)) throw new Error('工作环境参数无效')
        const cwd =
          value.kind === 'project'
            ? (await projects.register(await projects.validateDirectory(value.cwd))).cwd
            : await projects.createStandaloneDirectory()
        return pi.selectWorkspaceDirectory(cwd)
      },
      'project:register': async (input: unknown) => {
        if (typeof input !== 'string') throw new Error('项目目录参数无效')
        const value = await projects.register(await projects.validateDirectory(input))
        emit('sessions-changed')
        return value
      },
      'project:preferred-app': (value: unknown) => settings.save({ ...settings.settings, preferredProjectApp: value }),
    }
    const settingsHandlers: Record<string, Action> = {
      'settings:import-theme-content': async (value: unknown) => {
        const theme = parseTheme(value)
        if (settings.snapshot().themes.some((entry) => entry.id === theme.id)) throw new Error('主题 ID 已存在')
        await writeFile(
          path.join(settings.themesDirectory, `${theme.id}.json`),
          `${JSON.stringify(theme, null, 2)}\n`,
          { flag: 'wx' },
        )
        return settings.reloadThemes()
      },
      'settings:export-theme-content': (value: unknown) => parseTheme(value),
      'settings:theme-directories': () => ({
        themes: settings.themesDirectory,
        extensions: settings.extensionsDirectory,
      }),
    }
    const sharedContexts = {
      'host.usage': { sessionsDirectory: paths.sessionsDirectory },
      'host.chat': { pi, getCwd: () => pi.cwd },
      'host.workspace': {
        pi,
        projects,
        sessions,
        mutations: pi,
        removePins: (value: string[]) => settings.removePins(value),
        getPinnedPaths: () => settings.settings.pinnedPaths ?? [],
        getRuntimeSessions: () => pi.getRuntimeSessions(),
        getRuntimeHistory: (value: string) => pi.getRuntimeHistory(value),
        handlers: workspaceHandlers,
      },
      'host.git': { getCwd: () => pi.cwd },
      'host.models': { pi, models, agentDir: paths.agentDir },
      'host.settings': {
        pi,
        instructions: new InstructionsStore(paths.agentDir),
        settings,
        handlers: settingsHandlers,
        getSubagents: async () =>
          (await optionalRuntimeExtensions(settings.settings, path.join(paths.agentDir, 'subagents'))).catalog,
        configureOptionalExtensions: async (value: typeof settings.settings) =>
          (await optionalRuntimeExtensions(value, path.join(paths.agentDir, 'subagents'))).catalog,
      },
      'host.interaction': { pi },
      'host.mcp': { pi, store: mcp },
    }
    plugins = new PluginManager({
      directory: path.join(root, 'plugins'),
      dataDirectory: path.join(root, 'plugin-data'),
      services: sharedContexts,
      drain: async (ids) =>
        pi.retireSessions((key) => [...(workerPluginIds.get(key) ?? [])].some((id) => ids.includes(id))),
      onChange: () => {
        pi.configureResourceDiscovery(
          plugins.list().some((entry) => entry.id === '@pi-meme/resources' && entry.enabled),
        )
        emit('plugins-changed')
        for (const [key, previous] of workerPlugins) {
          const agents = plugins.list().filter((entry) => entry.agent && entry.enabled && entry.status !== 'pending')
          if (
            agents.some(
              (current) => !previous.some((old) => old.id === current.id && old.generation === current.generation),
            ) ||
            previous.some((old) => {
              const current = plugins.list().find((entry) => entry.id === old.id)
              return (
                !current || !current.enabled || (current.generation !== old.generation && current.status !== 'pending')
              )
            })
          ) {
            void pi
              .retireSessions((sessionKey) => sessionKey === key)
              .catch((cause: unknown) => emit('error', { generation: 0, sessionKey: key, message: String(cause) }))
          }
        }
      },
    })
    const builtinRoot = options.builtinDirectory ?? fileURLToPath(new URL('../../../plugins', import.meta.url))
    await plugins.restore(async () => {
      for (const module of [
        builtin0,
        builtin1,
        builtin2,
        builtin3,
        builtin4,
        builtin5,
        builtin6,
        builtin7,
        builtin8,
        builtin9,
        builtin10,
        builtin11,
        builtin12,
        builtin13,
      ]) {
        const directory = path.join(
          builtinRoot,
          module.manifest.name === '@pi-meme/pi-extensions' ? 'interaction' : module.manifest.name.split('/').at(-1)!,
        )
        await plugins.registerBuiltin(module.manifest, module, directory)
      }
    })
    const parseId = (value: unknown) => {
      if (typeof value !== 'string') throw new Error('插件 ID 参数无效')
      return value
    }
    const handlers: Record<string, Action> = {
      'pi:connection': () => pi.connection(),
      'pi:snapshot': snapshot,
      'host:directories': async (input?: unknown) => {
        if (input !== undefined && typeof input !== 'string') throw new Error('目录参数无效')
        const directory = await realpath(typeof input === 'string' ? input : homedir())
        const entries = (await readdir(directory, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((entry) => ({ name: entry.name, path: path.join(directory, entry.name) }))
        return {
          path: directory,
          parent: directory === path.dirname(directory) ? null : path.dirname(directory),
          entries,
        }
      },

      'plugins:list': () => uiDescriptors(plugins.list()),
      'plugins:session': (key) => sessionDescriptors(typeof key === 'string' ? key : pi.connection().sessionKey),
      'plugins:install-directory': (value) => plugins.loadDirectory(parseId(value)),
      'plugins:install-package': (value) => {
        if (typeof value !== 'string' || value.length > 48 * 1024 * 1024) throw new Error('插件包内容无效')
        return plugins.installPackage(Buffer.from(value, 'base64'))
      },
      'plugins:enable': (value) => plugins.enable(parseId(value)),
      'plugins:disable': (value) => plugins.disable(parseId(value)),
      'plugins:remove': (value) => plugins.remove(parseId(value)),
      'plugins:reload': (value) => plugins.reload(parseId(value)),
    }
    const registry = new RequestRegistry(hostId, path.join(root, 'requests'))
    const client = async (clientId: string) => {
      let view = views.get(clientId)
      if (!view) {
        view = pi.createClientView()
        views.set(clientId, view)
      }
      const current = view
      await pi.withClientView(current, async () => {
        if (!current.sessionKey) {
          const directory = await projects.createStandaloneDirectory()
          if (!current.sessionKey) pi.initializeClient(directory)
        }
      })
      scheduleClientRelease(clientId)
      return current
    }
    let closing = false
    const inflight = new Set<Promise<unknown>>()
    return {
      hostId,
      instanceId,
      root,
      settings,
      pi,
      async rpc(request: HostRpcRequest) {
        if (closing) throw new Error('Host 正在退出，操作未接纳')
        if (
          !request ||
          typeof request.requestId !== 'string' ||
          request.requestId.length > 128 ||
          typeof request.clientId !== 'string' ||
          request.clientId.length > 128 ||
          !Array.isArray(request.args) ||
          typeof request.method !== 'string'
        )
          throw new Error('请求参数无效')
        if (request.hostId && request.hostId !== hostId) throw new Error('Host 身份不匹配')
        clientRequests.set(request.clientId, (clientRequests.get(request.clientId) ?? 0) + 1)
        const pending = registry.run(
          request,
          async () => {
            const epoch = selections.has(request.method) ? (selectionEpochs.get(request.clientId) ?? 0) + 1 : undefined
            if (epoch !== undefined) selectionEpochs.set(request.clientId, epoch)
            const view = await client(request.clientId)
            if (closing) throw new Error('Host 正在退出，操作未执行')
            const retained =
              request.method === 'pi:extension-ui-response' && request.sessionId
                ? workerLeases.get(request.sessionId)
                : undefined
            const action = retained
              ? (...args: unknown[]) => retained.runHandler(request.method, args)
              : (handlers[request.method] ?? plugins.handlers()[request.method])
            if (!action) throw new Error(`Host 方法不存在：${request.method}`)
            if (sessionWrites.has(request.method) && (!request.sessionId || request.args[0] !== request.sessionId))
              throw new Error('会话写操作必须携带匹配的 sessionId')
            if (epoch !== undefined && selectionEpochs.get(request.clientId) !== epoch) return { cancelled: true }
            const selected = { ...view, sessionKey: request.sessionId ?? view.sessionKey }
            const run = () =>
              pi.withClientView(selected, async () => {
                let result = await action(...request.args)
                if (epoch !== undefined) {
                  if (selectionEpochs.get(request.clientId) !== epoch) return { cancelled: true }
                  Object.assign(view, selected)
                  emit('connection', pi.connection())
                }
                if (selected.sessionKey === view.sessionKey) view.defaults = selected.defaults
                if (
                  result &&
                  typeof result === 'object' &&
                  'snapshot' in result &&
                  'cancelled' in result &&
                  !result.cancelled
                )
                  result = {
                    ...result,
                    snapshot: {
                      ...(result.snapshot as object),
                      uiPlugins: sessionDescriptors(pi.connection().sessionKey),
                    },
                  }
                await (credentials as SecureCredentialStorage & { flush?: () => Promise<void> }).flush?.()
                return result
              })
            if (!request.sessionId || reads.has(request.method) || controls.has(request.method)) return run()
            const key = request.sessionId
            const queued = (sessionQueues.get(key) ?? Promise.resolve())
              .catch(() => {})
              .then(() => {
                if (closing) throw new Error('Host 正在退出，操作未执行')
                return run()
              })
            sessionQueues.set(key, queued)
            try {
              return await queued
            } finally {
              if (sessionQueues.get(key) === queued) sessionQueues.delete(key)
            }
          },
          !reads.has(request.method),
        )
        inflight.add(pending)
        try {
          return await pending
        } finally {
          inflight.delete(pending)
          const count = (clientRequests.get(request.clientId) ?? 1) - 1
          if (count) clientRequests.set(request.clientId, count)
          else clientRequests.delete(request.clientId)
          if (!closing) scheduleClientRelease(request.clientId)
        }
      },
      plugins,
      async subscribe(clientId: string, callback: (event: HostEvent) => void) {
        await client(clientId)
        const values = listeners.get(clientId) ?? new Set()
        listeners.set(clientId, values)
        values.add(callback)
        scheduleClientRelease(clientId)
        return () => {
          values.delete(callback)
          if (!values.size) {
            listeners.delete(clientId)
            scheduleClientRelease(clientId)
          }
        }
      },
      async dispose() {
        closing = true
        for (const timer of clientTimers.values()) clearTimeout(timer)
        clientTimers.clear()
        await pi.stopAndWait()
        await Promise.allSettled(inflight)
        await plugins.dispose()
        await (credentials as SecureCredentialStorage & { flush?: () => Promise<void> }).flush?.()
        listeners.clear()
        views.clear()
        await unlock()
      },
    }
  } catch (cause) {
    await cleanup?.()
    await unlock()
    throw cause
  }
}
export type HostService = Awaited<ReturnType<typeof createHost>>
