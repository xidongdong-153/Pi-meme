import { GitMenu } from '@pi-meme/git/ui/git-menu'
import { LocationSelector } from './shell/location-selector'
import type { ServiceUI } from './shell/service-ui'
import { SubagentsPanel } from './panels/subagents-panel'
import { createResourceClient } from '@pi-meme/client/resource-client'
import { appendSkillInvocation } from './settings/invoke-skill'
import { AccessSettings } from '@pi-meme/permissions/ui/access-settings'
import { AgentAccessSelector } from '@pi-meme/permissions/ui/agent-access-selector'
import { AppHeader } from './layout/app-header'
import { ForkNotice } from './layout/fork-notice'
import { WorkspaceContent } from './layout/workspace-content'
import { ErrorNotice } from './layout/error-notice'
import {
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
} from 'react'
import { Composer } from '@pi-meme/chat/ui/composer/composer'
import { Conversation } from '@pi-meme/chat/ui/conversation/conversation'
import { Sidebar } from '@pi-meme/workspace/ui/sidebar/sidebar'
import { ModelPickerPopover } from '@pi-meme/models/ui/model-picker-popover'
import { ExtensionWidgets } from '@pi-meme/interaction/ui/extension-widgets'
import { ExtensionStatusBadges } from '@pi-meme/interaction/ui/extension-statuses'
import { ExtensionDialog } from '@pi-meme/interaction/ui/extension-dialog'
import { UserInputPanel } from '@pi-meme/interaction/ui/user-input-panel'
import { ExtensionNotices } from '@pi-meme/interaction/ui/extension-notices'
import { GitPanel } from '@pi-meme/git/ui/git-panel'
import { FileStore } from '@pi-meme/file-directory/ui/file-store'
import { FilesPanel } from '@pi-meme/file-directory/ui/files-panel'
import { activate as activateTerminal } from '@pi-meme/terminal/ui/entry'
import { ProjectSelector } from '@pi-meme/workspace/ui/project-selector'
import { formatSessionTitle } from '@pi-meme/workspace/ui/sidebar/session-title'
import { useAppSession } from './session/use-app-session'
import { messageText } from '@pi-meme/chat/ui/model/message-text'
import { collectTurnChanges } from '@pi-meme/chat/ui/model/turn-changes'
import { ContextUsageRing } from '@pi-meme/models/ui/context-usage-ring'
import { useSettings } from '@pi-meme/settings/ui/use-settings'
import { TooltipProvider } from '@pi-meme/ui/components/ui/tooltip'
import { SessionTreePanel } from '@pi-meme/history/ui/session-tree-panel'
import { PlanPanel } from './panels/plan-panel'
import { planExecutionDraft } from './panels/plan-execution-draft'
import type { RightSidebarTab } from './layout/right-sidebar'
import type { PluginClient } from '@pi-meme/client/plugin-client'
import type { UiContributionProps, UiPluginDescriptor, UiPluginSlot, UiPanel, UiTarget } from '@pi-meme/plugin-sdk/ui'
import { PluginRenderers } from './plugins/plugin-renderers'
import { UiPluginRegistry } from './plugins/plugin-registry'
import { PluginSlot } from './plugins/plugin-slot'
import { WorkspacePanels } from './layout/workspace-panels'
import { sessionUiTarget } from './layout/panel-layout'
import { useAgentPluginSelection } from './plugins/use-agent-plugin-selection'
import { FileDiff, Folder, TerminalSquare, Network, ListTree, NotebookPen } from 'lucide-react'
import type { HostApi, AppSession } from '@pi-meme/contracts/app-host'
import { SettingsPage, type SettingsSection } from './settings/settings-page'
import { loadPluginUI } from './plugins/load-plugin-ui'
import type { DesktopBridge, ProjectApp } from '@pi-meme/contracts/desktop'

const SkillPage = lazy(() => import('./settings/skill-page').then((module) => ({ default: module.SkillPage })))
const PluginPage = lazy(() => import('./settings/plugin-page').then((module) => ({ default: module.PluginPage })))
const HostSettings = lazy(() => import('./settings/host-settings').then((module) => ({ default: module.HostSettings })))
const ModelConfigSettings = lazy(() =>
  import('@pi-meme/models/ui/model-config/model-config-settings').then((module) => ({
    default: module.ModelConfigSettings,
  })),
)
const McpSettings = lazy(() =>
  import('@pi-meme/mcp/ui/mcp-settings').then((module) => ({ default: module.McpSettings })),
)
const SettingsContent = lazy(() =>
  import('@pi-meme/settings/ui/settings-page').then((module) => ({ default: module.SettingsPage })),
)
const ProfileSettings = lazy(() =>
  import('@pi-meme/usage/ui/profile-settings').then((module) => ({ default: module.ProfileSettings })),
)
const AccountSettings = lazy(() =>
  import('./settings/account-settings').then((module) => ({ default: module.AccountSettings })),
)

export function App({
  bridge,
  host,
  plugins,
  call,
  nativeWindow = false,
  localPlatform = false,
  hostId,
  hostAddress,
  hostLocal = false,
  onHostConnection,
  hostConnections,
  serviceUI,
  onBootComplete,
}: {
  serviceUI?: ServiceUI
  bridge: DesktopBridge
  host: HostApi
  plugins: PluginClient
  call: <T>(method: string, args?: unknown[]) => Promise<T>
  nativeWindow?: boolean
  localPlatform?: boolean
  hostId?: string
  hostAddress?: string
  hostLocal?: boolean
  onHostConnection: () => void
  hostConnections?: ComponentProps<typeof HostSettings>['connections']
  /** 当前服务的聊天主界面已经可以显示，或连接失败需要把界面交还用户。 */
  onBootComplete?: () => void
}) {
  const resources = useMemo(() => createResourceClient(call, plugins.onChange), [call, plugins])
  const [registry] = useState(() => new UiPluginRegistry(host, loadPluginUI, call))
  const [pluginDescriptors, setPluginDescriptors] = useState<UiPluginDescriptor[]>([])
  const fileStore = useMemo(() => new FileStore(host), [host])
  const [terminalPanel, setTerminalPanel] = useState<UiPanel>()
  const [systemRequest, setSystemRequest] = useState<{ id: string; revision: number; target: UiTarget }>()
  useEffect(() => () => fileStore.dispose(), [fileStore])
  useEffect(() => {
    let stopped = false
    let dispose: (() => void | Promise<void>) | undefined
    void activateTerminal({
      host,
      panels: {
        register: (panel) => {
          if (!stopped) setTerminalPanel(panel)
          return () => {
            if (!stopped) setTerminalPanel(undefined)
          }
        },
        open: () => {},
      },
    })
      .then((release) => {
        if (stopped) void release()
        else dispose = release
      })
      .catch((cause) => {
        if (!stopped)
          setTerminalPanel({
            id: 'builtin:terminal',
            title: '终端',
            icon: <TerminalSquare />,
            location: 'right',
            scope: 'session',
            render: () => (
              <p role="alert" className="p-4 text-sm text-destructive">
                无法加载终端：{String(cause)}
              </p>
            ),
          })
      })
    return () => {
      stopped = true
      void dispose?.()
    }
  }, [host])
  const [planRequest, setPlanRequest] = useState<{ sessionKey?: string; id: string; revision: number }>()
  const [selectedPlanId, setSelectedPlanId] = useState<string>()
  const chat = useAppSession(bridge, {
    hostId: hostId ?? hostAddress,
    onPlanSaved: (document, sessionKey) => {
      setSelectedPlanId(document.id)
      setPlanRequest({ id: document.id, revision: document.revision, sessionKey })
    },
  })
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (fileStore.hasDirty() || chat.hasUnstoredDraft()) event.preventDefault()
    }
    window.addEventListener('beforeunload', unload)
    return () => window.removeEventListener('beforeunload', unload)
  }, [fileStore, chat.hasUnstoredDraft])
  const active = serviceUI?.active ?? true
  const cwd = chat.connection.cwd
  const availableRightTabs: RightSidebarTab[] = []
  if (chat.chat.sessionEntries?.entries.length) availableRightTabs.push('session-tree')
  if (chat.chat.agents?.some((agent) => agent.parentAgentId && agent.rootSessionKey === chat.connection.sessionKey))
    availableRightTabs.push('subagents')
  if (chat.planDocuments.length) availableRightTabs.push('plan')
  const settings = useSettings(bridge, true, false, !serviceUI)
  const appearance = useSettings(serviceUI?.appearanceBridge ?? bridge, Boolean(serviceUI) && active, false)
  useEffect(
    () =>
      plugins.onChange(() => {
        void settings.refresh()
        void appearance.refresh()
      }),
    [plugins, settings.refresh, appearance.refresh],
  )
  const pluginPanels = useSyncExternalStore(registry.subscribe, registry.getPanels, registry.getPanels)
  const panelRequest = useSyncExternalStore(registry.subscribe, registry.getPanelRequest, registry.getPanelRequest)
  const refreshPlugins = useCallback(async () => {
    setPluginDescriptors(await plugins.list())
    await chat.refreshUiPlugins()
  }, [plugins, chat.refreshUiPlugins])
  useEffect(() => {
    const refresh = () => void refreshPlugins().catch((cause) => chat.setError(`无法读取插件列表：${String(cause)}`))
    refresh()
    const off = plugins.onChange(refresh)
    return off
  }, [plugins, refreshPlugins, chat.setError])
  useEffect(() => {
    if (!chat.navigationBusy) void registry.synchronize(chat.uiPlugins ?? pluginDescriptors)
  }, [registry, pluginDescriptors, chat.uiPlugins, chat.navigationBusy])
  useEffect(
    () => () => {
      void registry.dispose()
    },
    [registry],
  )
  useEffect(
    () =>
      resources.onChange(() => {
        void chat.refreshSnapshot()
      }),
    [resources, chat.refreshSnapshot],
  )
  const [resolvedSession, setResolvedSession] = useState<{ key: string; value: AppSession }>()
  const runtimeSessionKey = chat.connection.sessionKey
  useEffect(() => {
    let current = true
    setResolvedSession(undefined)
    if (runtimeSessionKey)
      void bridge
        .resolveAppSession(runtimeSessionKey)
        .then((value) => {
          if (current) {
            chat.bindDraftSession(runtimeSessionKey, value.sessionId)
            setResolvedSession({ key: runtimeSessionKey, value })
          }
        })
        .catch((cause) => {
          if (current) chat.setError(String(cause))
        })
    return () => {
      current = false
    }
  }, [bridge, runtimeSessionKey, chat.bindDraftSession, chat.setError])
  const appSession = resolvedSession && resolvedSession.key === runtimeSessionKey ? resolvedSession.value : undefined
  const agentPluginSelection = useAgentPluginSelection({
    host,
    session: appSession,
    plugins: pluginDescriptors,
    resources,
    cwd,
    pluginMentions: chat.pluginMentions,
    onPluginMentions: chat.setPluginMentions,
    busy: Boolean(chat.busy || chat.chat.paused || chat.chat.queuePaused),
    onChanged: chat.refreshSnapshot,
    onError: chat.setError,
  })
  const agentPlugins = agentPluginSelection.ids
  const pluginProps: UiContributionProps = useMemo(
    () => ({
      host,
      target: sessionUiTarget(hostId ?? '', appSession),
      snapshot:
        chat.state && appSession
          ? {
              status: chat.connection.status,
              running: chat.chat.running,
              agentPlugins,
              messages: chat.chat.messages.map((message) => ({ role: message.role, text: messageText(message) })),
            }
          : null,
    }),
    [
      host,
      hostId,
      appSession,
      agentPlugins,
      chat.connection.sessionKey,
      chat.connection.status,
      chat.state,
      chat.chat.running,
      chat.chat.messages,
    ],
  )
  useEffect(() => {
    registry.updateTarget({ target: pluginProps.target, snapshot: pluginProps.snapshot })
  }, [registry, pluginProps])
  useEffect(() => {
    if (
      systemRequest &&
      (systemRequest.target.hostId !== pluginProps.target.hostId ||
        systemRequest.target.session?.sessionId !== pluginProps.target.session?.sessionId ||
        systemRequest.target.project?.projectId !== pluginProps.target.project?.projectId)
    )
      setSystemRequest(undefined)
  }, [systemRequest, pluginProps.target])
  const extra = (slot: UiPluginSlot, props: Record<string, unknown> = {}) => (
    <PluginSlot registry={registry} slot={slot} props={{ ...pluginProps, ...props }} />
  )
  const workspacePickerReturnFocus = useRef<HTMLElement | null>(null)
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sidebarWidth, setSidebarWidth] = useState(256)
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null)
  const settingsOpen = settingsSection !== null
  const searchActive = Boolean(serviceUI?.active) && !settingsOpen
  const openSearch = serviceUI?.onSearch
  useEffect(() => {
    if (!searchActive || !openSearch) return
    const handleKey = (event: KeyboardEvent) => {
      if (
        !event.isComposing &&
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === 'k' &&
        !document.querySelector('[role="dialog"]')
      ) {
        event.preventDefault()
        openSearch()
      }
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [searchActive, openSearch])
  const [instructionsDirty, setInstructionsDirty] = useState(false)
  const [instructionsSaving, setInstructionsSaving] = useState(false)
  const assertRestartAllowed = () => {
    if (fileStore.hasDirty() || instructionsDirty || instructionsSaving)
      throw new Error('仍有未保存的文件或指令，请先保存后再维护存储')
    if (chat.hasDraftInput()) throw new Error('仍有未发送的草稿或附件，请先处理后再维护存储')
  }
  useEffect(() => {
    serviceUI?.onController(serviceUI.serviceId, {
      ...chat,
      openSettings: () => setSettingsSection('general'),
      assertRestartAllowed,
    })
  })
  const [preferredApp, setPreferredApp] = useState<ProjectApp['id']>('finder')
  const ready = chat.connection.status === 'ready' || chat.connection.status === 'idle'
  const bootComplete = !chat.loading && (ready || chat.connection.status === 'disconnected' || Boolean(chat.error))
  useEffect(() => {
    if (active && bootComplete) onBootComplete?.()
  }, [active, bootComplete, onBootComplete])
  const project =
    chat.connection.workspaceKind === 'standalone'
      ? '不在项目中工作'
      : (chat.connection.sourceProjectCwd ?? chat.connection.cwd)
        ? (chat.connection.sourceProjectCwd ?? chat.connection.cwd).split(/[\\/]/).filter(Boolean).at(-1) || '选择项目'
        : 'pi-meme'
  const first = chat.chat.messages.find((message) => message.role === 'user')
  const status = chat.chat.running
    ? '正在运行'
    : ready
      ? '已连接'
      : chat.connection.status === 'connecting'
        ? '连接中'
        : '未连接'
  const title =
    ready || Boolean(chat.connection.sessionKey)
      ? chat.state?.sessionName || (first ? messageText(first).split('\n')[0].slice(0, 32) : '') || '新会话'
      : status

  // 分叉来源使用会话元数据里的 parentSession 路径，按路径查标题，避免同名混淆。
  const sessionList = chat.sessions
    ? [
        ...chat.sessions.recents,
        ...chat.sessions.projects.flatMap((group) => group.sessions),
        ...(chat.sessions.standaloneSessions ?? []),
      ]
    : []
  const activeSummary = sessionList.find((session) => session.path === chat.sessions?.activeSessionPath)
  const showWorkspaceSlot =
    ready &&
    !chat.loading &&
    !chat.navigationBusy &&
    Boolean(chat.state) &&
    !chat.connection.sessionFile &&
    !activeSummary &&
    !chat.chat.messages.length &&
    !chat.chat.running
  const sourcePath = activeSummary?.parentSessionPath
  const sourceSummary = sourcePath ? sessionList.find((session) => session.path === sourcePath) : undefined
  const forkedFrom =
    sourcePath && sourceSummary
      ? { path: sourcePath, title: formatSessionTitle(sourceSummary) }
      : sourcePath
        ? { path: sourcePath, title: sourcePath.split(/[\\/]/).pop() || '来源会话' }
        : undefined
  const forkSourcePath = chat.forkNotice?.sourcePath
  const forkSourceSummary = forkSourcePath ? sessionList.find((session) => session.path === forkSourcePath) : undefined
  const forkSourceTitle = forkSourcePath
    ? forkSourceSummary
      ? formatSessionTitle(forkSourceSummary)
      : forkSourcePath.split(/[\\/]/).pop() || '来源会话'
    : undefined

  useEffect(() => {
    if (settings.snapshot?.settings.preferredProjectApp) setPreferredApp(settings.snapshot.settings.preferredProjectApp)
  }, [settings.snapshot?.settings.preferredProjectApp])

  useEffect(() => {
    if (active) document.title = chat.extensionTitle || title
  }, [chat.extensionTitle, title, active])

  const projectSelector = (
    <ProjectSelector
      {...{
        cwd: chat.connection.sourceProjectCwd ?? chat.connection.cwd,
        kind: chat.connection.workspaceKind,
        open: workspacePickerOpen,
        onOpenChange: (open) => {
          if (open) workspacePickerReturnFocus.current = null
          setWorkspacePickerOpen(open)
        },
        returnFocus: workspacePickerReturnFocus.current,
        disabledReason: chat.workspaceDisabledReason,
        loadProjects: bridge.getProjects,
        onSelect: chat.selectWorkspace,
        onAdd: chat.chooseDirectory,
        onError: chat.setError,
      }}
    />
  )
  const interaction = chat.extensionDialogs[0]
  const interactionSourceName =
    interaction?.source?.agentId && interaction.source.rootSessionKey !== interaction.sessionKey
      ? interaction.source.name
      : undefined
  const composerProps: ComponentProps<typeof Composer> = {
    compact: interaction?.method === 'questions',
    mode: chat.mode,
    onMode: chat.changeMode,
    onPlanCommand: chat.activatePlan,
    recoveredInputs: chat.recoveredInputs,
    onRestoreQueuedInput: chat.restoreQueuedInput,
    sessionKey: chat.connection.sessionKey,
    projectPath: chat.connection.cwd,
    loadProjectFiles: bridge.getProjectFiles,
    access: (
      <AgentAccessSelector
        {...{
          mode: chat.connection.accessMode,
          cwd: chat.connection.cwd,
          busy: chat.accessBusy,
          supported: chat.connection.restrictedAccessSupported === true,
          reason: chat.connection.restrictedAccessReason,
          onChange: (mode) => void chat.setAccessMode(mode),
          compact: interaction?.method === 'questions',
        }}
      />
    ),
    selectedSkills: chat.selectedSkills,
    onSkills: chat.setSelectedSkills,
    agentPlugins: agentPluginSelection,
    draft: chat.draft,
    onDraft: chat.setDraft,
    hint: chat.composerHint,
    onAcceptHint: chat.acceptComposerHint,
    onDismissHint: chat.dismissComposerHint,
    attachments: chat.attachments,
    onAddImages: (images) => chat.setAttachments((value) => [...value, ...images]),
    onRemoveImage: (id) => chat.setAttachments((value) => value.filter((image) => image.id !== id)),
    running: chat.chat.running,
    paused: chat.chat.paused || chat.chat.queuePaused,
    activeMode: chat.chat.activeMode,
    editingQueue: chat.editingQueue !== null,
    onResume: () => void chat.resume(),
    onSteerQueueInput: (id) => void chat.steerQueueInput(id),
    onDeleteQueueInput: (id) => void chat.deleteQueueInput(id),
    onEditQueueInput: (id) => void chat.editQueueInput(id),
    disabled: !ready || chat.inputDisabled || chat.savingQueue,
    queueMode: chat.queueMode,
    onQueueMode: chat.setQueueMode,
    steeringMode: chat.state?.steeringMode,
    followUpMode: chat.state?.followUpMode,
    onSteeringMode: chat.setSteeringMode,
    onFollowUpMode: chat.setFollowUpMode,
    queues: { steering: chat.chat.steering, followUp: chat.chat.followUp },
    onSend: () => void chat.send(),
    onStop: () => void chat.stop(),
    onClearQueue: () => void chat.clearQueue(),
    editing: chat.editing,
    onCancelEdit: chat.cancelEdit,
    commands: chat.commands,
    widgetsAbove: (
      <>
        <ExtensionWidgets {...{ widgets: chat.extensionWidgets, placement: 'aboveEditor' }} />
        {extra('composer')}
      </>
    ),
    widgetsBelow: (
      <>
        <ExtensionWidgets {...{ widgets: chat.extensionWidgets, placement: 'belowEditor' }} />
        {extra('composer-actions')}
      </>
    ),
    statusBadges: (
      <>
        <ExtensionStatusBadges {...{ statuses: chat.extensionStatuses }} />
        {extra('status')}
      </>
    ),
    focusVersion: chat.draftFocusVersion,
    onError: chat.setError,
    contextUsage: <ContextUsageRing {...{ stats: chat.sessionStats }} />,
    model: (
      <ModelPickerPopover
        {...{
          models: chat.models,
          currentModel: chat.state?.model,
          thinkingLevel: chat.state?.thinkingLevel,
          availableThinkingLevels: chat.thinkingLevels,
          disabled: chat.modelPickerDisabled,
          onSelectModel: (model) => void chat.selectModel(model),
          onSelectThinkingLevel: (level) => void chat.selectThinkingLevel(level),
        }}
      />
    ),
  }

  // 原位置编辑期间，底部输入区只保留说明，避免两个含义不明的输入区。
  const composer = chat.editing ? (
    <div data-testid="editing-hint" className="px-3 py-2 text-center text-xs text-muted-foreground/70">
      正在编辑历史消息
    </div>
  ) : (
    <div data-testid="composer-area">
      <div
        data-testid="workspace-card"
        className={
          showWorkspaceSlot
            ? 'relative mx-3 -mb-2 flex h-12 min-w-0 items-center justify-between gap-1 rounded-t-[14px] border border-border/80 bg-card/95 px-1.5 pb-2'
            : 'hidden'
        }
      >
        <div className="flex min-w-0 flex-1 items-center gap-1">
          {projectSelector}
          {serviceUI && (
            <LocationSelector
              services={serviceUI.services}
              serviceId={serviceUI.serviceId}
              disabledReason={chat.workspaceDisabledReason}
              onSelect={serviceUI.onLocation}
              onError={chat.setError}
            />
          )}
        </div>
        {chat.connection.workspaceKind !== 'standalone' && chat.connection.cwd && (
          <GitMenu
            bridge={bridge}
            sessionKey={chat.connection.sessionKey}
            refreshToken={chat.refreshToken}
            disabledReason={chat.workspaceDisabledReason}
            onSwitch={chat.switchGitBranch}
            onCreateBranch={chat.createGitBranch}
            onCreateWorktree={chat.createGitWorktree}
          />
        )}
      </div>
      <div className="relative z-10">
        {interaction?.method === 'questions' && (
          <UserInputPanel
            key={interaction.id}
            request={interaction}
            sourceName={interactionSourceName}
            onRespond={chat.answerExtensionDialog}
            draft={chat.getQuestionDraft(interaction.id)}
            onDraft={(draft) => chat.saveQuestionDraft(interaction.id, draft)}
          />
        )}
        <Composer {...composerProps} />
      </div>
      {chat.workspaceNotice && (
        <p role="status" className="px-3 text-xs text-muted-foreground">
          {chat.workspaceNotice}
        </p>
      )}
    </div>
  )

  const editor =
    chat.editing && chat.editingTimestamp !== null
      ? {
          timestamp: chat.editingTimestamp,
          projectPath: chat.connection.cwd,
          loadProjectFiles: bridge.getProjectFiles,
          draft: chat.draft,
          onDraft: chat.setDraft,
          selectedSkills: chat.selectedSkills,
          onSkills: chat.setSelectedSkills,
          attachments: chat.attachments,
          onAddImages: (images: (typeof chat.attachments)[number][]) =>
            chat.setAttachments((value) => [...value, ...images]),
          onRemoveImage: (id: string) => chat.setAttachments((value) => value.filter((image) => image.id !== id)),
          commands: chat.commands,
          focusVersion: chat.draftFocusVersion,
          disabled: !ready,
          onSubmit: () => void chat.send(),
          onCancel: chat.cancelEdit,
        }
      : undefined

  const sidebar = serviceUI?.sidebar ?? (
    <Sidebar
      {...{
        menuBridge: bridge,
        sidebarSettingsBridge: bridge,
        serviceId: hostId ?? 'local',
        searchEnabled: !settingsOpen && !serviceUI,
        searchHistory: bridge.searchSessions,
        onSelectProject: (cwd) => void chat.selectLocation({ kind: 'project', cwd }),
        onMenuChanged: chat.refreshMenu,
        onMenuDeleted: chat.applyMenuDeletion,
        projectName: project,
        cwd: chat.connection.sourceProjectCwd ?? chat.connection.cwd,
        ready,
        status,
        sessionsSnapshot: chat.sessions,
        sessionsLoading: chat.sessionsLoading,
        activeSessionId: chat.sessions?.activeSessionId,
        activeSessionPath: chat.sessions?.activeSessionPath,
        switchingToPath: chat.switchingToPath,
        onDirectory: () => void chat.chooseDirectory(),
        onNewSession: () => void chat.newSession(),
        onNewSessionInProject: (targetCwd) => void chat.newSessionInProject(targetCwd),
        onSwitchSession: (sessionPath) => void chat.switchSession(sessionPath),
        onTogglePin: (targetPath) => void chat.togglePin(targetPath),
        onPrefetchSession: (sessionPath) => void bridge.prefetchSession(sessionPath).catch(() => {}),
        onSettings: () => setSettingsSection('general'),
      }}
    />
  )
  const conversation = (
    <WorkspaceContent
      chat={chat.chat}
      connection={chat.connection}
      ready={ready}
      hasConnected={chat.hasConnected || Boolean(chat.connection.sessionKey)}
      composer={composer}
      conversation={
        <Conversation
          {...{
            chat: chat.chat,
            stream: chat.chatStream,
            canEditMessages: !chat.busy && !chat.navigationBusy && !chat.editing,
            onEditMessage: chat.editMessage,
            onSwitchMessageVersion: (timestamp, version) => void chat.switchMessageVersion(timestamp, version),
            onForkReply: (timestamp) => void chat.forkReply(timestamp),
            onCopyError: chat.setError,
            editor,
            switchingVersion: chat.switchingVersion,
          }}
        />
      }
      canEditMessages={!chat.busy && !chat.navigationBusy && !chat.editing}
      onEditMessage={chat.editMessage}
      onSwitchMessageVersion={(timestamp, version) => void chat.switchMessageVersion(timestamp, version)}
      onForkReply={(timestamp) => void chat.forkReply(timestamp)}
      onCopyError={chat.setError}
      onSettings={() => setSettingsSection('general')}
      onSelectProject={(trigger) => {
        if (workspacePickerOpen && workspacePickerReturnFocus.current === trigger) {
          setWorkspacePickerOpen(false)
        } else {
          workspacePickerReturnFocus.current = trigger ?? null
          setWorkspacePickerOpen(true)
        }
      }}
      projectSelectorOpen={workspacePickerOpen}
      editor={editor}
      switchingVersion={chat.switchingVersion}
      notice={
        <>
          <ErrorNotice
            message={chat.error || settings.error}
            onOpenSettings={() => {
              chat.setError('')
              settings.dismissError()
              setSettingsSection('general')
            }}
            onDismiss={() => {
              chat.setError('')
              settings.dismissError()
            }}
          />
          <ErrorNotice
            message={chat.extensionError?.message ?? ''}
            extension
            onOpenSettings={() => setSettingsSection('general')}
            onDismiss={chat.dismissExtensionError}
          />
          <ExtensionNotices {...{ notices: chat.extensionNotices, onDismiss: chat.dismissNotice }} />
        </>
      }
    >
      <ForkNotice
        forking={chat.forking}
        sourcePath={chat.forkNotice?.sourcePath}
        sourceTitle={forkSourceTitle}
        onOpenSource={(path) => void chat.openForkSource(path)}
        onDismiss={chat.dismissForkNotice}
      />
    </WorkspaceContent>
  )
  const panels: UiPanel[] = [
    {
      id: 'builtin:git',
      title: '变更',
      icon: <FileDiff />,
      location: 'right',
      scope: 'session',
      render: (props) =>
        props.target.session ? (
          <GitPanel
            key={JSON.stringify(props.target.session)}
            cwd={appSession?.cwd ?? cwd}
            bridge={{
              getGitSnapshot: () => host.git.snapshot(props.target.session!),
              getGitDiff: (path, kind) =>
                host.git.diff(props.target.session!, { path, staged: kind === 'staged', kind }),
            }}
            refreshToken={chat.refreshToken}
            turnChanges={collectTurnChanges(chat.chat.messages, chat.chat.tools)}
          />
        ) : null,
    },
    {
      id: 'builtin:files',
      title: '文件',
      icon: <Folder />,
      location: 'right',
      scope: 'session',
      render: (props) => <FilesPanel store={fileStore} target={props.target} />,
    },
    terminalPanel ?? {
      id: 'builtin:terminal',
      title: '终端',
      icon: <TerminalSquare />,
      location: 'right',
      scope: 'session',
      render: () => (
        <p role="status" className="p-4 text-sm text-muted-foreground">
          正在读取终端配置…
        </p>
      ),
    },
    ...(availableRightTabs.includes('subagents')
      ? [
          {
            id: 'builtin:subagents',
            title: '子代理',
            icon: <Network />,
            location: 'right' as const,
            scope: 'session' as const,
            render: () => (
              <SubagentsPanel
                key={chat.connection.sessionKey}
                bridge={bridge}
                sessionKey={chat.connection.sessionKey}
              />
            ),
          },
        ]
      : []),
    ...(availableRightTabs.includes('plan')
      ? [
          {
            id: 'builtin:plan',
            title: '计划',
            icon: <NotebookPen />,
            location: 'right' as const,
            scope: 'session' as const,
            render: () => (
              <PlanPanel
                documents={chat.planDocuments}
                selectedId={selectedPlanId}
                onSelect={setSelectedPlanId}
                continueDisabled={chat.busy || chat.editing || Boolean(chat.editingQueue)}
                onContinue={(document) => {
                  if (chat.busy || chat.editing || chat.editingQueue) return
                  chat.setDraft(planExecutionDraft(chat.draft, document))
                  chat.changeMode('default')
                  chat.focusDraft()
                }}
              />
            ),
          },
        ]
      : []),
    ...(availableRightTabs.includes('session-tree')
      ? [
          {
            id: 'builtin:session-tree',
            title: '会话树',
            icon: <ListTree />,
            location: 'right' as const,
            scope: 'session' as const,
            render: () => (
              <SessionTreePanel
                sessionEntries={chat.chat.sessionEntries}
                onSwitchVersion={(timestamp, version) => void chat.switchMessageVersion(timestamp, version)}
              />
            ),
          },
        ]
      : []),
    ...pluginPanels,
  ]
  const handleSidebar = useCallback((open: boolean, width: number) => {
    setSidebarOpen(open)
    setSidebarWidth(width)
  }, [])
  function invokeSystemSkill(name: string, prompt?: string) {
    const command = chat.commands.find((entry) => entry.source === 'skill' && entry.name === `skill:${name}`)
    if (!command) return false
    chat.setSelectedSkills([...chat.selectedSkills, command])
    chat.setDraft(appendSkillInvocation(chat.draft, prompt))
    setSettingsSection(null)
    return true
  }
  if (!active) return null

  return (
    <PluginRenderers registry={registry} props={pluginProps}>
      <TooltipProvider delayDuration={200}>
        <main
          data-active-service={serviceUI?.serviceId ?? 'local'}
          className="theme-app flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground select-none"
        >
          <div className={settingsOpen ? 'hidden' : 'flex flex-1 min-h-0 flex-col'} inert={settingsOpen}>
            <WorkspacePanels
              panels={panels}
              errors={registry.errors()}
              props={pluginProps}
              session={appSession?.sessionId ?? runtimeSessionKey ?? ''}
              runtimeSession={runtimeSessionKey ?? ''}
              sidebar={sidebar}
              sidebarOpen={sidebarOpen}
              sidebarWidth={sidebarWidth}
              requestPanel={systemRequest ?? panelRequest}
              onPanelRequestHandled={(revision) => {
                if (systemRequest) setSystemRequest(undefined)
                else registry.consumePanelRequest(revision)
              }}
              requestRight={planRequest && planRequest.sessionKey === runtimeSessionKey ? 'builtin:plan' : undefined}
              requestRightToken={planRequest ? `${planRequest.id}:${planRequest.revision}` : undefined}
              onRightRequestHandled={() => setPlanRequest(undefined)}
              onSidebar={handleSidebar}
              onSettings={() => setSettingsSection('general')}
              onUsage={() => setSettingsSection('profile')}
              onAccount={() => setSettingsSection('account')}
              onNewSession={() => void chat.newSession()}
              onPlugins={() => setSettingsSection('plugins')}
              header={(toggleSidebar) => (
                <AppHeader
                  nativeWindow={nativeWindow}
                  canOpenProject={localPlatform}
                  loadProjectApps={bridge.getProjectApps}
                  sidebarOpen={sidebarOpen}
                  onToggleSidebar={toggleSidebar}
                  busy={Boolean(chat.workspaceDisabledReason)}
                  cwd={chat.connection.cwd}
                  directoryDisabledReason={chat.workspaceDisabledReason}
                  onDirectory={(trigger) => {
                    workspacePickerReturnFocus.current = trigger ?? null
                    setWorkspacePickerOpen(true)
                  }}
                  project={project}
                  title={title}
                  sessionName={chat.state?.sessionName}
                  onOpenProject={(app) => void bridge.openProject(app).catch((cause) => chat.setError(String(cause)))}
                  preferredApp={preferredApp}
                  onPreferredApp={(app) => {
                    setPreferredApp(app)
                    void bridge.setPreferredProjectApp(app).catch((cause) => chat.setError(String(cause)))
                  }}
                  forkedFrom={forkedFrom}
                  onOpenForkSource={(path) => void chat.openForkSource(path)}
                />
              )}
            >
              {conversation}
            </WorkspacePanels>
          </div>

          {/* 设置页面 */}
          {settingsSection && (
            <SettingsPage
              initialSection={settingsSection}
              dirty={instructionsDirty}
              saving={instructionsSaving}
              nativeWindow={nativeWindow}
              onDiscard={() => setInstructionsDirty(false)}
              onDismiss={() => setSettingsSection(null)}
              renderContent={(section) => {
                const contentProps: Omit<ComponentProps<typeof SettingsContent>, 'section'> = {
                  bridge,
                  cwd: chat.connection.cwd,
                  busy: chat.busy || chat.connection.status === 'connecting',
                  snapshot: settings.snapshot,
                  piVersion: chat.connection.piVersion,
                  error: settings.error,
                  onDirty: setInstructionsDirty,
                  onSaving: setInstructionsSaving,
                  onBeforeRestart: async () => {
                    if (serviceUI) serviceUI.beforeRestart()
                    else assertRestartAllowed()
                    await settings.flushAppearance()
                    if (serviceUI) await appearance.flushAppearance()
                  },
                  accessSettings: (
                    <AccessSettings
                      value={settings.snapshot?.settings.defaultAccessMode}
                      supported={Boolean(chat.connection.restrictedAccessSupported)}
                      reason={chat.connection.restrictedAccessReason}
                      busy={chat.busy}
                      saving={settings.saving}
                      onSave={(mode) => void settings.saveAccessMode(mode)}
                    />
                  ),
                  onAppearance: settings.saveAppearance,
                  onPreview: settings.previewAppearance,
                  onFlush: settings.flushAppearance,
                  loadFonts: settings.getInstalledFonts,
                  onImport: () => void settings.importTheme(),
                  onExport: (theme) => void settings.exportTheme(theme),
                  onReload: () => void settings.reload(),
                  onOpenDirectory: () => void settings.openDirectory(),
                }

                if (section === 'host' && serviceUI) return serviceUI.remoteSettings
                if (section === 'host')
                  return (
                    <HostSettings
                      hostId={hostId}
                      address={hostAddress}
                      local={hostLocal}
                      onConnect={onHostConnection}
                      connections={hostConnections}
                      call={call}
                    />
                  )
                if (section === 'skills')
                  return (
                    <SkillPage
                      client={resources}
                      cwd={cwd}
                      commands={chat.commands}
                      skillUsages={chat.chat.skillUsages}
                      resourceSnapshot={chat.state?.resourceSnapshot}
                      onChanged={async () => {
                        await chat.refreshSnapshot()
                      }}
                      onUse={(command) => {
                        chat.setSelectedSkills([...chat.selectedSkills, command])
                        chat.setDraft(appendSkillInvocation(chat.draft))
                        setSettingsSection(null)
                      }}
                      onCreate={() => invokeSystemSkill('skill-creator')}
                    />
                  )
                if (section === 'plugins')
                  return (
                    <PluginPage
                      client={plugins}
                      plugins={pluginDescriptors}
                      errors={registry.errors()}
                      onChanged={async () => {
                        await refreshPlugins()
                        await chat.refreshSnapshot()
                      }}
                      onCreate={() => invokeSystemSkill('plugin-creator', '帮我创建一个插件')}
                      onOpenSystem={
                        appSession
                          ? (id) => {
                              setSettingsSection(null)
                              setSystemRequest({
                                id:
                                  id === '@pi-meme/git'
                                    ? 'builtin:git'
                                    : id === '@pi-meme/file-directory'
                                      ? 'builtin:files'
                                      : 'builtin:terminal',
                                revision: Date.now(),
                                target: pluginProps.target,
                              })
                            }
                          : undefined
                      }
                      renderSettings={(id) => (
                        <PluginSlot registry={registry} pluginId={id} slot="settings" props={pluginProps} />
                      )}
                    />
                  )
                if (
                  section === 'about' ||
                  section === 'appearance' ||
                  section === 'general' ||
                  section === 'instructions'
                )
                  return (
                    <SettingsContent
                      section={section}
                      {...contentProps}
                      {...(section === 'appearance' && serviceUI
                        ? {
                            snapshot: appearance.snapshot,
                            error: appearance.error,
                            onAppearance: appearance.saveAppearance,
                            onPreview: appearance.previewAppearance,
                            onFlush: appearance.flushAppearance,
                            loadFonts: appearance.getInstalledFonts,
                            onImport: () => void appearance.importTheme(),
                            onExport: (theme) => void appearance.exportTheme(theme),
                            onReload: () => void appearance.reload(),
                            onOpenDirectory: () => void appearance.openDirectory(),
                          }
                        : {})}
                    />
                  )
                if (section === 'models')
                  return <ModelConfigSettings {...{ busy: chat.modelPickerDisabled, bridge, models: chat.models }} />
                if (section === 'mcp')
                  return (
                    <McpSettings
                      {...{
                        bridge,
                        busy: chat.connection.status === 'connecting' || (chat.busy && ready),
                        saving: settings.saving,
                        mode: chat.connection.accessMode,
                        sessionKey: chat.connection.sessionKey,
                        capabilities: {
                          codemodeEnabled: Boolean(settings.snapshot?.settings.codemodeEnabled),
                          mcpEnabled: Boolean(settings.snapshot?.settings.mcpEnabled),
                        },
                        onCapabilities: (value) => void settings.saveCapabilities(value),
                      }}
                    />
                  )
                if (section === 'account') return <AccountSettings bridge={bridge} />
                if (section === 'profile') return <ProfileSettings {...{ loadUsage: bridge.getUsageStats }} />
                return null
              }}
            />
          )}

          {/* 扩展交互请求弹窗 */}
          {interaction && interaction.method !== 'questions' && (
            <ExtensionDialog
              key={interaction.id}
              {...{
                request: interaction,
                sourceName: interactionSourceName,
                onRespond: chat.answerExtensionDialog,
              }}
            />
          )}
        </main>
      </TooltipProvider>
    </PluginRenderers>
  )
}
