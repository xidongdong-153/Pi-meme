import { ImageConfigStore } from '@pi-meme/image-generation/server/config-store'
import { ImageGenerationService } from '@pi-meme/image-generation/server/service'
import { Readable } from 'node:stream'
import { GoalService } from '@pi-meme/goals/server/service'
import { ActivityService } from '@pi-meme/activities/server/service'
import { createActivityBridge } from './activity-bridge'
import { createPluginCallBridge } from './plugin-call-bridge'
import { PluginHttpBroker, type PluginCredentialValue } from './plugin-http-broker'
import { probePluginSandbox } from './plugin-sandbox-probe'
import type { PluginCallRequest, PluginCallContext } from '@pi-meme/plugin-sdk/rpc'
import type { PluginGrantUpdate } from '@pi-meme/plugin-sdk/permissions'
import { isLiveServiceActivity } from '@pi-meme/contracts/service-activity'
import { parseGoalCommand, type GoalRun } from '@pi-meme/contracts/goal'
import { normalizePlanMessage } from '@pi-meme/contracts/plan'
import { PluginManager, type PluginDescriptor } from '@pi-meme/plugin-runtime/manager'
import { fileURLToPath } from 'node:url'
import { createHostCollaborationBridge } from './collaboration-bridge'
import { createAppControl } from './app-control'
import { createWorkspaceFiles } from './workspace-files'
import { storeChatAttachment } from './chat-attachments'
import { systemPlugins } from '@pi-meme/plugin-sdk/system-plugins'
import { TerminalService } from './terminal-service'
import { createBuiltinModules } from './builtin-modules'
import { assertExternalPluginId } from '@pi-meme/plugin-sdk/reserved'
import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { validateExtensionUIResponse } from '@pi-meme/contracts/user-input'
import type { HostEvent, HostRpcRequest } from '@pi-meme/contracts/host'
import type {
  DesktopEvent,
  Connection,
  DesktopError,
  WorkspaceDeletionResult,
  Snapshot,
} from '@pi-meme/contracts/desktop'
import type { AgentAccessMode } from '@pi-meme/contracts/agent-access'
import type { PiModel, ThinkingLevel } from '@pi-meme/contracts/pi'
import type { SelectWorkspace, PiSessionsSnapshot, PiSessionSummary } from '@pi-meme/contracts/sessions'
import { PiSessionPool, type ClientView, type RuntimeSdkSession } from '@pi-meme/pi-runtime/session-pool'
import { AgentAccessStore } from '@pi-meme/pi-runtime/access-store'
import {
  createPiRuntimePaths,
  createTemporaryRuntimePaths,
  type PiRuntimePaths,
} from '@pi-meme/pi-runtime/runtime-paths'
import { createWorkerSession } from '@pi-meme/pi-adapter/worker-session'
import type { SecureCredentialStorage } from '@pi-meme/contracts/secure-storage'
import { MemoryCredentialStorage } from '@pi-meme/pi-runtime/secure-store'
import { FileCredentialStore } from '@pi-meme/pi-adapter/file-credentials'
import { ModelConfigStore } from '@pi-meme/models/server/config-store'
import { ModelService } from '@pi-meme/models/server/model-service'
import { SettingsStore } from '@pi-meme/settings/server/store'
import { InstructionsStore } from '@pi-meme/settings/server/instructions'
import { parseTheme } from '@pi-meme/settings/shared/themes'
import { loadPluginThemes } from '@pi-meme/settings/server/plugin-themes'
import { getGitEnvironment, resolveGitBase, runGit, switchGitBranch } from '@pi-meme/git/server/git-service'
import { ProjectStore } from '@pi-meme/workspace/server/project-store'
import { SessionService } from '@pi-meme/workspace/server/session-service'
import { McpConfigStore } from '@pi-meme/mcp/server/config-store'
import { optionalRuntimeExtensions } from './runtime-extensions'
import { RequestRegistry } from './request-registry'
import { ConnectionCredentialStore } from './connection-credentials'
import { assertActiveDataRoot, hostDataRoot, lockDataRoot } from './data-root'
import { createHostStoragePaths } from './storage/paths'
import { assertStorageLayout } from './storage/upgrade'
import { ensureHostIdentity } from './storage/host-identity'
import { cleanupTemporaryFiles } from './storage/cleanup-temporary-files'
import { SessionCleanupService } from './session-cleanup'
import { installBuiltinSkills } from '@pi-meme/resources/server/install-builtin-skills'
import { ResourceStore } from '@pi-meme/resources/server/resource-store'
import type { ResourceImportInput, ResourceSnapshot } from '@pi-meme/contracts/resources'

export type HostOptions = {
  dataRoot?: string
  workerPath?: string
  restrictedNode?: string
  restrictedEntry?: string
  builtinSkillsSource?: string
  clientGraceMs?: number
  credentials?: SecureCredentialStorage & { flush?: () => Promise<void> }
  testCredentials?: boolean
  readLegacyCredentials?: () => Promise<Array<[string, string]>>
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
  'pi:session-mode',
  'pi:abort',
  'pi:pause',
  'pi:resume',
  'pi:recover',
  'pi:steer-queue-input',
  'pi:delete-queue-input',
  'pi:begin-queue-edit',
  'pi:update-queue-input',
  'pi:cancel-queue-edit',

  'pi:set-model',
  'pi:set-thinking-level',
  'pi:extension-ui-response',
  'pi:edit-and-prompt',
  'pi:fork-reply',
  'git:switch-branch',
  'git:create-branch',
  'git:create-worktree',
])
const reads = new Set([
  'pi:connection',
  'host:session-ref',
  'pi:snapshot',
  'temporary-session:get',
  'pi:agents',
  'pi:agent-snapshot',
  'pi:sessions',
  'pi:commands',
  'pi:thinking-levels',
  'pi:session-stats',
  'pi:history',
  'pi:prefetch',
  'workspace:projects',
  'project:delete-preview',
  'chat:project-files',
  'git:environment',
  'git:snapshot',
  'git:diff',
  'models:get',
  'models:builtins',
  'models:builtin-login-state',
  'models:default',
  'models:default-thinking',
  'host:credential-import-status',
  'settings:get',
  'settings:instructions',
  'settings:fonts',
  'mcp:get',
  'host:directories',
  'host:storage-info',
  'plugins:list',
  'plugins:session',
  'plugins:diagnostics',
  'host:modules',
  'settings:theme-directories',
  'session:history',
  'session:search',
  'session:prefetch',
  'history:query',
  'history:export',
  'resources:catalog',
  'resources:detail',
  'resources:read-skill',
  'settings:usage-stats',
  'settings:subagents',
])
const selections = new Set([
  'pi:fork-reply',
  'pi:new-session',
  'pi:switch-session',
  'workspace:select',
  'pi:directory',
  'git:switch-branch',
  'git:create-branch',
  'git:create-worktree',
])

export async function createHost(options: HostOptions = {}) {
  const root = hostDataRoot(options.dataRoot)
  const storagePaths = createHostStoragePaths(root)
  const instanceId = randomUUID()
  const unlock = await lockDataRoot(root)
  let cleanup: (() => Promise<void>) | undefined
  try {
    await assertActiveDataRoot(root)
    await assertStorageLayout(root)
    const hostId = await ensureHostIdentity(root)
    const cleanupReport = await cleanupTemporaryFiles(storagePaths)
    const paths = createPiRuntimePaths(root)
    const goals = new GoalService({ file: storagePaths.goalsFile, sessionsDirectory: paths.sessionsDirectory })
    await goals.init()
    await installBuiltinSkills(
      options.builtinSkillsSource ?? fileURLToPath(new URL('../../../pi/skills', import.meta.url)),
      paths.builtinSkillsDirectory,
    )
    await mkdir(paths.sessionsDirectory, { recursive: true })
    await mkdir(storagePaths.attachmentsDirectory, { recursive: true, mode: 0o700 })
    await mkdir(storagePaths.logsDirectory, { recursive: true })
    const temporarySessionsRoot = storagePaths.temporarySessionsDirectory
    await mkdir(temporarySessionsRoot, { recursive: true, mode: 0o700 })
    const orphanEntries = await readdir(temporarySessionsRoot, { withFileTypes: true }).catch((cause: unknown) => {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new Error(`无法读取临时会话目录进行启动清扫：${String(cause)}`)
    })
    for (const entry of orphanEntries) {
      if (entry.isDirectory()) {
        try {
          await rm(path.join(temporarySessionsRoot, entry.name), { recursive: true, force: true })
        } catch (cause) {
          throw new Error(`无法清理上次运行残留的临时会话目录 ${entry.name}：${String(cause)}`)
        }
      }
    }
    const settings = new SettingsStore(root)
    const projects = new ProjectStore(root)
    await settings.load()
    await projects.load()
    const sessions = new SessionService(paths.sessionsDirectory, storagePaths.sessionsCacheFile)
    await sessions.init()
    if (options.testCredentials && !options.dataRoot) throw new Error('测试凭据必须同时配置临时数据目录')
    const credentials =
      options.credentials ??
      (options.testCredentials ? new MemoryCredentialStorage() : await FileCredentialStore.create(root))
    if (options.testCredentials) {
      const seed = await readFile(path.join(storagePaths.credentialsDirectory, 'test-credentials.json'), 'utf8').catch(
        () => '{}',
      )
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
      'git:switch-branch',
      'git:create-branch',
      'git:create-worktree',
      'pi:abort',
      'pi:pause',
      'pi:resume',
      'pi:recover',
      'pi:steer-queue-input',
      'pi:delete-queue-input',
      'pi:begin-queue-edit',
      'pi:update-queue-input',
      'pi:cancel-queue-edit',

      'pi:interrupt-agent',
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
      'resources:import',
      'resources:remove',
      'resources:save-skill',
      'resources:set-policy',
      'resources:refresh',
      'models:builtin-login',
      'models:builtin-login-respond',
      'models:builtin-login-cancel',
      'models:builtin-logout',
    ])
    const clientRequests = new Map<string, number>()
    const clientTimers = new Map<string, ReturnType<typeof setTimeout>>()
    const checkoutGates = new Set<string>()
    const withinCheckout = (cwd: string, checkoutRoot: string) => {
      const relative = path.relative(checkoutRoot, cwd)
      return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
    }
    const assertCheckoutAvailable = (cwd: string) => {
      if ([...checkoutGates].some((checkoutRoot) => withinCheckout(cwd, checkoutRoot)))
        throw new Error('此工作目录正在切换 Git 分支，请稍后操作')
    }
    const gitWrites = new Map<string, Promise<unknown>>()
    const serializeGit = async <T>(commonDirectory: string, operation: () => Promise<T>) => {
      const pending = (gitWrites.get(commonDirectory) ?? Promise.resolve()).catch(() => {}).then(operation)
      gitWrites.set(commonDirectory, pending)
      try {
        return await pending
      } finally {
        if (gitWrites.get(commonDirectory) === pending) gitWrites.delete(commonDirectory)
      }
    }
    let pi: PiSessionPool
    let appControl: Awaited<ReturnType<typeof createAppControl>> | undefined
    const agentSelections = new Map<string, string[]>()
    const temporaryViews = new Map<string, ClientView>()
    const temporarySessions = new Map<
      string,
      {
        clientId: string
        sessionKey: string
        view: ClientView
        temporaryRoot: string
        runtimePaths: PiRuntimePaths
        ref?: import('@pi-meme/contracts/app-host').AppSession
      }
    >()
    const temporarySessionOwners = new Map<string, string>()
    const temporaryPathsBySessionKey = new Map<string, PiRuntimePaths>()
    const temporaryClosing = new Set<string>()
    const inFlightClosing = new Map<string, Promise<void>>()
    const openingClients = new Map<string, Promise<Snapshot>>()
    const temporaryUploads = new Map<string, Set<Promise<unknown>>>()
    const temporaryUploadControllers = new Map<string, Set<AbortController>>()
    let closeAndDestroyTemporarySession: (
      clientId: string,
      info: {
        sessionKey: string
        view: ClientView
        temporaryRoot: string
        ref?: import('@pi-meme/contracts/app-host').AppSession
      },
    ) => Promise<void> = async () => {}
    let collaboration!: ReturnType<typeof createHostCollaborationBridge>

    const getAgentRootSessionKey = (agentIdOrKey: string): string | undefined => {
      return collaboration?.rootSessionKey?.(agentIdOrKey)
    }

    const checkSessionAuthorization = (
      sessionKeyOrAgentId: string | undefined,
      clientId: string,
      isClosingAllowed = false,
    ) => {
      if (!sessionKeyOrAgentId) return
      const rootKey = getAgentRootSessionKey(sessionKeyOrAgentId) ?? sessionKeyOrAgentId
      const owner = temporarySessionOwners.get(rootKey) ?? temporarySessionOwners.get(sessionKeyOrAgentId)
      if (owner && owner !== clientId) {
        throw new Error('无权访问其他窗口的临时会话')
      }
      if (!isClosingAllowed && (temporaryClosing.has(rootKey) || temporaryClosing.has(sessionKeyOrAgentId))) {
        throw new Error('临时会话正在关闭，操作未执行')
      }
    }

    const emit = (type: HostEvent['type'], value?: DesktopEvent | Connection | DesktopError) => {
      appControl?.observe({ hostId, type, value } as HostEvent)
      for (const [clientId, subscribers] of listeners) {
        const view = views.get(clientId)
        const tempView = temporaryViews.get(clientId)

        if (type === 'connection') {
          const conn = value as Connection
          if (view && conn?.sessionKey === view.sessionKey) {
            const adjusted = { ...conn, generation: view.generation }
            for (const subscriber of subscribers) subscriber({ hostId, type, value: adjusted } as HostEvent)
          } else if (tempView && conn?.sessionKey === tempView.sessionKey) {
            const adjusted = { ...conn, generation: tempView.generation }
            for (const subscriber of subscribers) subscriber({ hostId, type, value: adjusted } as HostEvent)
          }
          continue
        }

        const targetSessionKey =
          type === 'event'
            ? (value as DesktopEvent)?.sessionKey
            : type === 'error'
              ? (value as DesktopError)?.sessionKey
              : undefined

        let tempOwner = targetSessionKey ? temporarySessionOwners.get(targetSessionKey) : undefined
        if (!tempOwner && type === 'event' && value) {
          const ev = value as DesktopEvent
          const agentId = ev.agentId ?? ev.rootAgentId
          if (agentId) {
            const rootKey = getAgentRootSessionKey(agentId)
            if (rootKey) tempOwner = temporarySessionOwners.get(rootKey)
          }
          if (!tempOwner && ev.sessionKey) {
            const rootKey = getAgentRootSessionKey(ev.sessionKey)
            if (rootKey) tempOwner = temporarySessionOwners.get(rootKey)
          }
        }
        if (tempOwner !== undefined) {
          if (clientId === tempOwner && tempView) {
            const adjusted = value ? { ...value, generation: tempView.generation } : undefined
            for (const subscriber of subscribers) subscriber({ hostId, type, value: adjusted } as HostEvent)
          }
          continue
        }

        if (!view) continue
        const adjusted = value ? { ...value, generation: view.generation } : undefined
        for (const subscriber of subscribers) subscriber({ hostId, type, value: adjusted } as HostEvent)
      }
    }
    const activities = new ActivityService({
      hostId,
      dataRoot: root,
      onChange: (activity) => {
        void appControl
          ?.publish({
            type: 'activity',
            sessionId: activity.sessionId,
            value: { serviceId: activity.serviceId, revision: activity.revision },
          })
          .catch((cause: unknown) => emit('error', { generation: 0, message: `活动状态更新失败：${String(cause)}` }))
      },
      onLogs: ({ session, serviceId, sequence }) =>
        appControl?.publishLive({
          type: 'activity',
          sessionId: session.sessionId,
          value: { serviceId, logSequence: sequence },
        }),
    })
    const scheduleClientRelease = (clientId: string) => {
      const previous = clientTimers.get(clientId)
      if (previous) clearTimeout(previous)
      clientTimers.delete(clientId)
      if (listeners.get(clientId)?.size || clientRequests.get(clientId)) return
      const timer = setTimeout(() => {
        clientTimers.delete(clientId)
        const tempInfo = temporarySessions.get(clientId)
        if (tempInfo) {
          void closeAndDestroyTemporarySession(clientId, tempInfo).catch((cause: unknown) => {
            emit('error', {
              generation: 0,
              sessionKey: tempInfo.sessionKey,
              message: `清理临时会话失败：${String(cause)}`,
            })
          })
        }
        const view = views.get(clientId)
        if (view) {
          void pi
            .releaseQueueEdits(clientId)
            .catch((cause: unknown) => {
              emit('error', {
                generation: 0,
                sessionKey: view.sessionKey,
                message: `释放队列编辑失败：${String(cause)}`,
              })
            })
            .finally(() => {
              if (views.get(clientId) !== view || listeners.get(clientId)?.size || clientRequests.get(clientId)) return
              pi.releaseClientView(view)
              views.delete(clientId)
              selectionEpochs.delete(clientId)
            })
        }
      }, options.clientGraceMs ?? 120000)
      timer.unref()
      clientTimers.set(clientId, timer)
    }
    let plugins: PluginManager
    let sessionCleanup: SessionCleanupService
    let closing = false
    const activityBridge = createActivityBridge({
      activities,
      agentDir: paths.agentDir,
      caller: (session) => {
        const actor = collaboration.activityCaller(session)
        if (actor.depth !== 0) return actor
        const binding = pi.readSessionBinding(actor.rootSessionKey)
        return {
          ...actor,
          cwd: binding.cwd,
          accessMode: binding.accessMode,
          mode: binding.state.activeMode ?? actor.mode,
        }
      },
      sessionForRuntime: (key) => appControl!.sessionForRuntime(key),
      assertAvailable: (cwd) => {
        if (closing) throw new Error('Host 正在退出，不能管理项目服务')
        assertCheckoutAvailable(cwd)
        pi.assertWorkspaceAvailable(cwd)
      },
    })
    let resourceGeneration = 0
    let commandRevision = 0
    const publishResourcesChanged = (generation = resourceGeneration) => {
      resourceGeneration = Math.max(resourceGeneration, generation)
      commandRevision++
      if (closing) return
      for (const subscribers of listeners.values())
        for (const subscriber of subscribers)
          subscriber({ hostId, type: 'resources-changed', value: { generation: resourceGeneration } })
    }
    const imageGeneration = new ImageGenerationService(
      new ImageConfigStore(storagePaths.agentImageGenerationFile, credentials),
      (name, bytes, signal, destinationDirectory) =>
        storeChatAttachment(root, name, Readable.from([bytes]), signal, { destinationDirectory }),
    )
    let builtins: Awaited<ReturnType<typeof createBuiltinModules>> | undefined
    let retireWorkers: (keys: string[]) => Promise<void>
    const workerSnapshots = new Map<string, ResourceSnapshot>()
    const resources = new ResourceStore(root, {
      hostId,
      getAppPackages: () => plugins?.resourcePackages() ?? [],
      onChange: (generation) => {
        publishResourcesChanged(generation)
        if (!builtins || closing) return
        for (const [key, previous] of workerSnapshots) {
          void resources
            .snapshot(previous.cwd)
            .then((next) => {
              if (workerSnapshots.get(key) === previous && next.id !== previous.id) return retireWorkers([key])
            })
            .catch((cause: unknown) =>
              emit('error', { generation: 0, sessionKey: key, message: `资源更新失败：${String(cause)}` }),
            )
        }
      },
    })
    await resources.init()
    const workerPlugins = new Map<string, PluginDescriptor[]>()
    const workerPluginIds = new Map<string, Set<string>>()
    const pluginNode =
      options.restrictedNode ?? process.env.PI_MEME_PLUGIN_NODE ?? (process.versions.electron ? '' : process.execPath)
    const pluginSandboxCapability = await probePluginSandbox(pluginNode)
    const workers = new Map<string, RuntimeSdkSession>()
    const workerPluginBridges = new Map<string, ReturnType<typeof createPluginCallBridge>>()
    const pluginCredentialPrefix = (id: string) => `plugin:${encodeURIComponent(id)}:http:`
    const credentialKey = (id: string, ref: string) => {
      if (!/^[\w.-]{1,128}$/.test(ref)) throw new Error('invalid-input: 凭据引用无效')
      return pluginCredentialPrefix(id) + ref
    }
    const pluginHttp = new PluginHttpBroker((id, ref) => {
      const value = credentials.get(credentialKey(id, ref))
      if (!value) return undefined
      try {
        return JSON.parse(value) as PluginCredentialValue
      } catch {
        return undefined
      }
    })
    const pluginCalls = new Map<string, { pluginId: string; controller: AbortController }>()
    const pluginClient = new AsyncLocalStorage<string>()
    const goalRuns = new WeakMap<RuntimeSdkSession, GoalRun>()
    const admittedGoalRuns = new WeakMap<RuntimeSdkSession, Set<string>>()
    const createSession = (
      cwd: string,
      notify: Parameters<typeof createWorkerSession>[1],
      sessionKey = `worker:${randomUUID()}`,
      runtimePaths = paths,
      parentSessionKey?: string,
    ) => {
      if (parentSessionKey && temporarySessionOwners.has(parentSessionKey)) {
        temporarySessionOwners.set(sessionKey, temporarySessionOwners.get(parentSessionKey)!)
      }
      if (parentSessionKey && temporaryPathsBySessionKey.has(parentSessionKey)) {
        temporaryPathsBySessionKey.set(sessionKey, temporaryPathsBySessionKey.get(parentSessionKey)!)
      }
      const effectivePaths =
        runtimePaths !== paths
          ? runtimePaths
          : (parentSessionKey && temporaryPathsBySessionKey.get(parentSessionKey)) ||
            (sessionKey && temporaryPathsBySessionKey.get(sessionKey)) ||
            paths
      const session = createWorkerSession(cwd, notify, effectivePaths, async () => {
        let snapshot = (parentSessionKey && workerSnapshots.get(parentSessionKey)) || (await resources.snapshot(cwd))
        let lease: ReturnType<PluginManager['acquire']> | undefined
        if (parentSessionKey && workerPlugins.has(parentSessionKey)) {
          lease = plugins.acquire(undefined, workerPlugins.get(parentSessionKey))
        } else {
          for (let attempt = 0; attempt < 3; attempt++) {
            const disabled = new Set(
              (snapshot.appPlugins ?? []).filter((item) => !item.enabled).map((item) => item.owner.id),
            )
            const selectedAgents =
              agentSelections.get(parentSessionKey ?? sessionKey) ??
              appControl?.selectedAgentPlugins(parentSessionKey ?? sessionKey) ??
              settings.settings.defaultAgentPlugins ??
              []
            const catalog = plugins.list()
            const byId = new Map(catalog.map((item) => [item.id, item]))
            for (const id of selectedAgents) {
              const entry = byId.get(id)
              const reason = !entry
                ? '插件已卸载或不存在'
                : !entry.enabled
                  ? '插件已停用'
                  : disabled.has(id)
                    ? '当前项目已禁用此插件'
                    : entry.status === 'failed'
                      ? (entry.error ?? '插件加载失败')
                      : !entry.agent
                        ? '未提供可用的 Agent 入口'
                        : undefined
              if (reason) throw new Error(`operation-unavailable-in-runtime: 已选择的插件 ${id} 不可用：${reason}`)
            }
            const agentIds = new Set(catalog.filter((item) => item.agent).map((item) => item.id))
            const candidate = plugins.acquire(
              (id) => !disabled.has(id) && (!agentIds.has(id) || selectedAgents.includes(id)),
            )
            const generations = new Map(snapshot.appPlugins?.map((item) => [item.owner.id, item.owner.generation]))
            if (candidate.descriptors.every((item) => generations.get(item.id) === item.generation)) {
              lease = candidate
              break
            }
            await candidate.release()
            snapshot = await resources.snapshot(cwd)
          }
          if (!lease) throw new Error('插件在资源扫描期间更新，请重试当前任务')
        }
        const releaseResource = resources.acquire(snapshot)
        workerSnapshots.set(sessionKey, snapshot)
        workerPlugins.set(sessionKey, lease.descriptors)
        workerPluginIds.set(sessionKey, new Set(lease.retainedIds))
        workers.set(sessionKey, session)
        const pluginBridge = createPluginCallBridge({
          lease,
          manager: plugins,
          actor: () => collaboration.goalCaller(session),
          sessionRef: () => appControl!.sessionForRuntime(collaboration.goalCaller(session).rootSessionKey),
          node: pluginNode,
          runnerEntry: options.restrictedEntry ?? (process.env.PI_MEME_PLUGIN_ENTRY || undefined),
          dataRoot: root,
          http: pluginHttp,
          sandboxCapability: pluginSandboxCapability,
          ui: async (input, signal) => {
            const target = session as unknown as {
              pluginUi: (input: unknown) => Promise<unknown>
              pluginUiCancel: (scopeId: string) => Promise<void>
            }
            const scopeId = randomUUID()
            const cancel = () => {
              void target.pluginUiCancel(scopeId).catch(() => {})
            }
            signal.throwIfAborted()
            signal.addEventListener('abort', cancel, { once: true })
            try {
              return await target.pluginUi({ ...input, scopeId })
            } finally {
              signal.removeEventListener('abort', cancel)
            }
          },
        })
        workerPluginBridges.set(sessionKey, pluginBridge)
        return {
          credentials,
          dataRoot: root,
          settings: settings.settings,
          agentEntries: lease.agentEntries,
          resourceSnapshot: snapshot,
          workerPath: options.workerPath ?? fileURLToPath(new URL('./session-worker.ts', import.meta.url)),
          admit: async (
            message,
            mode,
            continuation,
            signal,
            origin = continuation ? 'collaboration' : 'user',
            expected,
          ) => {
            const actor = collaboration.goalCaller(session)
            const current = await appControl?.goalForRuntime(actor.rootSessionKey)
            if (
              origin === 'goal' &&
              (!current ||
                current.status !== 'active' ||
                current.goalId !== expected?.goalId ||
                current.revision !== expected?.revision)
            )
              throw new Error('目标已暂停或发生变更')
            if (mode === 'plan' && current?.status === 'active')
              await goals.stop(current.session, 'paused', '进入规划模式，目标已暂停')
            if (origin === 'recovery') await collaboration.admitRecovery(session, mode, signal)
            else await collaboration.admit(session, message, mode, origin === 'collaboration', signal)
            const run =
              actor.depth === 0
                ? await appControl?.admitGoal(actor.rootSessionKey, origin, expected)
                : current?.status === 'active'
                  ? await appControl?.goalRunForRuntime(actor.rootSessionKey)
                  : undefined
            if (run) {
              goalRuns.set(session, run)
              const known = admittedGoalRuns.get(session) ?? new Set<string>()
              known.add(`${run.goalId}:${run.cycleId}`)
              admittedGoalRuns.set(session, known)
            } else goalRuns.delete(session)
            return run
          },
          goal: async (request, run, signal) => {
            if (signal.aborted) throw new Error('目标请求已取消')
            const actor = collaboration.goalCaller(session)
            if (request.method === 'get')
              return actor.depth === 0 ? appControl?.goalForRuntime(actor.rootSessionKey) : undefined
            const current = goalRuns.get(session)
            if (!run || !current || run.goalId !== current.goalId || run.cycleId !== current.cycleId)
              throw new Error('目标请求来自过期执行')
            await goals.flush()
            if (request.method === 'gate') {
              const goal = goals.get(run.session)
              if (actor.depth === 0 && !request.tool && goal?.goalId === run.goalId && goal.status === 'complete')
                return goal
              goals.assertActive(run)
              return goal
            }
            if (actor.depth !== 0) throw new Error('子代理不能修改根目标')
            if (!['running', 'waiting_children', 'waiting_input'].includes(actor.status))
              throw new Error('目标执行已结束')
            const canComplete = await appControl!.goalCanComplete(actor.rootSessionKey)
            if (request.input.progress === 'waiting' && canComplete)
              throw new Error('没有仍在执行的子任务或待答交互，请记录实际进展或阻塞')
            return goals.update(run, request.input, canComplete)
          },
          goalUsage: async (run, entryId, usage, inputEntryId) => {
            if (!admittedGoalRuns.get(session)?.has(`${run.goalId}:${run.cycleId}`))
              throw new Error('用量来自未接纳的目标执行')
            await goals.usage(run, entryId, usage, inputEntryId)
          },
          plugin: (request, signal) => pluginBridge.dispatch(request, signal),
          imageGeneration: async (request, signal) => {
            const actor = collaboration.goalCaller(session)
            const permitted = actor.mode !== 'plan' && actor.accessMode !== 'read-only'
            if (request.action === 'ready') return { ready: permitted && (await imageGeneration.ready()) }
            if (!permitted) throw new Error('当前任务模式或访问权限不允许生成图片')
            if (request.action !== 'generate') throw new Error('图片生成请求无效')
            return imageGeneration.generate(request.input, request.sources, {
              cwd: actor.cwd,
              signal,
              destinationDirectory: effectivePaths.temporaryRoot
                ? path.join(effectivePaths.temporaryRoot, 'attachments')
                : undefined,
              assertActive: () => {
                const current = collaboration.goalCaller(session)
                if (
                  current.mode === 'plan' ||
                  current.accessMode === 'read-only' ||
                  current.runId !== actor.runId ||
                  current.epoch !== actor.epoch ||
                  current.executionGeneration !== actor.executionGeneration ||
                  !['running', 'waiting_children', 'waiting_input'].includes(current.status)
                )
                  throw new Error('图片请求来自已结束或过期执行')
              },
            })
          },
          activity: (request, signal) => activityBridge.dispatch(session, request, signal),
          collaboration: (request, signal) => collaboration.dispatch(session, request, signal),
          savePlan: (input, signal) => collaboration.savePlan(session, input, signal),
          syncPlan: (force) => collaboration.syncPlan(session, force),
          resolvePlan: (reference, signal) => collaboration.resolvePlan(session, reference, signal),
          release: async () => {
            try {
              try {
                await pluginBridge.close()
              } finally {
                await lease.release()
              }
            } finally {
              releaseResource()
              workerPluginBridges.delete(sessionKey)
              workerSnapshots.delete(sessionKey)
              workerPlugins.delete(sessionKey)
              workerPluginIds.delete(sessionKey)
              workers.delete(sessionKey)
              publishResourcesChanged()
            }
          },
        }
      })
      return session
    }
    const accessStore = new AgentAccessStore(storagePaths.agentPermissionsFile)
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
      accessStore,
      paths,
      credentials,
      (cwd, notify, runtimePaths, _credentials, _mcp, sessionKey) =>
        createSession(cwd, notify, sessionKey, runtimePaths),
    )
    pi.configureCheckoutGate(assertCheckoutAvailable)
    collaboration = createHostCollaborationBridge({
      getSubagentDefaults: () => settings.snapshot().settings.subagentDefaults,
      dataRoot: root,
      collaborationRootsDirectory: storagePaths.collaborationRootsDirectory,
      collaborationPlansFile: storagePaths.collaborationPlansFile,
      plansDataDirectory: storagePaths.plansDataDirectory,
      assertCheckoutAvailable,
      stopServicesForRun: (run) => activities.stopRun(run),
      createSession: (cwd, notify, key, parentKey) => createSession(cwd, notify, key, paths, parentKey),
      emit: (value) => {
        if (value.agentId && value.agentId === value.rootAgentId && value.sessionKey)
          pi.publishSessionEvent(value.sessionKey, value)
        else emit('event', value)
      },
    })
    const bindRoot = async (key: string) => collaboration.bindRoot(pi.readSessionBinding(key))
    pi.configureCollaboration({
      pause: async (key) => {
        await bindRoot(key)
        const goal = await appControl?.goalForRuntime(key)
        if (goal?.status === 'active') {
          await goals.stop(goal.session, 'paused', '用户停止了目标执行')
          await pi.abort(key)
          return
        }
        await collaboration.pauseRoot(key)
      },
      resume: async (key) => {
        await bindRoot(key)
        await collaboration.resumeRoot(key)
      },
      modeChanged: async (key) => {
        await bindRoot(key)
        await collaboration.setSessionMode(key, pi.getSessionContext(key).state.mode)
      },
      decorateEvent: (key, event) => collaboration.decorateRootEvent(key, event),
      beforePrompt: async (key) => {
        await bindRoot(key)
      },
      beforeFork: (key, agentIds) => collaboration.prepareFork(key, agentIds),
      forked: async (source, key, agentIds) => {
        await collaboration.adoptFork(source, pi.readSessionBinding(key), agentIds)
      },
      settled: async (key, event) => {
        await bindRoot(key)
        await collaboration.rootSettled(key, event)
      },
      failed: async (key, cause, runId) => {
        await bindRoot(key)
        await collaboration.rootFailed(key, cause, runId)
      },
      stop: async (key) => {
        await bindRoot(key)
        const goal = await appControl?.goalForRuntime(key)
        if (goal?.status === 'active') await goals.stop(goal.session, 'paused', '目标执行已停止')
        await collaboration.stopRoot(key)
      },
    })
    closeAndDestroyTemporarySession = async (
      clientId: string,
      info: {
        sessionKey: string
        view: ClientView
        temporaryRoot: string
        ref?: import('@pi-meme/contracts/app-host').AppSession
      },
    ) => {
      const inFlight = inFlightClosing.get(info.sessionKey)
      if (inFlight) return inFlight

      temporaryClosing.add(info.sessionKey)

      const performClose = async () => {
        const ref = info.ref ?? (await appControl?.sessionForRuntime(info.sessionKey))
        if (ref) {
          info.ref = ref
          temporaryClosing.add(ref.sessionId)
        }
        const targetSessionIds = [info.sessionKey, ...(ref ? [ref.sessionId] : [])]

        if (pi.hasSession(info.sessionKey)) {
          await bindRoot(info.sessionKey)
          await collaboration.stopRoot(info.sessionKey)
          await activityBridge.waitForStarts(info.sessionKey)
          if (ref) {
            for (const activity of activities.list(ref).activities) {
              if (isLiveServiceActivity(activity)) {
                await activities.stop(ref, activity.serviceId, '关闭临时会话')
              }
            }
          }
          await pi.closeTemporarySession(info.sessionKey)
        }

        if (ref) {
          await appControl?.waitForSessionOperations(ref.sessionId)
        }

        await collaboration.deleteTemporarySessions({
          sessionIds: targetSessionIds,
          sessionFiles: [],
        })

        if (ref) {
          await goals.deleteSessions([ref.sessionId])
        }

        if (ref?.sessionFile) {
          await accessStore.remove([ref.sessionFile])
        }

        await appControl!.deleteSessions({
          deletedPaths: ref?.sessionFile ? [ref.sessionFile] : [],
          deletedKeys: [info.sessionKey],
          deletedSessionIds: ref ? [ref.sessionId] : [],
        })

        const controllers = temporaryUploadControllers.get(info.sessionKey)
        if (controllers) {
          for (const c of controllers) c.abort()
        }
        const uploads = temporaryUploads.get(info.sessionKey)
        if (uploads && uploads.size > 0) {
          await Promise.allSettled(uploads)
        }

        await rm(info.temporaryRoot, { recursive: true, force: true })

        for (const [key, owner] of [...temporarySessionOwners.entries()]) {
          if (
            owner === clientId &&
            (key === info.sessionKey || key.startsWith('worker:') || key.startsWith('agent:'))
          ) {
            temporarySessionOwners.delete(key)
            temporaryPathsBySessionKey.delete(key)
            agentSelections.delete(key)
            workerPlugins.delete(key)
            workerPluginIds.delete(key)
            workerSnapshots.delete(key)
          }
        }
        temporaryUploads.delete(info.sessionKey)
        temporaryUploadControllers.delete(info.sessionKey)
        temporarySessions.delete(clientId)
        temporaryViews.delete(clientId)
        pi.releaseClientView(info.view)
        temporaryClosing.delete(info.sessionKey)
        if (ref) temporaryClosing.delete(ref.sessionId)
      }

      const closePromise = performClose().finally(() => {
        if (inFlightClosing.get(info.sessionKey) === closePromise) {
          inFlightClosing.delete(info.sessionKey)
        }
      })
      inFlightClosing.set(info.sessionKey, closePromise)
      return closePromise
    }
    retireWorkers = async (keys: string[]) => {
      const temporary = keys.filter((key) => key.startsWith('worker:')).map((key) => workers.get(key))
      const coordinated = await pi.retireSessions(
        (key) => keys.includes(key),
        async () => {
          await collaboration.retireSessions(keys)
        },
      )
      if (!coordinated) await collaboration.retireSessions(keys)
      await Promise.all(temporary.map((session) => session?.stopAndWait()))
    }
    cleanup = async () => {
      await (
        builtins?.services['host.schedules.runtime'] as
          import('@pi-meme/schedules/server/service').ScheduleService | undefined
      )?.beginShutdown()
      await collaboration?.stopAndWait()
      await pi.stopAndWait()
      await activities.dispose()
      await plugins?.dispose()
      await builtins?.dispose()
      await resources.waitForIdle()
      await (credentials as SecureCredentialStorage & { flush?: () => Promise<void> }).flush?.()
    }
    pi.configureWorkspaces({
      kind: (cwd) => projects.kind(cwd),
      sourceProjectCwd: (cwd) => projects.sourceProjectCwd(cwd),
      createStandaloneDirectory: () => projects.createStandaloneDirectory(),
    })
    pi.configureCapabilities({
      codemodeEnabled: true,
      mcpEnabled: settings.settings.mcpEnabled ?? false,
    })
    if (settings.settings.defaultAccessMode) await pi.configureDefaultAccessMode(settings.settings.defaultAccessMode)
    const models = new ModelConfigStore(path.join(paths.agentDir, 'models.json'), credentials, paths.agentDir)
    const modelService = new ModelService(pi, models)
    const mcp = new McpConfigStore(path.join(paths.agentDir, 'mcp.json'), credentials)
    const uiDescriptors = (descriptors: PluginDescriptor[]) =>
      descriptors.map((descriptor) => ({
        ...descriptor,
        iconUrl: descriptor.display?.icon
          ? `/api/plugins/${instanceId}/${encodeURIComponent(descriptor.id)}/${descriptor.generation}/${descriptor.display.icon}`
          : undefined,
        ui: descriptor.ui
          ? `/api/plugins/${instanceId}/${encodeURIComponent(descriptor.id)}/${descriptor.generation}/${descriptor.ui}`
          : undefined,
      }))
    const sessionDescriptors = async (sessionId?: string) => {
      const cwd = (sessionId && workerSnapshots.get(sessionId)?.cwd) || pi.cwd
      const disabled = await resources.disabledAppPluginIds(cwd)
      const current = new Map(plugins.list().map((entry) => [entry.id, entry]))
      if (sessionId && workerPlugins.has(sessionId)) {
        const retained = workerPlugins.get(sessionId)!
        for (const entry of current.values())
          if ((entry.agent || entry.resources?.skills?.length) && !retained.some((old) => old.id === entry.id))
            current.delete(entry.id)
        for (const entry of retained) {
          const latest = current.get(entry.id)
          current.set(
            entry.id,
            latest && latest.policyHash === entry.policyHash
              ? { ...entry, grant: latest.grant, grantChanging: latest.grantChanging }
              : entry,
          )
        }
      }
      const retainedIds = new Set(sessionId ? workerPlugins.get(sessionId)?.map((item) => item.id) : [])
      return uiDescriptors([...current.values()].filter((item) => retainedIds.has(item.id) || !disabled.has(item.id)))
    }
    const enrichSnapshot = async (value: Snapshot) => {
      const key = value.connection.sessionKey
      const binding = key ? pi.readSessionBinding(key) : undefined
      const [uiPlugins] = await Promise.all([
        sessionDescriptors(key),
        binding ? collaboration.bindRoot(binding) : undefined,
      ])
      const savedMode = key ? await collaboration.getSessionMode(key) : undefined
      const mode =
        key && binding && savedMode
          ? pi.restoreSessionMode(key, savedMode, { mode: binding.state.mode, revision: binding.modeRevision })
          : binding?.state.mode
      const [appSession, coordinated] = await Promise.all([
        key ? appControl?.sessionForRuntime(key) : undefined,
        key ? collaboration.snapshot(key) : {},
      ])
      return {
        ...value,
        appSession,
        goalsSupported: true,
        goal: appSession ? goals.get(appSession) : undefined,
        connection: {
          ...value.connection,
          sourceProjectCwd: projects.sourceProjectCwd(value.connection.cwd),
          restrictedPluginRuntimeSupported: pluginSandboxCapability.supported,
          restrictedPluginRuntimeReason: pluginSandboxCapability.reason,
        },
        state: {
          ...value.state,
          ...(mode ? { mode } : {}),
          resourceSnapshot: key ? workerSnapshots.get(key) : undefined,
        },
        ...coordinated,
        uiPlugins,
      }
    }
    const snapshot = async (window?: import('@pi-meme/contracts/sessions').SessionWindow) =>
      enrichSnapshot(await pi.snapshot(window))
    const readSessionsSnapshot = sessions.getSnapshot.bind(sessions)
    sessions.getSnapshot = async (...args): Promise<PiSessionsSnapshot> => {
      const [value, children] = await Promise.all([readSessionsSnapshot(...args), collaboration.getChildSessions()])
      if (!children.length) return value
      const files = new Set(children.flatMap((child) => (child.sessionFile ? [child.sessionFile] : [])))
      const ids = new Set(children.flatMap((child) => (child.sessionId ? [child.sessionId] : [])))
      const visible = (entry: PiSessionsSnapshot['recents'][number]) => !files.has(entry.path) && !ids.has(entry.id)
      const groups = value.projects
        .map((group) => {
          const entries = group.sessions.filter(visible)
          return {
            ...group,
            sessions: entries,
            sessionCount: group.sessionCount - (group.sessions.length - entries.length),
          }
        })
        .filter((group) => group.sessionCount > 0)
      const standalone = value.standaloneSessions?.filter(visible)
      const all = new Map(
        [...groups.flatMap((group) => group.sessions), ...(standalone ?? []), ...value.recents.filter(visible)].map(
          (entry) => [entry.path, entry],
        ),
      )
      return {
        ...value,
        recents: [...all.values()]
          .sort(
            (a, b) =>
              Date.parse(b.completedAt ?? '1970-01-01T00:00:00.000Z') -
              Date.parse(a.completedAt ?? '1970-01-01T00:00:00.000Z'),
          )
          .slice(0, 30),
        standaloneSessions: standalone,
        pinnedPaths: value.pinnedPaths.filter((file) => !files.has(file) && !ids.has(file)),
        projects: groups,
      }
    }
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
        if (theme.background) throw new Error('背景图片必须随 App 插件分发，请安装 .pim 主题插件')
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
      }),
    }
    const sharedContexts = {
      'host.goals': { goals },
      'host.usage': { sessionsDirectory: paths.sessionsDirectory },
      'host.chat': { pi, getCwd: () => pi.cwd },
      'host.workspace': {
        pi,
        projects,
        sessions,
        mutations: pi,
        prepareDelete: (targets: string[], cwd?: string) => sessionCleanup.prepare(targets, cwd),
        afterDelete: (
          res: WorkspaceDeletionResult,
          prepared: import('./session-cleanup').PreparedDeletionContext,
          cwd?: string,
        ) => sessionCleanup.afterDelete(res, prepared, cwd),
        beforeDelete: async (targets: string[]) => {
          const refs = await appControl!.api.sessions.list()
          for (const ref of refs) {
            const key = appControl!.goalRuntimeKey(ref)
            if (!targets.includes(ref.sessionFile ?? '') && (!key || !targets.includes(key))) continue
            if (key) {
              await bindRoot(key)
              await collaboration.stopRoot(key)
              await activityBridge.waitForStarts(key)
            }
            for (const activity of activities.list(ref).activities)
              if (isLiveServiceActivity(activity)) await activities.stop(ref, activity.serviceId, '删除会话')
          }
        },
        removePins: (value: string[]) => settings.removePins(value),
        getPinnedPaths: () => settings.settings.pinnedPaths ?? [],
        getRuntimeSessions: () => pi.getRuntimeSessions(),
        getSessionTasks: async () => {
          const tasks = await (
            builtins!.services['host.schedules.runtime'] as import('@pi-meme/schedules/server/service').ScheduleService
          ).sessionTasks()
          const sources = new Map<string, NonNullable<PiSessionSummary['scheduledTask']>>()
          if (!tasks.size) return sources
          for (const session of await appControl!.api.sessions.list()) {
            const task = tasks.get(session.sessionId)
            if (!task) continue
            const key = session.sessionFile ?? appControl!.goalRuntimeKey(session)
            if (key) sources.set(key, task)
          }
          return sources
        },
        getRuntimeHistory: (value: string) => pi.getRuntimeHistory(value),
        readRuntimeHistory: (value: string, window?: import('@pi-meme/contracts/sessions').SessionWindow) =>
          pi.readHistory(value, window),
        handlers: workspaceHandlers,
      },
      'host.git': {
        getCwd: () => pi.cwd,
        environment: (key: string) => getGitEnvironment(pi.getSessionContext(key).cwd),
        switchBranch: async (key: string, branch: string, baseRef?: string) => {
          const cwd = pi.getSessionContext(key).cwd
          const environment = await getGitEnvironment(cwd)
          const common = await realpath(
            path.resolve(
              environment.root,
              (await runGit(environment.root, ['rev-parse', '--git-common-dir'])).stdout.trim(),
            ),
          )
          return serializeGit(common, async () => {
            if (checkoutGates.has(environment.root)) throw new Error('此工作目录正在切换分支')
            checkoutGates.add(environment.root)
            const matches = (directory: string) => withinCheckout(directory, environment.root)
            try {
              pi.assertCheckoutIdle(matches)
              collaboration.assertCheckoutIdle(matches)
              activityBridge.assertIdle(environment.root)
              const current = await getGitEnvironment(cwd)
              const sha = baseRef ? await resolveGitBase(current, baseRef) : undefined
              if (current.dirty) throw new Error('工作目录存在未提交更改，请先处理后再切换分支')
              await pi.retireCheckout(matches)
              await collaboration.retireCheckout(matches)
              await switchGitBranch(current, baseRef ?? branch, baseRef ? branch : undefined, sha)
            } finally {
              checkoutGates.delete(environment.root)
            }
            return pi.selectWorkspaceDirectory(cwd, true)
          })
        },
        createWorktree: async (key: string, baseRef: string) => {
          const cwd = pi.getSessionContext(key).cwd
          const environment = await getGitEnvironment(cwd)
          const headSha = await resolveGitBase(environment, baseRef)
          const common = await realpath(
            path.resolve(
              environment.root,
              (await runGit(environment.root, ['rev-parse', '--git-common-dir'])).stdout.trim(),
            ),
          )
          return serializeGit(common, async () => {
            const checkoutRoot = path.join(storagePaths.worktreesDirectory, randomUUID())
            const relative = path.relative(environment.root, cwd)
            const worktree = {
              checkoutRoot,
              cwd: path.join(checkoutRoot, relative),
              sourceProjectCwd: projects.sourceProjectCwd(cwd) ?? cwd,
              baseRef,
              headSha,
            }
            await mkdir(path.dirname(checkoutRoot), { recursive: true })
            await projects.recordWorktree(worktree)
            try {
              await runGit(environment.root, ['worktree', 'add', '--detach', checkoutRoot, headSha])
            } catch (cause) {
              const exists = await stat(checkoutRoot)
                .then((info) => info.isDirectory())
                .catch(() => false)
              const registered = await runGit(environment.root, ['worktree', 'list', '--porcelain'])
                .then((value) => value.stdout.split('\n').includes(`worktree ${checkoutRoot}`))
                .catch(() => exists)
              if (exists || registered) {
                emit('sessions-changed')
                return {
                  ...worktree,
                  selection: { cancelled: true as const },
                  selectionError: `Worktree 创建未完成，目录与来源记录已保留：${checkoutRoot}；${String(cause)}`,
                }
              }
              try {
                await projects.forgetWorktree(checkoutRoot)
              } catch (cleanupError) {
                throw new Error(`Worktree 创建失败：${String(cause)}；清理来源记录失败：${String(cleanupError)}`)
              }
              throw cause
            }
            emit('sessions-changed')
            try {
              return { ...worktree, selection: await pi.selectWorkspaceDirectory(worktree.cwd) }
            } catch (cause) {
              return {
                ...worktree,
                selection: { cancelled: true as const },
                selectionError: `Worktree 已创建，但切换会话失败：${String(cause)}`,
              }
            }
          })
        },
      },
      'host.schedules': {
        hostId,
        onError: (cause: unknown) => emit('error', { generation: 0, message: `定时任务处理失败：${String(cause)}` }),
      },
      'host.resources': { store: resources, getCwd: () => pi.cwd, hostId },
      'host.image-generation': imageGeneration,
      'host.models': { pi, models, agentDir: paths.agentDir, service: modelService },
      'host.settings': {
        pi,
        instructions: new InstructionsStore(root),
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
    builtins = await createBuiltinModules(root, sharedContexts, () => {
      if (!appControl) throw new Error('Host API 尚未初始化')
      return appControl.api
    })
    pi.configureRestrictedAccess(
      (
        builtins.services['agent.sandbox'] as {
          capability: () => import('@pi-meme/pi-runtime/sdk/access-sandbox').SandboxCapability
        }
      ).capability(),
    )
    pi.configureResources(
      (cwd) => resources.snapshot(cwd),
      () => commandRevision,
    )
    pi.configureResourceDiscovery(true)
    const parseId = (value: unknown) => {
      if (typeof value !== 'string') throw new Error('插件 ID 参数无效')
      assertExternalPluginId(value)
      return value
    }
    const handlers: Record<string, Action> = {
      'resources:import': async (value, cwd) => {
        if (!value || typeof value !== 'object') throw new Error('资源导入参数无效')
        const input = value as ResourceImportInput
        if (typeof input.path === 'string' && !input.kind) {
          const content = await readFile(path.join(input.path, 'package.json'), 'utf8').catch(
            (cause: NodeJS.ErrnoException) => {
              if (cause.code === 'ENOENT' || cause.code === 'ENOTDIR') return undefined
              throw cause
            },
          )
          if (content && JSON.parse(content).piMeme) {
            await plugins.loadDirectory(input.path)
            return resources.refresh(typeof cwd === 'string' ? cwd : pi.cwd)
          }
        }
        return resources.import(input, typeof cwd === 'string' ? cwd : pi.cwd)
      },
      'host:credential-import-status': () => ({
        available:
          (process.platform === 'darwin' || Boolean(options.readLegacyCredentials)) &&
          credentials instanceof FileCredentialStore,
      }),
      'host:import-keychain': () =>
        pi.idle(async () => {
          if (!(credentials instanceof FileCredentialStore)) throw new Error('当前 Host 不使用文件凭据存储')
          const readLegacy =
            options.readLegacyCredentials ??
            (async () => {
              if (process.platform !== 'darwin') throw new Error('旧钥匙串导入仅支持 macOS')
              const { KeychainCredentialStore } = await import('@pi-meme/pi-adapter/credentials')
              return (await KeychainCredentialStore.create(root)).entries()
            })
          const result = await credentials.importMissing(await readLegacy())
          try {
            await pi.reconnectModels()
            return result
          } catch {
            return { ...result, reconnectError: '凭据已导入，但 Pi 重连失败；请重新连接模型' }
          }
        }, true),
      'host:session-ref': (key) => {
        if (typeof key !== 'string') throw new Error('会话 ID 参数无效')
        return appControl!.sessionForRuntime(key)
      },
      'host:storage-info': () => ({ hostId, dataRoot: root }),
      'pi:connection': () => pi.connection(),
      'pi:snapshot': async (window) =>
        snapshot(window as import('@pi-meme/contracts/sessions').SessionWindow | undefined),
      'pi:agents': async (key) => {
        if (typeof key !== 'string') throw new Error('会话 ID 参数无效')
        await bindRoot(key)
        return collaboration.getAgents(key)
      },
      'pi:agent-snapshot': async (id) => {
        if (typeof id !== 'string') throw new Error('Agent ID 参数无效')
        const value = await collaboration.getAgentSnapshot(id)
        return { ...value, uiPlugins: await sessionDescriptors(value.connection.sessionKey) }
      },
      'pi:interrupt-agent': (id) => {
        if (typeof id !== 'string') throw new Error('Agent ID 参数无效')
        return collaboration.interruptAgent(id)
      },
      'goal:start': async (key, input) => {
        if (typeof key !== 'string') throw new Error('会话 ID 参数无效')
        return appControl!.api.goals.start(
          await appControl!.sessionForRuntime(key),
          input as Parameters<import('@pi-meme/contracts/app-host').HostApi['goals']['start']>[1],
          { idempotencyKey: randomUUID() },
        )
      },
      ...Object.fromEntries(
        (['edit', 'pause', 'resume', 'clear'] as const).map((method) => [
          `goal:${method}`,
          async (key: unknown, input: unknown) => {
            if (typeof key !== 'string') throw new Error('会话 ID 参数无效')
            const ref = await appControl!.sessionForRuntime(key)
            const action = appControl!.api.goals[method] as (
              ref: import('@pi-meme/contracts/app-host').SessionRef,
              input: unknown,
              options: { idempotencyKey: string },
            ) => Promise<unknown>
            return action(ref, input, { idempotencyKey: randomUUID() })
          },
        ]),
      ),
      'pi:session-mode': async (key, mode) => {
        if (typeof key !== 'string' || (mode !== 'default' && mode !== 'plan')) throw new Error('会话模式参数无效')
        if (mode === 'plan') {
          const ref = await appControl!.sessionForRuntime(key)
          const goal = goals.get(ref)
          if (goal?.status === 'active') await appControl!.api.goals.pause(ref, goal, { idempotencyKey: randomUUID() })
        }
        await pi.setSessionMode(key, mode)
      },
      'temporary-session:open': async (input) => {
        const clientId = pluginClient.getStore()!
        const existing = temporarySessions.get(clientId)
        if (existing) {
          checkSessionAuthorization(existing.sessionKey, clientId)
          return enrichSnapshot(await pi.withClientView(existing.view, () => pi.snapshot()))
        }
        const pending = openingClients.get(clientId)
        if (pending) return pending

        const performOpen = async () => {
          const options = (input && typeof input === 'object' ? input : {}) as {
            sourceSessionKey?: string
            cwd?: string
            accessMode?: AgentAccessMode
          }
          let targetCwd = options.cwd
          let targetAccess = options.accessMode
          let targetModel: PiModel | undefined
          let targetThinking: ThinkingLevel | undefined
          let targetPlugins: string[] | undefined

          if (options.sourceSessionKey) {
            checkSessionAuthorization(options.sourceSessionKey, clientId)
            const sourceContext = pi.readSessionBinding(options.sourceSessionKey)
            targetCwd = sourceContext.cwd
            targetAccess = sourceContext.accessMode
            targetModel = sourceContext.state.model
            targetThinking = sourceContext.state.thinkingLevel
            targetPlugins =
              agentSelections.get(options.sourceSessionKey) ??
              appControl?.selectedAgentPlugins(options.sourceSessionKey) ??
              settings.settings.defaultAgentPlugins ??
              []
          } else {
            const mainView = views.get(clientId)
            if (mainView?.sessionKey) {
              try {
                const mainContext = pi.readSessionBinding(mainView.sessionKey)
                if (!targetCwd) targetCwd = mainContext.cwd
                if (!targetAccess) targetAccess = mainContext.accessMode
                if (!targetModel) targetModel = mainContext.state.model
                if (!targetThinking) targetThinking = mainContext.state.thinkingLevel
                if (!targetPlugins)
                  targetPlugins =
                    agentSelections.get(mainView.sessionKey) ??
                    appControl?.selectedAgentPlugins(mainView.sessionKey) ??
                    settings.settings.defaultAgentPlugins ??
                    []
              } catch {
                /* ignore */
              }
            }
          }
          if (!targetCwd) {
            targetCwd = await projects.createStandaloneDirectory()
          }
          if (!targetPlugins) {
            targetPlugins = settings.settings.defaultAgentPlugins ?? []
          }

          const tempId = randomUUID()
          const temporaryRoot = path.join(temporarySessionsRoot, tempId)
          await mkdir(path.join(temporaryRoot, 'sessions'), { recursive: true, mode: 0o700 })
          await mkdir(path.join(temporaryRoot, 'attachments'), { recursive: true, mode: 0o700 })
          const tempPaths = createTemporaryRuntimePaths(paths, temporaryRoot)

          let tempRecord: ReturnType<typeof pi.createTemporarySession> | undefined
          let tempView: ClientView | undefined

          try {
            tempRecord = pi.createTemporarySession(targetCwd, {
              temporaryRoot,
              accessMode: targetAccess,
              model: targetModel,
              thinkingLevel: targetThinking,
            })
            if (targetPlugins) {
              agentSelections.set(tempRecord.key, targetPlugins)
            }
            tempView = pi.createClientView()
            tempView.clientId = clientId
            tempView.sessionKey = tempRecord.key
            tempView.generation = 1

            const tempAppSession: import('@pi-meme/contracts/app-host').AppSession = {
              hostId,
              sessionId: tempId,
              cwd: targetCwd,
              createdAt: new Date().toISOString(),
              ownerClientId: clientId,
              configuration: {
                agentPlugins: targetPlugins,
                model: targetModel,
                thinkingLevel: targetThinking,
                accessMode: targetAccess,
                mode: 'default',
              },
              status: 'idle',
              temporary: true,
            }
            await appControl!.registerTemporarySession(tempAppSession, tempRecord.key)

            temporaryViews.set(clientId, tempView)
            temporarySessions.set(clientId, {
              clientId,
              sessionKey: tempRecord.key,
              view: tempView,
              temporaryRoot,
              runtimePaths: tempPaths,
              ref: tempAppSession,
            })
            temporarySessionOwners.set(tempRecord.key, clientId)
            temporaryPathsBySessionKey.set(tempRecord.key, tempPaths)

            collaboration.markTemporarySession(tempRecord.key)

            emit(
              'connection',
              pi.withSession(tempRecord.key, () => pi.connection()),
            )
            return enrichSnapshot(await pi.withClientView(tempView, () => pi.snapshot()))
          } catch (cause) {
            if (tempRecord) {
              temporarySessions.delete(clientId)
              temporaryViews.delete(clientId)
              temporarySessionOwners.delete(tempRecord.key)
              temporaryPathsBySessionKey.delete(tempRecord.key)
              await pi.closeTemporarySession(tempRecord.key).catch(() => {})
            }
            if (tempView) {
              pi.releaseClientView(tempView)
            }
            await rm(temporaryRoot, { recursive: true, force: true }).catch(() => {})
            throw cause
          }
        }

        const openPromise = performOpen().finally(() => {
          if (openingClients.get(clientId) === openPromise) openingClients.delete(clientId)
        })
        openingClients.set(clientId, openPromise)
        return openPromise
      },
      'temporary-session:get': async (sessionKey) => {
        const clientId = pluginClient.getStore()!
        const existing = temporarySessions.get(clientId)
        if (!existing) return null
        if (sessionKey && existing.sessionKey !== sessionKey) return null
        checkSessionAuthorization(existing.sessionKey, clientId)
        return enrichSnapshot(await pi.withClientView(existing.view, () => pi.snapshot()))
      },
      'temporary-session:close': async (sessionKey) => {
        if (typeof sessionKey !== 'string') throw new Error('会话 ID 参数无效')
        const clientId = pluginClient.getStore()!
        const owner = temporarySessionOwners.get(sessionKey)
        if (owner && owner !== clientId) throw new Error('无权访问其他窗口的临时会话')
        const existing = temporarySessions.get(clientId)
        if (!existing || existing.sessionKey !== sessionKey) {
          return { closed: true }
        }
        await closeAndDestroyTemporarySession(clientId, existing)
        return { closed: true }
      },
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

      'plugins:diagnostics': () => plugins.diagnostics(),
      'host:modules': () => builtins!.diagnostics(),
      'plugins:list': () => [...systemPlugins, ...uiDescriptors(plugins.list())],
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
      'plugins:set-grant': async (id, update) => {
        for (const call of pluginCalls.values()) if (call.pluginId === id) call.controller.abort()
        return plugins.setGrant(parseId(id), update as PluginGrantUpdate)
      },
      'plugins:credential-list': (id) =>
        credentials
          .entries()
          .filter(([key]) => key.startsWith(pluginCredentialPrefix(parseId(id))))
          .flatMap(([key, value]) => {
            try {
              const { origin, header } = JSON.parse(value) as PluginCredentialValue
              return [{ id: key.slice(pluginCredentialPrefix(String(id)).length), origin, header }]
            } catch {
              return []
            }
          }),
      'plugins:credential-set': async (id, input) => {
        const pluginId = parseId(id)
        const data = input as PluginCredentialValue & { id: string }
        const plugin = plugins.list().find((p) => p.id === pluginId)
        if (
          !plugin?.permissions?.restricted?.network?.some((r) => r.origin === data.origin) ||
          !['Authorization', 'X-Api-Key'].includes(data.header) ||
          typeof data.value !== 'string' ||
          !data.value ||
          data.value.length > 8192 ||
          /[\r\n]/.test(data.value)
        )
          throw new Error('permission-denied: 凭据目标或内容无效')
        credentials.set(
          credentialKey(pluginId, data.id),
          JSON.stringify({ origin: data.origin, header: data.header, value: data.value }),
        )
        await (credentials as SecureCredentialStorage & { flush?: () => Promise<void> }).flush?.()
      },
      'plugins:credential-remove': async (id, ref) => {
        credentials.delete(credentialKey(parseId(id), parseId(ref)))
        await (credentials as SecureCredentialStorage & { flush?: () => Promise<void> }).flush?.()
      },
      'plugins:call-cancel': (id) => {
        pluginCalls.get(`${pluginClient.getStore()}:${String(id)}`)?.controller.abort()
      },
      'plugins:ui-lease-acquire': (input) =>
        plugins.acquireUiLease(
          pluginClient.getStore()!,
          input as { pluginId: string; generation: number; routeInstance: string },
        ),
      'plugins:ui-lease-renew': (id) => plugins.renewUiLease(pluginClient.getStore()!, parseId(id)),
      'plugins:ui-lease-release': (id) => plugins.releaseUiLease(pluginClient.getStore()!, parseId(id)),
      'plugins:call': async (input) => {
        const request = input as PluginCallRequest
        const owner = pluginClient.getStore()!
        const target = request.target ?? { hostId }
        if (target.hostId !== hostId) throw new Error('permission-denied: 插件目标不属于当前 Host')
        if (target.session) await appControl!.api.sessions.get(target.session)
        if (target.project) await appControl!.api.projects.get(target.project)
        const key = `${owner}:${request.requestId}`
        if (pluginCalls.has(key)) throw new Error('invalid-input: 调用标识重复')
        const controller = new AbortController()
        pluginCalls.set(key, { pluginId: request.pluginId, controller })
        try {
          const grant = plugins.getGeneration(request.pluginId, request.generation)?.grant
          const context: PluginCallContext = {
            pluginId: request.pluginId,
            generation: request.generation,
            origin: 'ui',
            target,
            mode: 'default',
            accessMode: 'full-access',
            capabilities: grant?.restricted.capabilities ?? [],
            signal: controller.signal,
            requestId: request.requestId,
          }
          return await plugins.callUi(owner, request, context)
        } finally {
          pluginCalls.delete(key)
        }
      },
    }
    const terminal = new TerminalService({
      hostId,
      resolveRoot: (ref) => appControl!.resolveRoot(ref),
      onEvent: (value) => appControl?.publishLive({ type: 'terminal', value }),
    })
    const validateAgentIds = (ids: string[], restore = false) => {
      if (
        !Array.isArray(ids) ||
        ids.some(
          (id) =>
            typeof id !== 'string' ||
            (!restore && !plugins.list().some((item) => item.id === id && item.agent && item.enabled)),
        )
      )
        throw new Error('Agent 插件选择无效')
    }
    const schedules = builtins.services[
      'host.schedules.runtime'
    ] as import('@pi-meme/schedules/server/service').ScheduleService
    appControl = await createAppControl({
      models: { list: () => modelService.list() },
      imageGeneration: {
        getConfig: () => imageGeneration.config.snapshot(),
        saveModel: (input) => imageGeneration.config.save(input),
        deleteModel: (id, revision) => imageGeneration.config.delete(id, revision),
        setDefault: (id, revision) => imageGeneration.config.setDefault(id, revision),
        test: (id) => {
          if (typeof id !== 'string' || !id) throw new Error('测试图片必须选择模型配置')
          return imageGeneration.generate(
            { prompt: '生成一张简洁的蓝色圆形测试图片，白色背景，不包含文字。' },
            [],
            { cwd: root, signal: new AbortController().signal },
            id,
          )
        },
      },
      schedules,
      hostId,
      root,
      controlPaths: storagePaths,
      goals,
      activities,
      pi,
      projects,
      sessions,
      collaboration,
      bindRoot,
      snapshot,
      onError: (cause) => emit('error', { generation: 0, message: `Host 控制事件处理失败：${String(cause)}` }),
      isSessionClosing: (session) => {
        const key = appControl?.goalRuntimeKey(session)
        return Boolean(temporaryClosing.has(session.sessionId) || (key && temporaryClosing.has(key)) || closing)
      },
      defaultAgentPlugins: {
        getDefaultAgentPlugins: async () =>
          (settings.settings.defaultAgentPlugins ?? []).filter((id) =>
            plugins?.list().some((item) => item.id === id && item.agent && item.enabled),
          ),
        setDefaultAgentPlugins: async (ids) => {
          validateAgentIds(ids)
          await settings.save({ ...settings.settings, defaultAgentPlugins: [...new Set(ids)] })
          return [...settings.settings.defaultAgentPlugins!]
        },
      },
      configureAgentPlugins: async (key, ids, input) => {
        validateAgentIds(ids, input?.restore === true)
        if (JSON.stringify(agentSelections.get(key)) === JSON.stringify(ids)) return
        await retireWorkers([key])
        agentSelections.set(key, ids)
      },
      workspace: {
        files: createWorkspaceFiles(
          (ref) => appControl!.resolveRoot(ref),
          (ref) => {
            const roots = [storagePaths.attachmentsDirectory]
            if (ref && 'sessionId' in ref) {
              for (const item of temporarySessions.values()) {
                if (item.ref?.sessionId === ref.sessionId) {
                  roots.push(path.join(item.temporaryRoot, 'attachments'))
                }
              }
            }
            return roots
          },
        ),
        terminal,
        terminalSupported: terminal.supported,
      },
    })
    sessionCleanup = new SessionCleanupService({
      maintenanceDirectory: storagePaths.maintenanceDirectory,
      accessStore,
      collaboration,
      goals,
      control: {
        deleteSessions: (res) => appControl!.deleteSessions(res),
        lookupSessionIds: (paths, keys) => appControl!.lookupSessionIds(paths, keys),
      },
      isStandaloneDirectory: (cwd) => projects.isStandaloneDirectory(cwd),
      hasWorkspaceReferences: async (cwd: string) => {
        if (pi.cwd === cwd) return true
        if (pi.getRuntimeSessions().some((s) => s.cwd === cwd)) return true
        const snapshot = await sessions.getSnapshot(pi.getActiveSession(), settings.settings.pinnedPaths ?? [])
        if (snapshot.projects.some((group) => group.cwd === cwd && group.sessions.length > 0)) return true
        if (snapshot.standaloneSessions?.some((s) => s.cwd === cwd)) return true
        return false
      },
    })
    await sessionCleanup.recoverPending()
    let pluginsRestored = false
    const refreshPluginThemes = async () => {
      const themes = await loadPluginThemes(
        plugins.resourcePackages(),
        (pkg, relative) =>
          `/api/plugins/${instanceId}/${encodeURIComponent(pkg.id)}/${pkg.generation}/${relative.split('/').map(encodeURIComponent).join('/')}`,
      )
      await settings.setPluginThemes(themes)
      if (!closing) emit('plugins-changed')
    }
    plugins = new PluginManager({
      hostApi: appControl.api,
      hostApiForPlugin: (id) => {
        const api = appControl!.apiFor(`plugin:${id}`)
        return {
          ...api,
          terminal: {
            ...api.terminal,
            open: (ref, input, opts) =>
              appControl!.store.mutate(`plugin:${id}`, opts.idempotencyKey, 'terminal.open', [ref, input], () =>
                terminal.openOwned(ref, input, id),
              ),
          },
        }
      },
      disposePluginHost: (id) => terminal.closeOwner(id),
      validateResources: async (pkg) => {
        await loadPluginThemes([pkg], () => '')
      },
      directory: storagePaths.pluginPackagesDirectory,
      dataDirectory: storagePaths.pluginDataDirectory,
      stateFile: storagePaths.pluginsFile,
      reservedHandlers: [...Object.keys(builtins.handlers), ...Object.keys(handlers)],
      revoke: async (ids) => {
        for (const call of pluginCalls.values()) if (ids.includes(call.pluginId)) call.controller.abort()
        const keys = [...workerPluginIds]
          .filter(([, retained]) => ids.some((id) => retained.has(id)))
          .map(([key]) => key)
        await Promise.all(
          keys.map(async (key) => {
            await workerPluginBridges.get(key)?.close(undefined, true)
            await workers.get(key)?.stopAndWait()
          }),
        )
      },
      drain: async (ids) =>
        retireWorkers(
          [...workerPluginIds]
            .filter(([, retained]) => [...retained].some((id) => ids.includes(id)))
            .map(([key]) => key),
        ),
      onChange: () => {
        emit('plugins-changed')
        if (pluginsRestored && !closing)
          void refreshPluginThemes().catch((cause) =>
            emit('error', { generation: 0, message: `刷新插件主题失败：${String(cause)}` }),
          )
        if (builtins && !closing)
          void resources
            .refresh()
            .catch((cause: unknown) => emit('error', { generation: 0, message: `刷新插件资源失败：${String(cause)}` }))
        for (const [key, previous] of workerPlugins) {
          const selected = agentSelections.get(key) ?? settings.settings.defaultAgentPlugins ?? []
          const agents = plugins
            .list()
            .filter(
              (entry) => selected.includes(entry.id) && entry.agent && entry.enabled && entry.status !== 'pending',
            )
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
            void retireWorkers([key]).catch((cause: unknown) =>
              emit('error', { generation: 0, sessionKey: key, message: String(cause) }),
            )
          }
        }
      },
    })
    await plugins.restore()
    pluginsRestored = true
    await schedules.start(appControl.apiFor('host-schedules'), (taskId) =>
      appControl!.publish({ type: 'schedule', value: { taskId } }),
    )
    await refreshPluginThemes()
    const registry = new RequestRegistry(hostId, storagePaths.requestsFile)
    const client = async (clientId: string) => {
      let view = views.get(clientId)
      if (!view) {
        view = pi.createClientView()
        view.clientId = clientId
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
    let disposal: Promise<void> | undefined
    const inflight = new Set<Promise<unknown>>()
    const goalStates = new Map(goals.list().map((goal) => [goal.goalId, goal.status]))
    const unsubscribeGoals = goals.subscribe((ref, goal, goalId) => {
      const previousStatus = goalStates.get(goalId)
      if (goal) goalStates.set(goalId, goal.status)
      else goalStates.delete(goalId)
      const key = appControl?.goalRuntimeKey(ref)
      if (!key) return
      pi.retainGoalSession(key, goal?.status === 'active')
      pi.publishSessionEvent(key, {
        generation: 0,
        event: goal ? { type: 'goal_updated', goal } : { type: 'goal_cleared', goalId },
      })
      if (previousStatus === 'active' && goal && ['usage_limited', 'paused', 'blocked'].includes(goal.status)) {
        const stamp = pi.goalStopStamp(key)
        setTimeout(() => {
          if (
            closing ||
            goals.get(ref)?.goalId !== goalId ||
            goals.get(ref)?.status === 'active' ||
            pi.goalStopStamp(key) !== stamp
          )
            return
          void pi
            .abort(key)
            .catch((cause: unknown) => emit('error', { generation: 0, sessionKey: key, message: String(cause) }))
        }, 0)
      }
    })
    return {
      hostId,
      instanceId,
      root,
      cleanupReport,
      prepareMaintenance() {
        if (closing || inflight.size || checkoutGates.size || temporarySessions.size)
          throw new Error('Host 仍有操作正在执行或有打开的临时会话，请先关闭临时会话后再维护存储')
        pi.assertMaintenanceIdle()
        resources.assertIdle()
        collaboration.assertCheckoutIdle(() => true)
        terminal.assertIdle()
        activityBridge.assertIdle()
        plugins.assertIdle()
        appControl!.prepareMaintenance()
        schedules.prepareMaintenance()
        closing = true
      },
      app: appControl.api,
      control: appControl,
      settings,
      pi,
      credentials,
      connections: new ConnectionCredentialStore(
        credentials,
        () => (credentials as SecureCredentialStorage & { flush?: () => Promise<void> }).flush?.() ?? Promise.resolve(),
      ),
      flushCredentials: () =>
        (credentials as SecureCredentialStorage & { flush?: () => Promise<void> }).flush?.() ?? Promise.resolve(),
      async uploadAttachment(
        metadata: { clientId: string; hostId: string; sessionKey: string; name: string },
        body: import('node:stream').Readable,
        signal?: AbortSignal,
      ) {
        if (closing) throw new Error('Host 正在退出，操作未接纳')
        if (!metadata.clientId || metadata.clientId.length > 128) throw new Error('客户端标识无效')
        if (metadata.hostId !== hostId) throw new Error('Host 身份不匹配')
        if (!metadata.sessionKey) throw new Error('会话 ID 参数无效')
        if (metadata.sessionKey) {
          checkSessionAuthorization(metadata.sessionKey, metadata.clientId)
        }
        const tempInfo = temporarySessions.get(metadata.clientId)
        const tempPaths =
          temporaryPathsBySessionKey.get(metadata.sessionKey) ||
          (tempInfo && tempInfo.sessionKey === metadata.sessionKey ? tempInfo.runtimePaths : undefined)
        const isTemporary = Boolean(tempPaths || (tempInfo && tempInfo.sessionKey === metadata.sessionKey))
        const destination = tempPaths
          ? path.join(tempPaths.temporaryRoot ?? path.dirname(tempPaths.sessionsDirectory), 'attachments')
          : isTemporary
            ? path.join(tempInfo!.temporaryRoot, 'attachments')
            : undefined
        const clientId = metadata.clientId
        clientRequests.set(clientId, (clientRequests.get(clientId) ?? 0) + 1)
        const abortController = new AbortController()
        const activeSignal = signal ? AbortSignal.any([signal, abortController.signal]) : abortController.signal
        let uploadSet: Set<Promise<unknown>> | undefined
        let controllerSet: Set<AbortController> | undefined
        if (isTemporary) {
          uploadSet = temporaryUploads.get(metadata.sessionKey)
          if (!uploadSet) {
            uploadSet = new Set()
            temporaryUploads.set(metadata.sessionKey, uploadSet)
          }
          controllerSet = temporaryUploadControllers.get(metadata.sessionKey)
          if (!controllerSet) {
            controllerSet = new Set()
            temporaryUploadControllers.set(metadata.sessionKey, controllerSet)
          }
          controllerSet.add(abortController)
        }
        const pending = (async () => {
          await client(clientId)
          if (closing) throw new Error('Host 正在退出，操作未执行')
          pi.getSessionContext(metadata.sessionKey)
          return storeChatAttachment(
            root,
            metadata.name,
            body,
            activeSignal,
            destination ? { destinationDirectory: destination } : undefined,
          )
        })()
        if (uploadSet) uploadSet.add(pending)
        inflight.add(pending)
        try {
          return await pending
        } finally {
          inflight.delete(pending)
          if (uploadSet) uploadSet.delete(pending)
          if (controllerSet) controllerSet.delete(abortController)
          const count = (clientRequests.get(clientId) ?? 1) - 1
          if (count) clientRequests.set(clientId, count)
          else clientRequests.delete(clientId)
          if (!closing) scheduleClientRelease(clientId)
        }
      },
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
            const deletion = request.method === 'session:delete' || request.method === 'project:remove'
            const deletionEpoch = selectionEpochs.get(request.clientId) ?? 0
            const epoch = selections.has(request.method) ? (selectionEpochs.get(request.clientId) ?? 0) + 1 : undefined
            if (epoch !== undefined) selectionEpochs.set(request.clientId, epoch)
            if (request.method === 'pi:extension-ui-response' && request.sessionId?.startsWith('agent:')) {
              const [key, id, response] = request.args
              if (key !== request.sessionId || typeof id !== 'string' || !response || typeof response !== 'object')
                throw new Error('子 Agent 交互响应参数无效')
              checkSessionAuthorization(request.sessionId, request.clientId)
              validateExtensionUIResponse(response)
              return collaboration.respondExtensionUI(key as string, id, response)
            }
            if (request.method === 'pi:agent-snapshot' || request.method === 'pi:interrupt-agent') {
              if (typeof request.args[0] === 'string') {
                checkSessionAuthorization(request.args[0], request.clientId)
              }
            }
            if (request.method === 'pi:agents') {
              if (typeof request.args[0] === 'string') {
                checkSessionAuthorization(request.args[0], request.clientId)
              }
            }
            const view = await client(request.clientId)
            if (closing) throw new Error('Host 正在退出，操作未执行')
            const action =
              handlers[request.method] ?? builtins!.handlers[request.method] ?? plugins.handlers()[request.method]
            if (!action) throw new Error(`Host 方法不存在：${request.method}`)
            if (sessionWrites.has(request.method) && (!request.sessionId || request.args[0] !== request.sessionId))
              throw new Error('会话写操作必须携带匹配的 sessionId')
            if (epoch !== undefined && selectionEpochs.get(request.clientId) !== epoch) {
              if (request.method === 'git:create-worktree') throw new Error('工作环境选择已变化，Worktree 未创建')
              return { cancelled: true }
            }
            if (request.sessionId) {
              const isClosingAllowed = request.method === 'temporary-session:close'
              checkSessionAuthorization(request.sessionId, request.clientId, isClosingAllowed)
            }
            const tempInfo = temporarySessions.get(request.clientId)
            const isTempTarget = Boolean(tempInfo && request.sessionId === tempInfo.sessionKey)
            const selected = isTempTarget
              ? tempInfo!.view
              : { ...view, sessionKey: request.sessionId ?? view.sessionKey }
            const previousKey = selected.sessionKey
            const run = () =>
              pi.withClientView(selected, async () => {
                if (epoch !== undefined) await pi.releaseQueueEdits(request.clientId)
                const key = selected.sessionKey
                const sends = ['pi:prompt', 'pi:steer', 'pi:follow-up']
                const command =
                  sends.includes(request.method) && typeof request.args[1] === 'string'
                    ? parseGoalCommand(request.args[1])
                    : undefined
                let result: unknown
                if (request.method.startsWith('goal:') && key) {
                  const ref = await appControl!.sessionForRuntime(key)
                  const method = request.method.slice(5) as 'start' | 'edit' | 'pause' | 'resume' | 'clear'
                  const operation = appControl!.apiFor(request.clientId).goals[method] as (
                    ref: import('@pi-meme/contracts/app-host').SessionRef,
                    input: unknown,
                    options: { idempotencyKey: string },
                  ) => Promise<unknown>
                  result = await operation(ref, request.args[1], { idempotencyKey: request.requestId })
                } else if (command && key) {
                  const ref = await appControl!.sessionForRuntime(key)
                  if (command.action === 'start')
                    result = await appControl!.apiFor(request.clientId).goals.start(
                      ref,
                      {
                        objective: command.objective,
                        images: request.args[2] as import('@pi-meme/contracts/pi').PiImage[] | undefined,
                        skills: request.args[3] as import('@pi-meme/contracts/skills').SkillReference[] | undefined,
                      },
                      { idempotencyKey: request.requestId },
                    )
                  else if (command.action !== 'open') {
                    const goal = goals.get(ref)
                    if (!goal) throw new Error('当前会话没有目标')
                    const method = command.action === 'edit' ? 'pause' : command.action
                    result = await appControl!
                      .apiFor(request.clientId)
                      .goals[method](ref, goal, { idempotencyKey: request.requestId })
                  }
                } else {
                  if (
                    key &&
                    (['pi:edit-and-prompt', 'pi:fork-reply'].includes(request.method) ||
                      (sends.includes(request.method) &&
                        typeof request.args[1] === 'string' &&
                        normalizePlanMessage(
                          request.args[1],
                          (request.args[4] as { mode?: 'default' | 'plan' } | undefined)?.mode ?? 'default',
                        ).mode === 'plan'))
                  ) {
                    const ref = await appControl!.sessionForRuntime(key)
                    const goal = goals.get(ref)
                    if (goal?.status === 'active') {
                      const clientApi = appControl!.apiFor(request.clientId)
                      await clientApi.goals.pause(ref, goal, { idempotencyKey: randomUUID() })
                    }
                  }
                  if (request.method === 'pi:access-mode' && key) {
                    const ref = await appControl!.sessionForRuntime(key)
                    appControl!.assertActivityAccess(ref, request.args[1])
                  }
                  if (request.method === 'pi:recover' && key) {
                    const goal = await appControl!.goalForRuntime(key)
                    if (goal && goal.status !== 'complete') throw new Error('当前会话有未结束的目标，请使用目标恢复')
                  }
                  result = await pluginClient.run(request.clientId, () => action(...request.args))
                }
                if (deletion) {
                  const outcome = result as WorkspaceDeletionResult
                  if (outcome.selection && !outcome.selection.cancelled) {
                    if (
                      (selectionEpochs.get(request.clientId) ?? 0) === deletionEpoch &&
                      view.sessionKey === previousKey
                    ) {
                      Object.assign(view, selected)
                      emit('connection', pi.connection())
                      outcome.selection.snapshot = await enrichSnapshot(outcome.selection.snapshot)
                    } else outcome.selection = { cancelled: true }
                  }
                }
                const gitSelection =
                  request.method === 'git:switch-branch' ||
                  request.method === 'git:create-branch' ||
                  request.method === 'git:create-worktree'
                if (epoch !== undefined && !gitSelection) {
                  if (selectionEpochs.get(request.clientId) !== epoch) return { cancelled: true }
                  if (!isTempTarget) {
                    Object.assign(view, selected)
                    emit('connection', pi.connection())
                  }
                }
                if (selected.sessionKey === view.sessionKey) view.defaults = selected.defaults
                else if (isTempTarget) tempInfo!.view.defaults = selected.defaults
                if (
                  isTempTarget &&
                  (request.method === 'pi:set-model' ||
                    request.method === 'pi:set-thinking-level' ||
                    request.method === 'pi:session-mode')
                ) {
                  emit(
                    'connection',
                    pi.withSession(tempInfo!.sessionKey, () => pi.connection()),
                  )
                }
                try {
                  if (
                    result &&
                    typeof result === 'object' &&
                    'snapshot' in result &&
                    'cancelled' in result &&
                    !result.cancelled
                  )
                    result = {
                      ...result,
                      snapshot: await enrichSnapshot(result.snapshot as Snapshot),
                    }
                  if (request.method === 'git:create-worktree') {
                    const outcome = result as { selection: import('@pi-meme/contracts/desktop').SessionSelectionResult }
                    if (!outcome.selection.cancelled)
                      outcome.selection.snapshot = await enrichSnapshot(outcome.selection.snapshot)
                  }
                  await (credentials as SecureCredentialStorage & { flush?: () => Promise<void> }).flush?.()
                } catch (cause) {
                  if (request.method !== 'git:create-worktree') throw cause
                  return {
                    ...(result as object),
                    selection: { cancelled: true },
                    selectionError: `Worktree 已创建，但会话初始化失败，目录与来源记录已保留：${String(cause)}`,
                  }
                }
                if (epoch !== undefined && gitSelection) {
                  if (selectionEpochs.get(request.clientId) !== epoch)
                    return request.method === 'git:create-worktree'
                      ? { ...(result as object), selection: { cancelled: true } }
                      : { cancelled: true }
                  Object.assign(view, selected)
                  emit('connection', pi.connection())
                }
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
      dispose() {
        if (disposal) return disposal
        closing = true
        disposal = (async () => {
          for (const timer of clientTimers.values()) clearTimeout(timer)
          clientTimers.clear()
          for (const [cid, info] of [...temporarySessions.entries()]) {
            await closeAndDestroyTemporarySession(cid, info)
          }
          await schedules.beginShutdown()
          await appControl!.beginShutdown()
          await collaboration.stopAndWait()
          await pi.stopAndWait()
          await Promise.allSettled(inflight)
          await activities.dispose()
          await appControl!.dispose()
          unsubscribeGoals()
          await terminal.dispose()
          await plugins.dispose()
          await builtins!.dispose()
          await resources.waitForIdle()
          try {
            await (credentials as SecureCredentialStorage & { flush?: () => Promise<void> }).flush?.()
          } finally {
            listeners.clear()
            views.clear()
            await unlock()
          }
        })()
        return disposal
      },
    }
  } catch (cause) {
    await cleanup?.()
    await unlock()
    throw cause
  }
}
export type HostService = Awaited<ReturnType<typeof createHost>>
