import type { AgentConversationOrigin, AgentMailboxMessage } from '@pi-meme/contracts/collaboration'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { SecureCredentialStorage } from '@pi-meme/contracts/secure-storage'
import type {
  AgentSession,
  AgentSessionRuntime,
  CreateAgentSessionRuntimeFactory,
  InlineExtension,
  ExtensionAPI,
  RpcSessionState,
  SessionEntry,
} from '@earendil-works/pi-coding-agent'
import type { AgentAccessMode } from '@pi-meme/contracts/agent-access'
import { builtinCommand } from '@pi-meme/contracts/pi'
import { normalizePlanMessage, type MessageOptions, type QueuedInput, type TaskMode } from '@pi-meme/contracts/plan'
import { randomUUID } from 'node:crypto'
import { createPlanGuard } from '../extensions/plan-mode'
import type { ToolExecutionSettings } from '@pi-meme/contracts/settings'
import type { SkillReference } from '@pi-meme/contracts/skills'
import type { ResourceSnapshot } from '@pi-meme/contracts/resources'
import type { Connection, DesktopError, DesktopEvent, Snapshot } from '@pi-meme/contracts/desktop'
import type {
  PiEvent,
  PiExtensionUIResponse,
  PiImage,
  PiModel,
  PiPauseInterval,
  PiRunInterval,
  PiRetryState,
  PiSlashCommand,
  PiState,
  ThinkingLevel,
} from '@pi-meme/contracts/pi'
import { projectAgentConversation } from '../agent-conversation'
import { projectBranchEntries } from '../session-tree-entries'
import { createAgentAccessExtension } from '../extensions/agent-access'
import { expandSkills } from '../skill-prompt'
import { toResourceSkillCommand } from '../skill-command'
import { branchSkillUsages, createSkillUsageExtension, skillUsageEntry } from '../extensions/skill-usage'
import type { PiRuntimePaths } from '../runtime-paths'
import type { ModelRestore } from '../runtime'
import { AccessSandbox, type AccessSandboxOperations } from './access-sandbox'
import {
  composerHintFromAssistant,
  composerHintSystemPrompt,
  summarizeTurn,
  type HintSourceMessage,
} from './composer-hint'
import { toDesktopEvent } from './events'
import { loadPiSdk, type PiSdk } from './load'
import { createDesktopModelRuntime } from './model-runtime'
import { createDesktopSettingsManager } from './settings'
import { readDesktopAgentContextFiles } from './context-files'
import { ExtensionUiBridge } from './ui-bridge'
import { freezeResourceLoader, snapshotSkills } from './resource-loader'
import { eventUiSource, persistMessageSource, projectMessageSources } from './ui-source'

type Notify = {
  connection: (value: Connection) => void
  event: (value: DesktopEvent) => void
  error: (value: DesktopError) => void
  title?: (value: string) => void
}

type SessionModel = NonNullable<AgentSession['model']>

function isPathWithin(root: string, value: string) {
  const relative = path.relative(path.resolve(root), path.resolve(value))
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

async function assertDesktopSessionPath(sessionsDirectory: string, sessionPath: string) {
  const root = await realpath(sessionsDirectory)
  const target = await realpath(sessionPath)
  if (!isPathWithin(root, target)) throw new Error('Desktop 只能打开应用内保存的会话')
}

function toModel(model: SessionModel | undefined): PiModel | undefined {
  return model ? { provider: model.provider, id: model.id, name: model.name, reasoning: model.reasoning } : undefined
}

/**
 * 会话级 Pi SDK 运行时：包装 `AgentSessionRuntime`，对上层暴露与旧 RPC 控制器一致的接口。
 *
 * 每个实例对应一个会话；会话替换（新会话、恢复、分叉）由 `AgentSessionRuntime` 处理，
 * 替换后通过 `setRebindSession` 重新订阅事件并绑定扩展。
 */
export type RuntimePolicy = {
  initialGeneration?: number
  onAdmission?: (message: string, mode: TaskMode, continuation: boolean, signal: AbortSignal) => Promise<void>
  uiEnabled?: boolean
  resourcePaths?: { skills: string[]; prompts: string[] }
  resourceSnapshot?: ResourceSnapshot
  agentSources?: Array<{ pluginId: string; generation: number; path: string }>
  requireRestrictedPolicy?: boolean
  createSandbox?: typeof AccessSandbox.create
  createAccessExtension?: typeof createAgentAccessExtension
}
export class SdkSession {
  private paused = false
  private queuePaused = false
  private pauseRevision = 0
  private pauseControlApplied = true
  private pauseIntervals: PiPauseInterval[] = []
  private runIntervals: PiRunInterval[] = []
  private pauseGate?: Promise<void>
  private releasePause?: () => void
  private frozenView?: { messages: Snapshot['messages']; entries: SessionEntry[]; leafId: string | null }
  private queueEdits = new Map<string, string>()
  private queueLock: Promise<void> = Promise.resolve()
  private draining = false
  private handingOff = 0
  private handoffs = new Map<string, { kind: 'steering' | 'followUp'; input: QueuedInput; cancelled?: boolean }>()
  private mode: TaskMode = 'default'
  private activeMode?: TaskMode
  private runtimeMode: TaskMode = 'default'
  private ownQueue: { steering: QueuedInput[]; followUp: QueuedInput[] } = { steering: [], followUp: [] }
  private nativeQueue: { steering: QueuedInput[]; followUp: QueuedInput[] } = { steering: [], followUp: [] }
  private queueCancelled = false
  private admission?: AbortController
  private pendingDeliveries = new Set<string>()
  private preparedQueueText = new Map<string, string>()
  private runtime: AgentSessionRuntime | null = null
  private sdk: PiSdk | null = null
  private status: Connection['status'] = 'disconnected'
  private generation = 0
  private startSeq = 0
  private running = false
  private retry?: PiRetryState
  private compactionError?: string
  private pendingSend = false
  private changing = false
  private preparationMode?: TaskMode
  private delegatedTask?: string
  private conversationOrigin?: AgentConversationOrigin
  private activityRevision = 0
  private lastError = ''
  private piVersion?: string
  private ready: Promise<void> = Promise.resolve()
  private stopping: Promise<void> = Promise.resolve()
  private unsubscribe: (() => void) | null = null
  private bridge: ExtensionUiBridge | null = null
  private sandbox: AccessSandboxOperations | null = null
  private accessTemporary: string | null = null
  private inlineExtensions: InlineExtension[] = []
  private capabilities: ToolExecutionSettings = { codemodeEnabled: false, mcpEnabled: false }
  private accessMode: AgentAccessMode = 'full-access'
  private cachedModels: PiModel[] | null = null
  private cachedCommands: PiSlashCommand[] | null = null
  private modelRestore: ModelRestore | undefined
  private modelSelectionRequired = false
  private composerHint?: string
  private hintController?: AbortController
  private sessionFile?: string
  private sessionId?: string
  cwd: string

  constructor(
    cwd: string,
    private readonly notify: Notify,
    private readonly paths: PiRuntimePaths,
    private readonly credentials: SecureCredentialStorage,
    private readonly createMcpExtension?: (sdk: PiSdk, cwd: string) => InlineExtension,
    private readonly policy: RuntimePolicy = {},
  ) {
    this.cwd = cwd
    this.generation = policy.initialGeneration ?? 0
  }

  async configureAgentTask(task: string, origin?: AgentConversationOrigin) {
    this.delegatedTask = task
    this.conversationOrigin = origin
  }

  configureInlineExtensions(extensions: InlineExtension[]) {
    this.inlineExtensions = extensions.slice()
  }

  configureResourceSnapshot(snapshot: ResourceSnapshot) {
    if (this.runtime) throw new Error('资源快照只能在创建或重建会话运行时前配置')
    this.policy.resourceSnapshot = structuredClone(snapshot)
    this.cachedCommands = null
  }

  getResourceSnapshot(): ResourceSnapshot | undefined {
    return this.policy.resourceSnapshot ? structuredClone(this.policy.resourceSnapshot) : undefined
  }

  private desktopMcpExtension(sdk: PiSdk, cwd: string) {
    if (!this.createMcpExtension) throw new Error('Desktop MCP 运行时未配置')
    return this.createMcpExtension(sdk, cwd)
  }

  configureCapabilities(value: ToolExecutionSettings) {
    this.capabilities = { ...value, codemodeEnabled: value.codemodeEnabled || value.mcpEnabled }
  }

  getTaskMode(): TaskMode {
    return this.activeMode ?? this.mode
  }

  configureAccess(mode: AgentAccessMode) {
    this.accessMode = mode
  }

  connection(): Connection {
    return {
      generation: this.generation,
      cwd: this.cwd,
      status: this.status,
      error: this.lastError || undefined,
      piVersion: this.piVersion,
    }
  }

  private report(message: string) {
    this.lastError = message
    this.notify.error({ generation: this.generation, message })
  }

  private get session(): AgentSession {
    if (!this.runtime || this.status !== 'ready') throw new Error('Pi 尚未就绪')
    return this.runtime.session
  }

  start(cwd: string, sessionFile?: string, preparing = false, preservePause = false) {
    this.modelSelectionRequired = false
    const admission = this.admission
    if (preparing) this.admission = undefined
    const pause = preservePause
      ? {
          paused: this.paused,
          queuePaused: this.queuePaused,
          frozenView: this.frozenView,
          pauseIntervals: structuredClone(this.pauseIntervals),
        }
      : undefined
    this.stop(preservePause)
    if (!preservePause) this.pauseControlApplied = false
    if (!pause && (!sessionFile || cwd !== this.cwd || sessionFile !== this.sessionFile)) {
      this.pauseIntervals = []
      this.runIntervals = []
    }
    if (pause) {
      this.pauseIntervals = pause.pauseIntervals
      this.queuePaused = pause.queuePaused
      this.frozenView = pause.frozenView
      if (pause.paused) {
        this.paused = true
        this.pauseGate = new Promise<void>((resolve) => {
          this.releasePause = resolve
        })
      }
    }
    if (preparing) {
      this.admission = admission
      this.queueCancelled = false
    }
    this.cwd = cwd
    this.cachedModels = null
    this.cachedCommands = null
    this.sessionFile = sessionFile
    this.sessionId = undefined
    const generation = this.generation
    const seq = ++this.startSeq
    this.lastError = ''
    this.running = false
    this.status = 'connecting'
    this.notify.connection(this.connection())
    this.ready = (async () => {
      await this.stopping
      if (generation !== this.generation || seq !== this.startSeq) return
      await this.createRuntime(sessionFile, seq)
      if (generation !== this.generation || seq !== this.startSeq) return
      this.status = 'ready'
      this.sessionFile = this.runtime?.session.sessionFile ?? sessionFile
      this.sessionId = this.runtime?.session.sessionId
      this.notify.connection(this.connection())
    })().catch((cause: unknown) => {
      if (generation === this.generation) {
        this.report(`无法启动 Pi：${String(cause)}`)
        this.teardownRuntime()
        this.status = 'disconnected'
        this.running = false
        this.notify.connection(this.connection())
        this.ready = Promise.resolve()
      }
      throw new Error(`无法启动 Pi：${String(cause)}`)
    })
    void this.ready.catch(() => {})
  }

  /** 重建会话对象并恢复 sessionFile、模型与思考等级；不重启进程。 */
  async reconnectModels(restore?: ModelRestore) {
    restore ??= await this.captureRestoreState()
    this.modelRestore = restore
    const generation = this.generation
    this.start(this.cwd, restore?.sessionFile, this.preparationMode !== undefined, true)
    try {
      await this.ready
      const models = await this.getAvailableModels()
      const selected = restore?.model
      this.modelSelectionRequired = Boolean(selected)
      if (selected && models.some((model) => model.provider === selected.provider && model.id === selected.id)) {
        if (this.preparationMode !== undefined) {
          const restored = this.session.modelRuntime
            .getAvailableSnapshot()
            .find((model) => model.provider === selected.provider && model.id === selected.id)
          if (restored) await this.session.setModel(restored)
        } else await this.setModel(selected)
        this.modelSelectionRequired = false
        if (restore?.thinkingLevel) this.session.setThinkingLevel(restore.thinkingLevel)
      } else if (selected) {
        this.report('当前模型已不可用，请在聊天中重新选择模型')
      }
      if (generation === this.generation) this.cachedModels = models
    } finally {
      if (this.status === 'ready') this.notify.connection(this.connection())
    }
  }

  private async createRuntime(sessionFile: string | undefined, seq: number) {
    const generation = this.generation
    const runtimeMode = this.preparationMode ?? this.mode
    const plan = runtimeMode === 'plan'
    this.runtimeMode = runtimeMode
    const sdk = (this.sdk ??= await loadPiSdk())
    this.piVersion = sdk.VERSION
    if (this.accessMode !== 'full-access') {
      if (this.policy.requireRestrictedPolicy && (!this.policy.createSandbox || !this.policy.createAccessExtension))
        throw new Error('受限权限插件或沙箱不可用，执行已拒绝')
      this.accessTemporary = await mkdtemp(path.join(tmpdir(), 'pi-desktop-access-'))
      try {
        this.sandbox = await (this.policy.createSandbox ?? AccessSandbox.create)({
          mode: this.accessMode,
          cwd: this.cwd,
          temporary: this.accessTemporary,
          agentDir: this.paths.agentDir,
          dataRoot: this.paths.dataRoot,
        })
      } catch (cause) {
        await this.discardAccessTemporary()
        throw new Error(`受限权限无法启用：${String(cause)}`)
      }
    }
    const sessionDirectory = this.paths.sessionDirectory(this.cwd)
    const sessionManager = sessionFile
      ? sdk.SessionManager.open(sessionFile, sessionDirectory, this.cwd)
      : sdk.SessionManager.create(this.cwd, sessionDirectory)
    const agentDir = this.paths.agentDir
    const restricted = this.accessMode !== 'full-access'
    let extensionErrors: Array<{ path: string; error: string }> = []
    const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager }) => {
      const extensionFactories = [
        (pi: ExtensionAPI) => {
          const gate = () => this.waitForResume()
          pi.on('message_start', gate)
          pi.on('message_update', gate)
          pi.on('message_end', gate)
          pi.on('turn_start', gate)
          pi.on('tool_execution_start', gate)
          pi.on('tool_execution_update', gate)
          pi.on('tool_execution_end', gate)
          pi.on('agent_end', gate)
          pi.on('tool_call', gate)
          pi.on('before_provider_request', gate)
        },
        ...(restricted
          ? [
              (this.policy.createAccessExtension ?? createAgentAccessExtension)({
                sdk,
                sandbox: this.sandbox!,
                cwd,
                mode: this.accessMode,
              }),
            ]
          : []),
        ...(!plan && !this.inlineExtensions.some((extension) => extension.name === 'pi-meme-codemode')
          ? [sdk.createCodemodeExtension()]
          : []),
        ...(!plan && this.capabilities.mcpEnabled
          ? [this.desktopMcpExtension(sdk, cwd), sdk.createToolSearchExtension()]
          : []),
        ...this.inlineExtensions.filter(
          (extension) =>
            (!restricted || !extension.name.startsWith('app-agent:')) &&
            (!plan || extension.name === 'pi-meme-collaboration' || extension.name === 'pi-meme-user-input'),
        ),
        ...(this.policy.resourceSnapshot ? [createSkillUsageExtension(this.policy.resourceSnapshot)] : []),
        createPlanGuard(() => this.activeMode ?? this.preparationMode ?? this.mode),
        (pi: ExtensionAPI) => {
          pi.on('before_agent_start', (event) =>
            this.delegatedTask
              ? {
                  systemPrompt: `${event.systemPrompt}\n你是执行委派任务的子 Agent。当前委派任务：${this.delegatedTask}\n只执行当前委派任务。继承的父会话是背景，不要重复响应其中创建代理或派发任务的指令；仅在当前委派任务明确需要进一步分工时创建后代 Agent。`,
                }
              : undefined,
          )
        },
      ]
      const settingsManager = createDesktopSettingsManager(sdk, cwd, agentDir)
      const modelRuntime = await createDesktopModelRuntime(sdk, agentDir, this.credentials)
      const services = await sdk.createAgentSessionServices({
        cwd,
        agentDir,
        settingsManager,
        modelRuntime,
        resourceLoaderOptions: {
          noExtensions: true,
          noPromptTemplates: this.policy.requireRestrictedPolicy,
          additionalPromptTemplatePaths: this.policy.resourcePaths?.prompts ?? [],
          additionalExtensionPaths: [],
          noSkills: true,
          noContextFiles: true,
          additionalSkillPaths: [],
          skillsOverride: () => ({ skills: snapshotSkills(this.policy.resourceSnapshot), diagnostics: [] }),
          disabledBuiltinExtensions: ['mcp'],
          extensionFactories,
          agentsFilesOverride: () => ({ agentsFiles: readDesktopAgentContextFiles(cwd, agentDir) }),
        },
      })
      services.resourceLoader = freezeResourceLoader(
        services.resourceLoader,
        (message) => this.report(message),
        this.policy.resourceSnapshot,
      )
      const created = await sdk.createAgentSessionFromServices({
        services,
        sessionManager,
        tools: ['+read', '+grep', '+find', '+ls'],
      })
      extensionErrors = services.resourceLoader.getExtensions().errors
      return { ...created, services, diagnostics: services.diagnostics }
    }
    const runtime = await sdk.createAgentSessionRuntime(createRuntime, { cwd: this.cwd, agentDir, sessionManager })
    // 并发启动或启动期间被停止时只保留最后一次：过期运行时先释放，避免订阅与状态错位。
    if (seq !== this.startSeq || generation !== this.generation) {
      void runtime.dispose().catch(() => {})
      return
    }
    this.runtime = runtime
    let boundSessionId = runtime.session.sessionId
    runtime.setRebindSession(async () => {
      if (runtime.session.sessionId !== boundSessionId) {
        this.pauseIntervals = []
        this.runIntervals = []
        boundSessionId = runtime.session.sessionId
        this.emitPause()
      }
      await this.bindSession()
    })
    await this.bindSession()
    const errors = runtime.diagnostics.filter((entry) => entry.type === 'error')
    if (errors.length) this.report(`Pi 运行时诊断：${errors.map((entry) => entry.message).join('；')}`)
    if (extensionErrors.length)
      this.report(`Pi 扩展加载失败：${extensionErrors.map((entry) => `${entry.path}：${entry.error}`).join('；')}`)
  }

  /** 绑定扩展与事件订阅；会话被替换后会再次调用。 */
  private async bindSession() {
    const runtime = this.runtime
    if (!runtime) return
    const generation = this.generation
    const session = runtime.session
    this.bridge?.clear()
    this.bridge = new ExtensionUiBridge((event) => {
      if (generation !== this.generation) return
      if (event.type === 'extension_ui_request' && event.method === 'setTitle') this.notify.title?.(event.title)
      this.notify.event({ generation: this.generation, event: structuredClone(event) })
    })
    await session.bindExtensions({
      uiContext: !this.policy.requireRestrictedPolicy || this.policy.uiEnabled ? this.bridge.ui : undefined,
      mode: 'rpc',
      commandContextActions: {
        waitForIdle: () => session.waitForIdle(),
        newSession: (options) => runtime.newSession(options),
        fork: async (entryId, forkOptions) => {
          const result = await runtime.fork(entryId, forkOptions)
          return { cancelled: result.cancelled }
        },
        navigateTree: async (targetId, options) => {
          const result = await session.navigateTree(targetId, {
            summarize: options?.summarize,
            customInstructions: options?.customInstructions,
            replaceInstructions: options?.replaceInstructions,
            label: options?.label,
          })
          return { cancelled: result.cancelled }
        },
        switchSession: async (sessionPath, options) => {
          await assertDesktopSessionPath(this.paths.sessionsDirectory, sessionPath)
          return runtime.switchSession(sessionPath, options)
        },
        reload: async () => {
          await session.reload()
        },
      },
      onError: (error) => {
        if (generation !== this.generation) return
        this.notify.error({
          generation: this.generation,
          message: `Pi 扩展异常：${error.extensionPath}\n事件：${error.event}\n${error.error}`,
          extension: { path: error.extensionPath, event: error.event },
        })
      },
    })
    // 绑定期间会话被替换时放弃后续步骤，避免订阅挂到旧运行时。
    if (this.runtime !== runtime || generation !== this.generation) return
    if (this.runtimeMode !== 'plan' && !session.getActiveToolNames().includes('codemode')) {
      if (!session.getAllTools().some((tool) => tool.name === 'codemode')) throw new Error('codemode 内置扩展未加载')
      session.setActiveToolsByName([...new Set([...session.getActiveToolNames(), 'codemode'])])
    }
    this.unsubscribe?.()
    this.unsubscribe = session.subscribe((event) => {
      if (generation !== this.generation) return
      if (
        event.type === 'entry_appended' &&
        event.entry.type === 'custom' &&
        event.entry.customType === skillUsageEntry
      )
        this.notify.event({
          generation: this.generation,
          event: { type: 'skill_usage_update', usages: this.getSkillUsages() },
        })
      const desktopEvent = toDesktopEvent(event)
      if (event.type === 'queue_update') {
        for (const key of ['steering', 'followUp'] as const) {
          const source = this.nativeQueue[key].slice()
          this.nativeQueue[key] = event[key].map((text) => {
            const index = source.findIndex(
              (input) => input.text === text || this.preparedQueueText.get(input.id) === text,
            )
            if (index < 0 && source.length) return source.shift()!
            return index < 0 ? { id: randomUUID(), text, mode: 'default' } : source.splice(index, 1)[0]!
          })
        }
        this.emitQueue()
      } else if (desktopEvent) {
        const source = eventUiSource(desktopEvent, session, this.policy.agentSources)
        if (source) {
          queueMicrotask(() => {
            if (this.runtime === runtime && generation === this.generation)
              persistMessageSource(session, desktopEvent, source)
          })
          this.handleEvent({
            ...desktopEvent,
            source,
            ...('message' in desktopEvent
              ? {
                  message: {
                    ...desktopEvent.message,
                    source,
                    ...(desktopEvent.message.role === 'custom' && source.customType
                      ? { customType: source.customType }
                      : {}),
                  },
                }
              : {}),
          } as PiEvent)
        } else this.handleEvent(desktopEvent)
      }
    })
  }

  private handleEvent(event: PiEvent, forceSettled = false) {
    if (event.type === 'auto_retry_start' || event.type === 'summarization_retry_scheduled') {
      this.retry = {
        kind: event.type === 'auto_retry_start' ? 'model' : 'summary',
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        errorMessage: event.errorMessage,
      }
      this.running = true
      this.activityRevision += 1
    }
    if (
      (event.type === 'auto_retry_end' && this.retry?.kind === 'model') ||
      (event.type === 'summarization_retry_finished' && this.retry?.kind === 'summary')
    ) {
      this.retry = undefined
      this.activityRevision += 1
    }
    if (event.type === 'compaction_end') {
      this.compactionError = event.aborted ? undefined : event.errorMessage
      if (this.retry?.kind === 'summary') this.retry = undefined
    }
    if (event.type === 'message_end' && event.message.role === 'assistant')
      event = { ...event, message: { ...event.message, completedAt: Date.now() } }
    if (event.type === 'agent_start' || event.type === 'compaction_start') {
      if (event.type === 'agent_start') this.cancelComposerHint()
      this.compactionError = undefined
      this.pendingSend = false
      this.activityRevision += 1
      this.running = true
      const interval = this.runIntervals.at(-1)
      if (event.type === 'agent_start' && (!interval || interval.endedAt !== undefined))
        this.runIntervals.push({ startedAt: Date.now() })
      if (event.type === 'agent_start') event = { ...event, runIntervals: structuredClone(this.runIntervals) }
    }
    if (event.type === 'agent_settled') {
      const aborted = Boolean(event.aborted)
      this.retry = undefined
      this.pendingSend = false
      if (!this.running && !forceSettled) return
      this.running = false
      const interval = this.runIntervals.at(-1)
      if (interval && interval.endedAt === undefined) interval.endedAt = Date.now()
      const pause = this.pauseIntervals.at(-1)
      if (pause && pause.endedAt === undefined) {
        pause.endedAt = interval?.endedAt ?? Date.now()
        this.emitPause()
      }
      event = { ...event, runIntervals: structuredClone(this.runIntervals) }
      this.activityRevision += 1
      this.activeMode = undefined
      if (aborted) this.clearComposerHint()
      if (!this.queueCancelled)
        queueMicrotask(() => {
          void this.advanceQueue()
            .catch((cause: unknown) => this.report(String(cause)))
            .finally(() => {
              if (!forceSettled && !aborted) void this.refreshComposerHint()
            })
        })
    }
    if (
      event.type === 'message_end' &&
      event.message.role === 'custom' &&
      event.message.customType === 'pi-meme-collaboration'
    ) {
      const id = (event.message.details as { messageId?: string } | undefined)?.messageId
      if (id) this.pendingDeliveries.delete(id)
    }
    this.notify.event({ generation: this.generation, event })
  }

  private teardownRuntime() {
    this.retry = undefined
    this.compactionError = undefined
    this.pendingDeliveries.clear()
    this.unsubscribe?.()
    this.unsubscribe = null
    this.bridge?.clear()
    this.bridge = null
    const runtime = this.runtime
    this.runtime = null
    this.sandbox?.stopAll()
    this.sandbox = null
    void this.discardAccessTemporary()
    if (runtime) {
      this.stopping = Promise.all([this.stopping, runtime.dispose().catch(() => {})]).then(() => {})
    }
  }

  private async discardAccessTemporary() {
    const temporary = this.accessTemporary
    this.accessTemporary = null
    if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => {})
  }

  stop(preserveTiming = false) {
    this.cancelComposerHint()
    this.cancelPause(!preserveTiming)
    if (!preserveTiming) {
      const interval = this.runIntervals.at(-1)
      if (interval && interval.endedAt === undefined) interval.endedAt = Date.now()
      this.emitPause()
    }
    this.queueCancelled = true
    this.admission?.abort()
    this.generation += 1
    this.status = 'disconnected'
    this.running = false
    this.pendingSend = false
    this.modelSelectionRequired = false
    this.teardownRuntime()
  }

  async stopAndWait() {
    this.stop()
    await this.stopping
  }

  private async call<T>(operation: () => Promise<T> | T): Promise<T> {
    const generation = this.generation
    await this.ready
    if (generation !== this.generation || this.status !== 'ready') throw new Error('Pi 尚未连接')
    let result: T
    try {
      result = await operation()
    } catch (cause) {
      throw new Error(`Pi 操作失败：${String(cause)}`)
    }
    if (generation !== this.generation) throw new Error('Pi 连接已更换，请重新读取状态')
    return result
  }

  getState(): RpcSessionState {
    const session = this.session
    return {
      model: session.model,
      thinkingLevel: session.thinkingLevel,
      isStreaming: session.isStreaming,
      isCompacting: session.isCompacting,
      steeringMode: session.steeringMode,
      followUpMode: session.followUpMode,
      sessionFile: session.sessionFile,
      sessionId: session.sessionId,
      sessionName: session.sessionName,
      autoCompactionEnabled: session.autoCompactionEnabled,
      messageCount: session.messages.length,
      pendingMessageCount: session.pendingMessageCount,
    }
  }

  getEntries(): Promise<{ entries: SessionEntry[]; leafId: string | null }> {
    return this.call(() => {
      const manager = this.session.sessionManager
      return { entries: manager.getEntries(), leafId: manager.getLeafId() }
    })
  }

  getActiveSession() {
    return { sessionFile: this.runtime?.session.sessionFile ?? this.sessionFile, sessionId: this.sessionId }
  }

  async snapshot(): Promise<Snapshot> {
    const revision = this.activityRevision
    const generation = this.generation
    const [state, messages, entries, models, thinkingLevels, stats] = await this.call(() =>
      Promise.all([
        Promise.resolve(this.getState()),
        Promise.resolve(
          this.frozenView?.messages ?? this.session.messages.filter((message) => message.role !== 'system'),
        ),
        Promise.resolve({
          entries: this.frozenView?.entries ?? this.session.sessionManager.getEntries(),
          leafId: this.frozenView ? this.frozenView.leafId : this.session.sessionManager.getLeafId(),
        }),
        this.cachedModels
          ? Promise.resolve(this.cachedModels)
          : this.getAvailableModels().then((models) => {
              if (generation === this.generation) this.cachedModels = models
              return models
            }),
        Promise.resolve(this.session.getAvailableThinkingLevels()).catch(() => undefined),
        Promise.resolve(this.session.getSessionStats()).catch(() => undefined),
      ]),
    )
    if (generation !== this.generation) throw new Error('Pi 连接已更换')
    this.sessionFile = state.sessionFile
    this.sessionId = state.sessionId
    if (revision === this.activityRevision)
      this.running = this.pendingSend || state.isStreaming || Boolean(state.isCompacting) || Boolean(this.retry)
    const own = this.conversationOrigin
      ? projectAgentConversation(entries.entries, entries.leafId, this.conversationOrigin)
      : undefined
    return {
      connection: this.connection(),
      state: this.toState(
        revision === this.activityRevision
          ? state
          : { ...state, isStreaming: this.running, isCompacting: this.running && state.isCompacting },
      ),
      messages: projectMessageSources(entries.entries, own?.messages ?? messages, entries.leafId),
      models,
      thinkingLevels,
      stats,
      sessionEntries: own?.sessionEntries ?? { entries: projectBranchEntries(entries.entries), leafId: entries.leafId },
    }
  }

  private toState(state: RpcSessionState): PiState {
    return {
      model: this.modelSelectionRequired ? this.modelRestore?.model : toModel(state.model),
      modelSelectionRequired: this.modelSelectionRequired,
      thinkingLevel: state.thinkingLevel,
      isStreaming: state.isStreaming,
      isCompacting: state.isCompacting,
      sessionName: state.sessionName,
      steeringMode: state.steeringMode,
      followUpMode: state.followUpMode,
      pendingMessageCount: state.pendingMessageCount + this.ownQueue.steering.length + this.ownQueue.followUp.length,
      isPaused: this.paused,
      queuePaused: this.queuePaused,
      pauseRevision: this.pauseRevision,
      pauseIntervals: structuredClone(this.pauseIntervals),
      runIntervals: structuredClone(this.runIntervals),
      retry: this.retry ? { ...this.retry } : undefined,
      compactionError: this.compactionError,
      mode: this.mode,
      activeMode: this.activeMode,
      skillUsages: this.getSkillUsages(),
      composerHint: this.composerHint,
    }
  }

  private getSkillUsages() {
    return branchSkillUsages(this.session.sessionManager.getBranch(), this.conversationOrigin?.inheritedEntryIds)
  }

  private async getAvailableModels(): Promise<PiModel[]> {
    return this.call(() =>
      this.session.modelRuntime.getAvailableSnapshot().map((model) => ({
        provider: model.provider,
        id: model.id,
        name: model.name,
        reasoning: model.reasoning,
      })),
    )
  }

  async assertResourceIdle() {
    if (this.changing || this.draining || this.handingOff || this.pendingSend || this.pendingDeliveries.size)
      throw new Error('会话仍在准备排队输入或交付消息，请等待完成')
    await this.assertIdle()
  }

  async assertIdle(allowDisconnected = false) {
    if (this.running) throw new Error('Pi 正在运行，请先停止当前任务')
    if (!allowDisconnected || this.status === 'ready') {
      const state = this.getState()
      if (!this.session.isIdle || state.isStreaming || state.isCompacting || state.pendingMessageCount)
        throw new Error('Pi 正在运行，请先停止当前任务')
    }
  }

  async idle<T>(action: () => Promise<T>, allowDisconnected = false): Promise<T> {
    if (this.changing || this.running) throw new Error('Pi 正在运行或切换，请等待完成后重试')
    this.changing = true
    try {
      await this.assertIdle(allowDisconnected)
      return await action()
    } finally {
      this.changing = false
    }
  }

  async prompt(
    message: string,
    images?: PiImage[],
    skills: SkillReference[] = [],
    options?: MessageOptions,
    continuation = false,
    preserveMode = false,
  ) {
    const normalized = normalizePlanMessage(message, options?.mode ?? this.mode)
    if (!normalized.commandOnly && (this.changing || this.running))
      throw new Error('Pi 正在运行或切换，请等待完成后重试')
    if (normalized.commandOnly) {
      await this.setSessionMode(normalized.mode)
      return
    }
    message = normalized.text
    this.queueCancelled = false
    const command = builtinCommand(message)
    if (command && (images?.length || skills.length)) throw new Error('内置命令不能附带图片或技能，请移除后重试')
    if (command?.name === 'name' && !command.args) throw new Error('请输入会话名称：/name <会话名称>')
    if (this.modelSelectionRequired && command?.name !== 'name') throw new Error('当前模型已不可用，请先重新选择模型')
    if (this.changing || this.running) throw new Error('Pi 正在运行或切换，请等待完成后重试')
    this.changing = true
    this.preparationMode = normalized.mode
    if (!preserveMode && !continuation) this.mode = normalized.mode
    this.admission = new AbortController()
    try {
      if (this.runtime && this.runtimeMode !== normalized.mode) {
        const restore = await this.captureRestoreState()
        if (this.queueCancelled) throw new Error('消息发送已取消')
        await this.reconnectModels(restore)
      }
      const generation = this.generation
      const state = this.getState()
      if (state.isStreaming || state.isCompacting) {
        this.running = true
        throw new Error('Pi 正在运行，请先停止当前任务')
      }
      message = await this.prepareSkills(message, skills)
      this.running = true
      this.pendingSend = true
      this.activeMode = normalized.mode
      if (!command) await this.policy.onAdmission?.(message, normalized.mode, continuation, this.admission.signal)
      if (generation !== this.generation || this.queueCancelled) throw new Error('消息发送已取消')
      this.activityRevision += 1
    } catch (cause) {
      this.running = false
      this.pendingSend = false
      this.activeMode = undefined
      this.activityRevision += 1
      throw cause
    } finally {
      this.admission = undefined
      this.preparationMode = undefined
      this.changing = false
    }
    try {
      let handled = false
      if (command?.name === 'compact') await this.call(() => this.session.compact(command.args))
      else if (command?.name === 'name') await this.call(() => this.session.setSessionName(command.args!))
      else handled = (await this.sendPrompt(message, images, continuation)) === 'handled'
      const state = this.getState()
      if (!state.isStreaming && !state.isCompacting && (this.running || command || handled))
        this.handleEvent({ type: 'agent_settled' }, Boolean(command || handled))
    } catch (cause) {
      this.pendingSend = false
      if (command) this.handleEvent({ type: 'agent_settled' }, true)
      void this.snapshot().catch(() => {})
      throw cause
    }
  }

  /** 预检完成即返回，整轮运行通过事件推送，与 RPC 模式一致。 */
  continueCollaborationTask(message: string, mode: TaskMode) {
    return this.prompt(message, undefined, [], { mode }, true)
  }

  private async sendPrompt(message: string, images?: PiImage[], continuation = false) {
    const generation = this.generation
    await this.ready
    await this.waitForResume()
    if (generation !== this.generation || this.status !== 'ready' || this.queueCancelled)
      throw new Error('Pi 尚未连接或消息发送已取消')
    const session = this.session
    if (continuation)
      return new Promise<'started'>((resolve, reject) => {
        let started = false
        const unsubscribe = session.subscribe((event) => {
          if (event.type !== 'agent_start') return
          started = true
          unsubscribe()
          resolve('started')
        })
        void session
          .sendCustomMessage(
            {
              customType: 'pi-meme-collaboration-control',
              content: message,
              display: false,
              details: { kind: 'continuation' },
            },
            { triggerTurn: true },
          )
          .catch((cause: unknown) => {
            unsubscribe()
            if (!started) reject(new Error(`Pi 操作失败：${String(cause)}`))
          })
      })
    return new Promise<'handled' | 'queued' | 'started'>((resolve, reject) => {
      let started = false
      void session
        .prompt(message, {
          images,
          source: 'rpc',
          preflightResult: (disposition) => {
            this.pendingSend = false
            started = true
            resolve(disposition)
          },
        })
        .catch((cause: unknown) => {
          if (!started) reject(new Error(`Pi 操作失败：${String(cause)}`))
        })
    })
  }

  private async prepareSkills(message: string, skills: SkillReference[]) {
    if (!skills.length) return message
    const generation = this.generation
    const expanded = await expandSkills(message, skills, await this.getCommands())
    if (generation !== this.generation) throw new Error('Pi 已切换，请重新选择技能')
    return expanded
  }

  private emitQueue() {
    this.notify.event({
      generation: this.generation,
      event: {
        type: 'queue_update',
        steering: structuredClone([
          ...this.nativeQueue.steering.map((input) => ({ ...input, submitted: true })),
          ...this.ownQueue.steering,
        ]),
        followUp: structuredClone([
          ...this.nativeQueue.followUp.map((input) => ({ ...input, submitted: true })),
          ...this.ownQueue.followUp,
        ]),
      },
    })
  }

  private async enqueue(
    kind: 'steering' | 'followUp',
    message: string,
    images?: PiImage[],
    skills: SkillReference[] = [],
    options?: MessageOptions,
  ) {
    const normalized = normalizePlanMessage(message, options?.mode ?? this.mode)
    this.mode = normalized.mode
    if (normalized.commandOnly) return
    if (builtinCommand(normalized.text)) throw new Error('内置命令不能插话或排队，请等待当前任务完成后执行')
    const input: QueuedInput = { id: randomUUID(), text: normalized.text, mode: normalized.mode, images, skills }
    if (kind === 'followUp' || normalized.mode === 'plan' || normalized.mode !== this.activeMode || !this.running) {
      await this.withQueueLock(() => {
        this.ownQueue[kind].push(input)
        this.emitQueue()
      })
      if (!this.running) await this.advanceQueue()
      return
    }
    const prepared = await this.prepareSkills(input.text, skills)
    this.preparedQueueText.set(input.id, prepared)
    this.nativeQueue[kind].push(input)
    await this.call(() =>
      kind === 'steering'
        ? this.session.steer(prepared, images, { source: 'rpc' })
        : this.session.followUp(prepared, images, { source: 'rpc' }),
    )
  }

  private async withQueueLock<T>(operation: () => T | Promise<T>): Promise<T> {
    const previous = this.queueLock
    let release!: () => void
    this.queueLock = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }

  private emitPause() {
    this.notify.event({
      generation: this.generation,
      event: {
        type: 'pause_update',
        isPaused: this.paused,
        queuePaused: this.queuePaused,
        revision: this.pauseRevision,
        pauseIntervals: structuredClone(this.pauseIntervals),
      },
    })
  }

  private scheduleQueue() {
    queueMicrotask(() => {
      void this.advanceQueue().catch((cause: unknown) => this.report(String(cause)))
    })
  }

  private async waitForResume() {
    const generation = this.generation
    while (generation === this.generation && this.paused && this.pauseGate) await this.pauseGate
  }

  private cancelPause(closeInterval = true) {
    const interval = this.pauseIntervals.at(-1)
    if (closeInterval && interval && interval.endedAt === undefined) interval.endedAt = Date.now()
    this.paused = false
    this.frozenView = undefined
    this.releasePause?.()
    this.releasePause = undefined
    this.pauseGate = undefined
  }

  async setPaused(paused: boolean, revision: number) {
    if (revision < this.pauseRevision || (revision === this.pauseRevision && this.pauseControlApplied)) return
    this.pauseRevision = revision
    this.pauseControlApplied = true
    if (paused && !this.paused) {
      if (this.status === 'ready')
        this.frozenView = structuredClone({
          messages: this.session.messages.filter((message) => message.role !== 'system'),
          entries: this.session.sessionManager.getEntries(),
          leafId: this.session.sessionManager.getLeafId(),
        })
      this.pauseIntervals.push({ startedAt: Date.now() })
      this.paused = true
      this.queuePaused = true
      this.pauseGate = new Promise<void>((resolve) => {
        this.releasePause = resolve
      })
    } else if (!paused) {
      this.cancelPause()
      this.queuePaused = false
    }
    this.emitPause()
    if (!paused) this.scheduleQueue()
  }

  pause() {
    return this.setPaused(true, this.pauseRevision + 1)
  }
  resume() {
    return this.setPaused(false, this.pauseRevision + 1)
  }

  private queueItem(id: string) {
    for (const kind of ['steering', 'followUp'] as const) {
      const index = this.ownQueue[kind].findIndex((input) => input.id === id)
      if (index >= 0) return { kind, index, input: this.ownQueue[kind][index]! }
    }
    throw new Error('排队输入不存在或已发送')
  }

  beginQueueEdit(id: string, clientId: string) {
    return this.withQueueLock(() => {
      const { input } = this.queueItem(id)
      if (input.editing) throw new Error('排队输入正在编辑')
      input.editing = true
      this.queueEdits.set(id, clientId)
      this.emitQueue()
      return structuredClone(input)
    })
  }

  updateQueueInput(
    id: string,
    message: string,
    images?: PiImage[],
    skills: SkillReference[] = [],
    options?: MessageOptions,
    clientId?: string,
  ) {
    return this.withQueueLock(() => {
      const { input } = this.queueItem(id)
      if (!input.editing || this.queueEdits.get(id) !== clientId) throw new Error('此客户端未持有排队输入编辑权')
      const normalized = normalizePlanMessage(message, options?.mode ?? input.mode)
      if (normalized.commandOnly || builtinCommand(normalized.text)) throw new Error('排队输入必须包含任务正文')
      Object.assign(input, { text: normalized.text, mode: normalized.mode, images, skills, editing: undefined })
      this.queueEdits.delete(id)
      this.emitQueue()
    }).then(() => this.scheduleQueue())
  }

  cancelQueueEdit(id: string, clientId: string) {
    return this.withQueueLock(() => {
      const { input } = this.queueItem(id)
      if (!input.editing || this.queueEdits.get(id) !== clientId) throw new Error('此客户端未持有排队输入编辑权')
      delete input.editing
      this.queueEdits.delete(id)
      this.emitQueue()
    }).then(() => this.scheduleQueue())
  }

  releaseQueueEdits(clientId: string) {
    return this.withQueueLock(() => {
      let changed = false
      for (const [id, owner] of this.queueEdits) {
        if (owner !== clientId) continue
        const { input } = this.queueItem(id)
        delete input.editing
        this.queueEdits.delete(id)
        changed = true
      }
      if (changed) this.emitQueue()
    }).then(() => this.scheduleQueue())
  }

  deleteQueueInput(id: string) {
    return this.withQueueLock(() => {
      const { kind, index, input } = this.queueItem(id)
      if (input.editing) throw new Error('排队输入正在编辑')
      this.ownQueue[kind].splice(index, 1)
      this.emitQueue()
    }).then(() => this.scheduleQueue())
  }

  async steerQueueInput(id: string) {
    const selected = await this.withQueueLock(() => {
      if (this.nativeQueue.steering.some((input) => input.id === id)) return undefined
      const selected = this.queueItem(id)
      if (selected.input.editing) throw new Error('排队输入正在编辑')
      if (this.running && selected.input.mode !== (this.activeMode ?? this.runtimeMode))
        throw new Error('不能引导不同模式的排队输入，请等待当前任务结束')
      this.ownQueue[selected.kind].splice(selected.index, 1)
      if (!this.running) {
        this.ownQueue.steering.unshift(selected.input)
        this.emitQueue()
        return undefined
      }
      this.handingOff += 1
      this.emitQueue()
      const handoff = {
        ...selected,
        nextId: this.ownQueue[selected.kind][selected.index]?.id,
        generation: this.generation,
        activity: this.activityRevision,
        cancelled: false,
      }
      this.handoffs.set(id, handoff)
      return handoff
    })
    if (!selected) {
      this.scheduleQueue()
      return
    }
    try {
      const prepared = await this.prepareSkills(selected.input.text, selected.input.skills ?? [])
      await this.withQueueLock(() => {
        if (
          selected.cancelled ||
          selected.generation !== this.generation ||
          selected.activity !== this.activityRevision ||
          !this.running ||
          this.queueCancelled
        )
          throw new Error('当前任务已结束或取消，排队输入未引导')
        this.preparedQueueText.set(id, prepared)
        this.nativeQueue.steering.push(selected.input)
      })
      await this.call(() => {
        if (
          selected.cancelled ||
          selected.generation !== this.generation ||
          selected.activity !== this.activityRevision ||
          !this.running ||
          this.queueCancelled
        )
          throw new Error('当前任务已结束或取消，排队输入未引导')
        return this.session.steer(prepared, selected.input.images, { source: 'rpc' })
      })
      this.emitQueue()
    } catch (cause) {
      await this.withQueueLock(() => {
        this.nativeQueue.steering = this.nativeQueue.steering.filter((value) => value.id !== id)
        this.preparedQueueText.delete(id)
        if (!selected.cancelled) {
          const next = this.ownQueue[selected.kind].findIndex((input) => input.id === selected.nextId)
          this.ownQueue[selected.kind].splice(
            next < 0 ? Math.min(selected.index, this.ownQueue[selected.kind].length) : next,
            0,
            selected.input,
          )
          this.queuePaused = true
        }
        this.emitQueue()
        this.emitPause()
      })
      throw cause
    } finally {
      this.handoffs.delete(id)
      this.handingOff -= 1
      this.scheduleQueue()
    }
  }

  private cancelComposerHint() {
    this.hintController?.abort()
    this.hintController = undefined
    this.composerHint = undefined
  }

  private clearComposerHint() {
    const hadHint = this.composerHint !== undefined
    this.cancelComposerHint()
    if (hadHint) this.notify.event({ generation: this.generation, event: { type: 'composer_hint' } })
  }

  /** 队列确认不会接下一轮之后，再问模型要不要给一句下一步。失败或超时就当不显示。 */
  private async refreshComposerHint() {
    if (
      this.running ||
      this.paused ||
      this.queuePaused ||
      this.changing ||
      this.draining ||
      this.queueCancelled ||
      this.ownQueue.steering.length > 0 ||
      this.ownQueue.followUp.length > 0 ||
      this.status !== 'ready'
    )
      return
    const generation = this.generation
    const revision = this.activityRevision
    let summary: string | null
    let model: NonNullable<AgentSession['model']> | undefined
    let runtime: AgentSession['modelRuntime']
    try {
      runtime = this.session.modelRuntime
      model = this.session.model ?? undefined
      summary = summarizeTurn(this.session.messages as HintSourceMessage[])
    } catch {
      return
    }
    if (!model || !summary) return
    const controller = new AbortController()
    this.hintController?.abort()
    this.hintController = controller
    const timer = setTimeout(() => controller.abort(), 8000)
    try {
      const result = await runtime.completeSimple(
        model,
        {
          systemPrompt: composerHintSystemPrompt,
          messages: [{ role: 'user', content: summary, timestamp: Date.now() }],
        },
        { maxTokens: 80, temperature: 0, reasoning: 'minimal', signal: controller.signal },
      )
      if (
        this.hintController !== controller ||
        controller.signal.aborted ||
        generation !== this.generation ||
        revision !== this.activityRevision ||
        this.running
      )
        return
      const hint = composerHintFromAssistant(result) ?? undefined
      if (this.composerHint === hint) return
      this.composerHint = hint
      this.notify.event({ generation: this.generation, event: { type: 'composer_hint', text: hint } })
    } catch {
      if (
        this.hintController === controller &&
        !controller.signal.aborted &&
        generation === this.generation &&
        revision === this.activityRevision &&
        !this.running
      )
        this.clearComposerHint()
    } finally {
      clearTimeout(timer)
      if (this.hintController === controller) this.hintController = undefined
    }
  }

  private async advanceQueue() {
    if (
      this.running ||
      this.changing ||
      this.queueCancelled ||
      this.paused ||
      this.queuePaused ||
      this.draining ||
      this.handingOff
    )
      return
    this.draining = true
    let selected: { kind: 'steering' | 'followUp'; input: QueuedInput } | undefined
    try {
      selected = await this.withQueueLock(() => {
        if (this.running || this.changing || this.queueCancelled || this.paused || this.queuePaused) return
        const kind = this.ownQueue.steering.length ? 'steering' : 'followUp'
        const input = this.ownQueue[kind][0]
        if (!input || input.editing) return
        this.ownQueue[kind].shift()
        this.emitQueue()
        return { kind, input }
      })
      if (!selected) return
      await this.prompt(
        selected.input.text,
        selected.input.images,
        selected.input.skills,
        { mode: selected.input.mode },
        false,
        true,
      )
    } catch (cause) {
      if (selected)
        await this.withQueueLock(() => {
          this.ownQueue[selected!.kind].unshift(selected!.input)
          this.queuePaused = true
          this.emitQueue()
          this.emitPause()
        })
      throw cause
    } finally {
      this.draining = false
      if (
        !this.running &&
        !this.queuePaused &&
        !this.paused &&
        !this.queueCancelled &&
        (this.ownQueue.steering[0] ?? this.ownQueue.followUp[0]) &&
        !(this.ownQueue.steering[0] ?? this.ownQueue.followUp[0])?.editing
      )
        this.scheduleQueue()
    }
  }

  steer(message: string, images?: PiImage[], skills: SkillReference[] = [], options?: MessageOptions) {
    return this.enqueue('steering', message, images, skills, options)
  }

  followUp(message: string, images?: PiImage[], skills: SkillReference[] = [], options?: MessageOptions) {
    return this.enqueue('followUp', message, images, skills, options)
  }

  async clearQueue() {
    return this.withQueueLock(async () => {
      const cleared = {
        steering: [...this.nativeQueue.steering, ...this.ownQueue.steering],
        followUp: [...this.nativeQueue.followUp, ...this.ownQueue.followUp],
      }
      for (const handoff of this.handoffs.values()) {
        if (!cleared[handoff.kind].some((input) => input.id === handoff.input.id))
          cleared[handoff.kind].push(handoff.input)
        handoff.cancelled = true
      }
      if (this.status === 'ready') await this.call(() => this.session.clearQueue())
      this.queueEdits.clear()
      this.preparedQueueText.clear()
      this.nativeQueue = { steering: [], followUp: [] }
      this.ownQueue = { steering: [], followUp: [] }
      this.emitQueue()
      return cleared
    })
  }

  async setSessionMode(mode: TaskMode) {
    this.mode = mode
    if (!this.running && !this.changing && this.runtime && this.runtimeMode !== mode) {
      const restore = await this.captureRestoreState()
      await this.reconnectModels(restore)
    }
  }

  deliverCollaborationMessage(message: AgentMailboxMessage) {
    return this.call(async () => {
      const persisted = () =>
        this.session.sessionManager
          .getEntries()
          .some(
            (entry) =>
              entry.type === 'custom_message' &&
              entry.customType === 'pi-meme-collaboration' &&
              (entry.details as { messageId?: string } | undefined)?.messageId === message.id,
          )
      if (persisted()) return { persisted: true }
      if (this.pendingDeliveries.has(message.id)) return { persisted: false }
      this.pendingDeliveries.add(message.id)
      try {
        await this.session.sendCustomMessage(
          {
            customType: 'pi-meme-collaboration',
            content: `[来自 ${message.fromAgentId}] ${message.text}`,
            display: message.kind !== 'result',
            details: {
              name: message.name,
              status: message.status,
              startedAt: message.startedAt,
              completedAt: message.completedAt,
              messageId: message.id,
              fromAgentId: message.fromAgentId,
              runId: message.runId,
              rootTaskId: message.rootTaskId,
              epoch: message.epoch,
              kind: message.kind,
            },
          },
          { deliverAs: 'steer' },
        )
        return { persisted: persisted() }
      } catch (cause) {
        this.pendingDeliveries.delete(message.id)
        throw cause
      }
    })
  }

  async setSteeringMode(mode: 'all' | 'one-at-a-time') {
    await this.call(() => this.session.setSteeringMode(mode))
    return this.toState(this.getState())
  }

  async setFollowUpMode(mode: 'all' | 'one-at-a-time') {
    await this.call(() => this.session.setFollowUpMode(mode))
    return this.toState(this.getState())
  }

  async getCommands(): Promise<PiSlashCommand[]> {
    if (this.cachedCommands) return this.cachedCommands
    const commands = await this.call(() => {
      const session = this.session
      const list: PiSlashCommand[] = []
      for (const command of session.extensionRunner.getRegisteredCommands())
        list.push({
          name: command.invocationName,
          description: command.description,
          source: 'extension',
          sourceInfo: command.sourceInfo,
        })
      for (const template of session.promptTemplates)
        list.push({
          name: template.name,
          description: template.description,
          source: 'prompt',
          sourceInfo: template.sourceInfo,
        })
      for (const skill of this.policy.resourceSnapshot?.skills ?? [])
        if (skill.enabled && !skill.shadowedBy) list.push(toResourceSkillCommand(skill))
      return list
    })
    this.cachedCommands = commands
    return commands
  }

  requestUserInput(questions: import('@pi-meme/contracts/user-input').UserInputQuestion[], signal?: AbortSignal) {
    if (!this.bridge || (this.policy.requireRestrictedPolicy && !this.policy.uiEnabled))
      throw new Error('当前客户端无法回答交互问题')
    return this.bridge.requestUserInput(questions, signal)
  }

  respondExtensionUI(id: string, response: PiExtensionUIResponse) {
    if (!this.bridge) throw new Error('扩展交互已结束')
    this.bridge.respond(id, response)
  }

  abort() {
    this.cancelPause()
    this.emitPause()
    this.queueCancelled = true
    this.admission?.abort()
    return this.call(() => this.session.abort())
  }

  setModel(model: PiModel): Promise<PiModel> {
    return this.idle(async () => {
      const selected = await this.call(() => {
        const found = this.session.modelRuntime
          .getAvailableSnapshot()
          .find((entry) => entry.provider === model.provider && entry.id === model.id)
        if (!found) throw new Error(`模型不可用：${model.provider}/${model.id}`)
        return found
      })
      await this.call(() => this.session.setModel(selected))
      this.modelSelectionRequired = false
      return { provider: selected.provider, id: selected.id, name: selected.name, reasoning: selected.reasoning }
    })
  }

  setSessionName(name: string) {
    return this.idle(() =>
      this.call(() => {
        const trimmed = name.trim()
        if (!trimmed) throw new Error('会话名称不能为空')
        this.session.setSessionName(trimmed)
      }),
    )
  }

  setThinkingLevel(level: ThinkingLevel) {
    return this.idle(() => this.call(() => this.session.setThinkingLevel(level)))
  }

  getAvailableThinkingLevels() {
    return this.call(() => this.session.getAvailableThinkingLevels())
  }

  getSessionStats() {
    return this.call(() => this.session.getSessionStats())
  }

  navigateToEntry(entryId: string) {
    return this.call(async () => {
      const result = await this.session.navigateTree(entryId, { summarize: false })
      return { cancelled: result.cancelled }
    })
  }

  async forkAtEntry(entryId: string) {
    return this.call(async () => {
      const runtime = this.runtime
      if (!runtime) throw new Error('Pi 尚未就绪')
      const result = await runtime.fork(entryId, { position: 'at' })
      return { cancelled: result.cancelled }
    })
  }

  async captureRestoreState(): Promise<ModelRestore | undefined> {
    if (this.status !== 'ready') return this.modelRestore
    const state = await this.call(() => this.getState())
    return { sessionFile: state.sessionFile, model: toModel(state.model), thinkingLevel: state.thinkingLevel }
  }
}
