import type { AgentSummary } from '@pi-meme/contracts/collaboration'
import type {
  Connection,
  DesktopBridge,
  DesktopError,
  DesktopEvent,
  Snapshot,
  WorkspaceDeletionResult,
} from '@pi-meme/contracts/desktop'
import type {
  HostConnection,
  HostDirectory,
  HostEvent,
  HostRpcResponse,
  PlatformAdapter,
} from '@pi-meme/contracts/host'
import type { SettingsSnapshot, Theme } from '@pi-meme/contracts/settings'
import type { PluginClient } from './plugin-client'

export type ClientOptions = {
  connection: HostConnection
  clientId?: string
  platform?: PlatformAdapter
  selectDirectory: (load: (path?: string) => Promise<HostDirectory>) => Promise<string | null>
  fetch?: typeof fetch
  createSocket?: (url: string) => WebSocket
  reconnectDelay?: number
}

export class HostClient {
  readonly clientId: string
  readonly bridge: DesktopBridge
  readonly plugins: PluginClient
  private readonly url: URL
  private readonly fetch: typeof fetch
  private readonly eventListeners = new Set<(value: DesktopEvent) => void>()
  private readonly connectionListeners = new Set<(value: Connection) => void>()
  private readonly errorListeners = new Set<(value: DesktopError) => void>()
  private readonly sessionsListeners = new Set<() => void>()
  private readonly pluginListeners = new Set<() => void>()
  private socket?: WebSocket
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private reconnectAttempts = 0
  private closed = false
  private authenticated?: Promise<void>
  private renewing?: Promise<void>
  private selected?: Connection
  private selectionEpoch = 0
  private pendingSelections = 0
  private connectedHostId: string
  private readonly childAgents = new Map<string, string>()
  private readonly childReads = new Map<string, Promise<Snapshot>>()
  private readonly executionGenerations = new Map<string, number>()
  private readonly sequences = new Map<string, number>()
  private resynchronizing?: Promise<void>
  private buffered: HostEvent[] = []

  constructor(private readonly options: ClientOptions) {
    this.url = new URL(options.connection.url)
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(this.url.hostname)
    if (this.url.protocol !== 'https:' && !(loopback && this.url.protocol === 'http:'))
      throw new Error('远程 Host 必须使用 HTTPS 地址')
    if (this.url.username || this.url.password) throw new Error('Host 地址不能包含账号或凭据')
    this.connectedHostId = options.connection.hostId
    this.clientId = options.clientId ?? crypto.randomUUID()
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.bridge = this.createBridge()
    this.plugins = {
      list: () => this.rpc('plugins:list', [], null),
      installDirectory: (path) => this.rpc('plugins:install-directory', [path], null),
      installPackage: (base64) => this.rpc('plugins:install-package', [base64], null),
      reload: (id) => this.rpc('plugins:reload', [id], null),
      enable: (id) => this.rpc('plugins:enable', [id], null),
      disable: (id) => this.rpc('plugins:disable', [id], null),
      remove: (id) => this.rpc('plugins:remove', [id], null),
      onChange: (callback) => {
        this.pluginListeners.add(callback)
        return () => {
          this.pluginListeners.delete(callback)
        }
      },
    }
  }

  get hostId() {
    return this.connectedHostId
  }
  get hostAddress() {
    return this.url.origin
  }
  get localHost() {
    return this.options.platform
      ? this.options.connection.local
      : ['localhost', '127.0.0.1', '[::1]'].includes(this.url.hostname)
  }
  get nativePlatformAvailable() {
    return Boolean(this.options.connection.local && this.options.platform)
  }

  async connect() {
    if (this.closed) throw new Error('Host 客户端已关闭')
    await this.authenticate()
    this.openSocket()
  }

  private authenticate() {
    this.authenticated ??= (async () => {
      const response = await this.fetch(new URL('/api/auth', this.url), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: this.options.connection.token }),
      })
      if (!response.ok) throw new Error('Host 认证失败，请检查访问令牌')
      this.options.connection.token = ''
    })().catch((error: unknown) => {
      this.authenticated = undefined
      throw error
    })
    return this.authenticated
  }

  private renewAuthentication() {
    this.renewing ??= (async () => {
      this.authenticated = undefined
      if (this.options.platform) {
        const connection = await this.options.platform.getHostConnection()
        if (
          new URL(connection.url).origin !== this.url.origin ||
          (this.hostId && connection.hostId && this.hostId !== connection.hostId)
        )
          throw new Error('Host 连接已变化，请重新连接')
        this.options.connection.token = connection.token
      }
      await this.authenticate()
    })().finally(() => {
      this.renewing = undefined
    })
    return this.renewing
  }

  async rpc<T>(
    method: string,
    args: unknown[] = [],
    sessionId: string | null | undefined = this.selected?.sessionKey,
  ): Promise<T> {
    if (this.closed) throw new Error('Host 客户端已关闭')
    await this.authenticate()
    const requestId = crypto.randomUUID()
    const send = async () => {
      try {
        return await this.fetch(new URL('/api/rpc', this.url), {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requestId,
            clientId: this.clientId,
            hostId: this.hostId || undefined,
            sessionId: sessionId ?? undefined,
            method,
            args,
          }),
        })
      } catch (cause) {
        throw new Error(`无法连接 Host，操作没有自动重发：${String(cause)}`)
      }
    }
    let response = await send()
    if (response.status === 401) {
      await this.renewAuthentication()
      if (this.closed) throw new Error('Host 客户端已关闭')
      response = await send()
    }
    if (response.status === 401) throw new Error('Host 登录已失效，请重新连接')
    const envelope = (await response.json()) as HostRpcResponse
    if (envelope.requestId !== requestId) throw new Error('Host 返回了不匹配的请求标识')
    this.acceptHost(envelope.hostId)
    if (envelope.error) throw new Error(envelope.error.message)
    if (!response.ok) throw new Error(`Host 请求失败：HTTP ${response.status}`)
    return envelope.result as T
  }

  private acceptHost(hostId: string) {
    if (!hostId || (this.hostId && hostId !== this.hostId)) throw new Error('连接的 Host 身份已变化，请重新连接')
    this.connectedHostId = hostId
  }

  private async snapshot(sessionId = this.selected?.sessionKey, updateSelection = true) {
    const epoch = this.selectionEpoch
    const snapshot = await this.rpc<Snapshot>('pi:snapshot', [], sessionId)
    this.registerAgents(snapshot.agents ?? [])
    if (updateSelection && epoch === this.selectionEpoch && sessionId === this.selected?.sessionKey)
      this.selected = snapshot.connection
    if (snapshot.agent && snapshot.connection.sessionKey)
      this.executionGenerations.set(
        snapshot.connection.sessionKey,
        Math.max(
          this.executionGenerations.get(snapshot.connection.sessionKey) ?? 0,
          snapshot.agent.executionGeneration,
        ),
      )
    if (snapshot.connection.sessionKey && snapshot.eventSequence !== undefined)
      this.sequences.set(
        snapshot.connection.sessionKey,
        Math.max(this.sequences.get(snapshot.connection.sessionKey) ?? 0, snapshot.eventSequence),
      )
    return snapshot
  }

  private registerAgents(agents: AgentSummary[]) {
    for (const agent of agents) if (agent.parentAgentId) this.childAgents.set(agent.sessionKey, agent.agentId)
    return agents
  }

  private agentSnapshot(agentId: string) {
    const pending = this.childReads.get(agentId)
    if (pending) return pending
    const read = this.rpc<Snapshot>('pi:agent-snapshot', [agentId], null)
      .then((snapshot) => {
        const key = snapshot.connection.sessionKey
        if (
          key &&
          !(snapshot.agent && snapshot.agent.executionGeneration < (this.executionGenerations.get(key) ?? 0))
        ) {
          this.childAgents.set(key, agentId)
          this.sequences.set(key, snapshot.eventSequence ?? 0)
          if (snapshot.agent) this.executionGenerations.set(key, snapshot.agent.executionGeneration)
        }
        return snapshot
      })
      .finally(() => this.childReads.delete(agentId))
    this.childReads.set(agentId, read)
    return read
  }

  private async selection(method: string, args: unknown[] = [], sessionId = this.selected?.sessionKey) {
    const epoch = ++this.selectionEpoch
    this.pendingSelections++
    let accepted: Connection | undefined
    try {
      const result = await this.rpc<Awaited<ReturnType<DesktopBridge['switchSession']>>>(method, args, sessionId)
      if (!result.cancelled && epoch === this.selectionEpoch) {
        this.selected = result.snapshot.connection
        accepted = result.snapshot.connection
      }
      return result
    } finally {
      this.pendingSelections--
      if (accepted && epoch === this.selectionEpoch) this.publishConnection(accepted)
    }
  }

  private async deletion(method: string, args: unknown[]) {
    let epoch = this.selectionEpoch
    this.pendingSelections++
    let accepted: Connection | undefined
    try {
      const result = await this.rpc<WorkspaceDeletionResult>(method, args)
      if (result.selection && !result.selection.cancelled && epoch === this.selectionEpoch) {
        epoch = ++this.selectionEpoch
        this.selected = result.selection.snapshot.connection
        accepted = this.selected
      }
      return result
    } finally {
      this.pendingSelections--
      if (accepted && epoch === this.selectionEpoch) this.publishConnection(accepted)
    }
  }

  private openSocket() {
    if (this.closed || this.socket) return
    const url = new URL('/api/events', this.url)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.searchParams.set('clientId', this.clientId)
    const socket = (this.options.createSocket ?? ((address) => new WebSocket(address)))(url.href)
    this.socket = socket
    socket.addEventListener('open', () => {
      void this.resynchronize()
    })
    socket.addEventListener('message', (message) => {
      try {
        const envelope = JSON.parse(String(message.data)) as HostEvent
        this.acceptHost(envelope.hostId)
        if (this.resynchronizing) this.buffered.push(envelope)
        else this.receive(envelope)
      } catch (cause) {
        this.reportError(`无法读取 Host 事件：${String(cause)}`)
      }
    })
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return
      this.socket = undefined
      if (this.closed) return
      if (this.selected)
        this.publishConnection({ ...this.selected, status: 'disconnected', error: 'Host 连接已断开，正在重连' })
      const delay = Math.min((this.options.reconnectDelay ?? 1000) * 2 ** this.reconnectAttempts++, 15000)
      this.reconnectTimer = setTimeout(() => void this.reconnectSocket(), delay)
    })
    socket.addEventListener('error', () => this.reportError('WebSocket 连接失败，请检查 Host 地址和网络'))
  }

  private async reconnectSocket() {
    try {
      await this.renewAuthentication()
      if (!this.closed) this.openSocket()
    } catch (cause) {
      if (this.closed) return
      this.reportError(`Host 重新认证失败：${String(cause)}`)
      const delay = Math.min((this.options.reconnectDelay ?? 1000) * 2 ** this.reconnectAttempts++, 15000)
      this.reconnectTimer = setTimeout(() => void this.reconnectSocket(), delay)
    }
  }

  private resynchronize(sessionId = this.selected?.sessionKey) {
    if (this.resynchronizing) return this.resynchronizing
    this.resynchronizing = (async () => {
      let recovered = false
      try {
        const epoch = this.selectionEpoch
        const snapshot = await this.snapshot(sessionId, sessionId === this.selected?.sessionKey)
        if (epoch === this.selectionEpoch && snapshot.connection.sessionKey === this.selected?.sessionKey)
          this.publishConnection(snapshot.connection)
        await Promise.allSettled([...new Set(this.childAgents.values())].map((id) => this.agentSnapshot(id)))
        for (const callback of this.sessionsListeners) callback()
        for (const callback of this.pluginListeners) callback()
        this.reconnectAttempts = 0
        recovered = true
      } catch (cause) {
        this.reportError(`无法恢复 Host 快照：${String(cause)}`)
        this.socket?.close()
      } finally {
        this.resynchronizing = undefined
        const pending = this.buffered
        this.buffered = []
        if (recovered) for (const envelope of pending) this.receive(envelope)
      }
    })()
    return this.resynchronizing
  }

  private publishConnection(connection: Connection) {
    this.selected = connection
    for (const callback of this.connectionListeners) callback(connection)
  }

  private receive(envelope: HostEvent) {
    switch (envelope.type) {
      case 'event': {
        const record = envelope.value
        if (record.event.type === 'agents_update') this.registerAgents(record.event.agents)
        if (
          record.sessionKey &&
          record.agentId &&
          record.agentId !== record.rootAgentId &&
          record.sessionKey !== this.selected?.sessionKey
        )
          this.childAgents.set(record.sessionKey, record.agentId)
        if (record.sessionKey && record.executionGeneration !== undefined) {
          const childId = this.childAgents.get(record.sessionKey)
          const execution = this.executionGenerations.get(record.sessionKey)
          if (
            record.executionGeneration !== undefined &&
            execution !== undefined &&
            record.executionGeneration < execution
          )
            return
          if (record.executionGeneration !== execution) {
            this.executionGenerations.set(record.sessionKey, record.executionGeneration)
            this.sequences.delete(record.sessionKey)
            if (childId) void this.agentSnapshot(childId).catch((cause) => this.reportError(String(cause)))
          }
        }
        if (record.sessionKey && record.sequence !== undefined) {
          const childId = this.childAgents.get(record.sessionKey)
          const previous = this.sequences.get(record.sessionKey) ?? (childId ? 0 : undefined)
          if (previous !== undefined && record.sequence <= previous) return
          if (previous !== undefined && record.sequence > previous + 1) {
            if (childId) {
              for (const callback of this.eventListeners) callback(record)
              void this.agentSnapshot(childId).catch((cause) =>
                this.reportError(`无法恢复子代理快照：${String(cause)}`),
              )
            } else {
              this.buffered.push(envelope)
              void this.resynchronize(record.sessionKey)
            }
            return
          }
          this.sequences.set(record.sessionKey, record.sequence)
        }
        for (const callback of this.eventListeners) callback(record)
        break
      }
      case 'connection':
        if (!this.pendingSelections && (!this.selected || envelope.value.sessionKey === this.selected.sessionKey))
          this.publishConnection(envelope.value)
        break
      case 'error':
        for (const callback of this.errorListeners) callback(envelope.value)
        break
      case 'sessions-changed':
        for (const callback of this.sessionsListeners) callback()
        break
      case 'plugins-changed':
        for (const callback of this.pluginListeners) callback()
        break
    }
  }

  private reportError(message: string) {
    for (const callback of this.errorListeners)
      callback({ generation: this.selected?.generation ?? 0, sessionKey: this.selected?.sessionKey, message })
  }

  close() {
    this.closed = true
    clearTimeout(this.reconnectTimer)
    this.socket?.close()
    this.socket = undefined
    this.buffered = []
    this.eventListeners.clear()
    this.connectionListeners.clear()
    this.errorListeners.clear()
    this.sessionsListeners.clear()
    this.pluginListeners.clear()
  }

  private async directory() {
    if (this.options.connection.local && this.options.platform) return this.options.platform.chooseDirectory()
    return this.options.selectDirectory((path) => this.rpc<HostDirectory>('host:directories', path ? [path] : []))
  }

  private createBridge(): DesktopBridge {
    const rpc = <T>(method: string, args: unknown[] = [], sessionId = this.selected?.sessionKey) =>
      this.rpc<T>(method, args, sessionId)
    const subscribe = <T>(listeners: Set<(value: T) => void>, callback: (value: T) => void) => {
      listeners.add(callback)
      return () => {
        listeners.delete(callback)
      }
    }
    const platform = this.options.connection.local ? this.options.platform : undefined
    const openPath = async (field: 'themesDirectory' | 'extensionsDirectory') => {
      const settings = await rpc<SettingsSnapshot>('settings:get')
      if (!platform) throw new Error(`目录位于 Host：${settings[field]}`)
      await platform.openPath(settings[field])
    }
    return {
      getConnection: async () => (await this.snapshot()).connection,
      getSnapshot: () => this.snapshot(),
      onConnection: (callback) => subscribe(this.connectionListeners, callback),
      onEvent: (callback) => subscribe(this.eventListeners, callback),
      onError: (callback) => subscribe(this.errorListeners, callback),
      onSessionsChanged: (callback) => subscribe(this.sessionsListeners, callback),
      addProjectDirectory: async () => {
        const path = await this.directory()
        return path ? rpc('project:register', [path]) : null
      },
      chooseDirectory: async (targetPath) => {
        const path = targetPath ?? (await this.directory())
        if (!path) return null
        await this.selection('pi:directory', [path])
        return path
      },
      getProjectApps: () => platform?.getProjectApps() ?? Promise.resolve([]),
      openProject: async (app, cwd) => {
        if (!platform) throw new Error('浏览器和远程 Host 无法打开本机 Finder 或编辑器')
        await platform.openProject(app, cwd ?? this.selected?.cwd ?? '')
      },
      setPreferredProjectApp: (app) => rpc('project:preferred-app', [app]),
      getProjects: () => rpc('workspace:projects'),
      renameProject: (cwd, name) => rpc('project:rename', [cwd, name]),
      previewProjectDeletion: (cwd) => rpc('project:delete-preview', [cwd]),
      removeProject: (cwd, paths) => this.deletion('project:remove', [cwd, paths]),
      renameSession: (path, name) => rpc('session:rename', [path, name]),
      deleteSession: (path) => this.deletion('session:delete', [path]),
      selectWorkspace: (input) => this.selection('workspace:select', [input]),
      getSessions: () => rpc('pi:sessions'),
      newSession: () => this.selection('pi:new-session'),
      switchSession: (path) => this.selection('pi:switch-session', [path]),
      readSessionHistory: (path) => rpc('session:history', [path]),
      prefetchSession: (path) => rpc('session:prefetch', [path]),
      togglePin: (path) => rpc('settings:toggle-pin', [path]),
      prompt: (key, message, images, skills, options) =>
        rpc('pi:prompt', [key, message, images ?? [], skills ?? [], ...(options === undefined ? [] : [options])], key),
      steer: (key, message, images, skills, options) =>
        rpc('pi:steer', [key, message, images ?? [], skills ?? [], ...(options === undefined ? [] : [options])], key),
      followUp: (key, message, images, skills, options) =>
        rpc(
          'pi:follow-up',
          [key, message, images ?? [], skills ?? [], ...(options === undefined ? [] : [options])],
          key,
        ),
      getAgents: async (key) => this.registerAgents(await rpc<AgentSummary[]>('pi:agents', [key], key)),
      getAgentSnapshot: (id) => this.agentSnapshot(id),
      interruptAgent: (id) => this.rpc('pi:interrupt-agent', [id], null),
      setSessionMode: (key, mode) => rpc('pi:session-mode', [key, mode], key),
      clearQueue: (key) => rpc('pi:clear-queue', [key], key),
      setSteeringMode: (key, mode) => rpc('pi:steering-mode', [key, mode], key),
      setFollowUpMode: (key, mode) => rpc('pi:follow-up-mode', [key, mode], key),
      setAccessMode: (key, mode) => rpc('pi:access-mode', [key, mode], key),
      getProjectFiles: (cwd, query) => rpc('chat:project-files', [cwd, query]),
      getCommands: () => rpc('pi:commands'),
      abort: (key) => rpc('pi:abort', [key], key),
      editAndPrompt: (key, timestamp, message, images, skills, options) =>
        rpc(
          'pi:edit-and-prompt',
          [key, timestamp, message, images ?? [], skills ?? [], ...(options === undefined ? [] : [options])],
          key,
        ),
      switchMessageVersion: (key, timestamp, version) =>
        rpc('pi:switch-message-version', [key, timestamp, version], key),
      forkReply: (key, timestamp) => this.selection('pi:fork-reply', [key, timestamp], key),
      respondExtensionUI: (key, id, response) => rpc('pi:extension-ui-response', [key, id, response], key),
      getGitSnapshot: () => rpc('git:snapshot'),
      getGitDiff: (path, kind) => rpc('git:diff', [path, kind]),
      setModel: (key, model) => rpc('pi:set-model', [key, model], key),
      setThinkingLevel: (key, level) => rpc('pi:set-thinking-level', [key, level], key),
      getAvailableThinkingLevels: () => rpc('pi:thinking-levels'),
      getSessionStats: () => rpc('pi:session-stats'),
      getModelConfig: () => rpc('models:get'),
      getDefaultModel: () => rpc('models:default'),
      setDefaultModel: (model) => rpc('models:set-default', [model]),
      saveModelProvider: (input) => rpc('models:save', [input]),
      deleteModelProvider: (id, revision) => rpc('models:delete', [id, revision]),
      discoverModels: (input) => rpc('models:discover', [input]),
      reconnectModels: () => rpc('models:reconnect'),
      getUsageStats: () => rpc('settings:usage-stats'),
      getSettings: () => rpc('settings:get'),
      getInstructions: () => rpc('settings:instructions'),
      saveInstruction: (input) => rpc('settings:save-instruction', [input]),
      getSubagents: () => rpc('settings:subagents'),
      reloadSubagents: () => rpc('settings:reload-subagents'),
      saveSettings: (settings) => rpc('settings:save', [settings]),
      saveAppearance: (appearance) => rpc('settings:appearance', [appearance]),
      getInstalledFonts: () => rpc('settings:fonts'),
      importTheme: async () => {
        const content = platform ? await platform.importTheme() : await readThemeFile()
        return content === null ? null : rpc('settings:import-theme-content', [content])
      },
      exportTheme: async (theme) => {
        const content = await rpc<Theme>('settings:export-theme-content', [theme])
        if (platform) await platform.exportTheme(content)
        else downloadTheme(content)
      },
      selectTheme: (id) => rpc('settings:theme', [id]),
      reloadThemes: () => rpc('settings:reload-themes'),
      openThemesDirectory: () => openPath('themesDirectory'),
      openExtensionsDirectory: () => openPath('extensionsDirectory'),
      getMcpConfig: () => rpc('mcp:get'),
      saveMcpServer: (input) => rpc('mcp:save', [input]),
      deleteMcpServer: (input) => rpc('mcp:delete', [input]),
      checkMcpServers: (key) => rpc('mcp:check', [key], key),
    }
  }
}

function readThemeFile(): Promise<unknown | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,application/json'
    input.addEventListener('cancel', () => resolve(null), { once: true })
    input.addEventListener(
      'change',
      () => {
        const file = input.files?.[0]
        if (!file) {
          resolve(null)
          return
        }
        void file
          .text()
          .then((text) => resolve(JSON.parse(text) as unknown))
          .catch(() => reject(new Error('主题文件不是有效的 JSON')))
      },
      { once: true },
    )
    input.click()
  })
}

function downloadTheme(theme: Theme) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(theme, null, 2)], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${theme.id.replace(/[^\w-]/g, '_')}.json`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
