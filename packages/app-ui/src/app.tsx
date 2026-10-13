import { GitMenu } from '@pi-meme/git/ui/git-menu'
import { LocationSelector } from './location-selector'
import type { ServiceUI } from './service-ui'
import { DeveloperSettings } from './developer-settings'
import { SubagentsPanel } from './subagents-panel'
import { ProfileSettings } from '@pi-meme/usage/ui/profile-settings'
import { ResourceCenter } from './resource-center'
import { createResourceClient } from '@pi-meme/client/resource-client'
import { skillMarker } from '@pi-meme/contracts/skills'
import { ExtensionsSettings } from '@pi-meme/resources/ui/extensions-settings'
import { AccessSettings } from '@pi-meme/permissions/ui/access-settings'
import { AgentAccessSelector } from '@pi-meme/permissions/ui/agent-access-selector'
import { AppHeader } from './app-header'
import { ForkNotice } from './fork-notice'
import { WorkspaceContent } from './workspace-content'
import { ErrorNotice } from './error-notice'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentProps } from 'react'
import { Composer } from '@pi-meme/chat/ui/composer/composer'
import { Conversation } from '@pi-meme/chat/ui/conversation/conversation'
import { Sidebar } from '@pi-meme/workspace/ui/sidebar/sidebar'
import { ModelPickerPopover } from '@pi-meme/models/ui/model-picker-popover'
import { ModelConfigSettings } from '@pi-meme/models/ui/model-config/model-config-settings'
import { McpSettings } from '@pi-meme/mcp/ui/mcp-settings'
import { SettingsPage as SettingsContent } from '@pi-meme/settings/ui/settings-page'
import { ExtensionWidgets } from '@pi-meme/pi-extensions/ui/extension-widgets'
import { ExtensionStatusBadges } from '@pi-meme/pi-extensions/ui/extension-statuses'
import { ExtensionDialog } from '@pi-meme/pi-extensions/ui/extension-dialog'
import { UserInputPanel } from '@pi-meme/pi-extensions/ui/user-input-panel'
import { ExtensionNotices } from '@pi-meme/pi-extensions/ui/extension-notices'
import { GitPanel } from '@pi-meme/git/ui/git-panel'
import { ProjectSelector } from '@pi-meme/workspace/ui/project-selector'
import { formatSessionTitle } from '@pi-meme/workspace/ui/sidebar/session-title'
import { useAppSession } from './use-app-session'
import { messageText } from '@pi-meme/chat/ui/model/message-text'
import { ContextUsageRing } from '@pi-meme/models/ui/context-usage-ring'
import { useSettings } from '@pi-meme/settings/ui/use-settings'
import { TooltipProvider } from '@pi-meme/ui/components/ui/tooltip'
import { SessionTreePanel } from '@pi-meme/history/ui/session-tree-panel'
import { RightSidebar } from './right-sidebar'
import { PlanPanel } from './plan-panel'
import { ResizeHandle } from './resize-handle'
import type { RightSidebarTab } from './right-sidebar'
import type { PluginClient } from '@pi-meme/client/plugin-client'
import type { UiPluginDescriptor, UiPluginSlot } from '@pi-meme/plugin-sdk/ui'
import { PluginRenderers } from './plugin-renderers'
import { UiPluginRegistry } from './plugin-registry'
import { PluginSlot } from './plugin-slot'
import { PluginCenter } from './plugin-center'
import { SettingsPage } from './settings-page'
import { HostSettings } from './host-settings'
import { loadPluginUI } from './load-plugin-ui'
import type { DesktopBridge, ProjectApp } from '@pi-meme/contracts/desktop'

export function App({
  bridge,
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
}: {
  serviceUI?: ServiceUI
  bridge: DesktopBridge
  plugins: PluginClient
  call: <T>(method: string, args?: unknown[]) => Promise<T>
  nativeWindow?: boolean
  localPlatform?: boolean
  hostId?: string
  hostAddress?: string
  hostLocal?: boolean
  onHostConnection: () => void
  hostConnections?: ComponentProps<typeof HostSettings>['connections']
}) {
  const resources = useMemo(() => createResourceClient(call, plugins.onChange), [call, plugins])
  const [registry] = useState(() => new UiPluginRegistry(bridge, loadPluginUI, call))
  const [pluginDescriptors, setPluginDescriptors] = useState<UiPluginDescriptor[]>([])
  const [rightPaneOpen, setRightPaneOpen] = useState(false)
  const [rightPaneMounted, setRightPaneMounted] = useState(false)
  const [rightTab, setRightTab] = useState<RightSidebarTab>('git')
  const [selectedPlanId, setSelectedPlanId] = useState<string>()
  useEffect(() => {
    if (rightPaneOpen) {
      setRightPaneMounted(true)
      return
    }
    const timer = window.setTimeout(setRightPaneMounted, 260, false)
    return () => window.clearTimeout(timer)
  }, [rightPaneOpen])
  const chat = useAppSession(bridge, {
    onPlanSaved: (document) => {
      setSelectedPlanId(document.id)
      setRightTab('plan')
      setRightPaneOpen(true)
    },
  })
  const active = serviceUI?.active ?? true
  const [gitCwd, setGitCwd] = useState<string>()
  const cwd = chat.connection.cwd
  useEffect(() => {
    if (!active || !rightPaneOpen || !cwd) return
    let current = true
    void bridge
      .getGitSnapshot()
      .then((snapshot) => {
        if (current && snapshot.cwd === cwd) setGitCwd(snapshot.root ? cwd : undefined)
      })
      .catch(() => {
        if (current) setGitCwd(undefined)
      })
    return () => {
      current = false
    }
  }, [active, bridge, cwd, chat.refreshToken, rightPaneOpen])
  const availableRightTabs: RightSidebarTab[] = []
  if (gitCwd && gitCwd === cwd) availableRightTabs.push('git')
  if (chat.chat.sessionEntries?.entries.length) availableRightTabs.push('session-tree')
  if (chat.chat.agents?.some((agent) => agent.parentAgentId && agent.rootSessionKey === chat.connection.sessionKey))
    availableRightTabs.push('subagents')
  if (chat.planDocuments.length) availableRightTabs.push('plan')
  const activeRightTab = availableRightTabs.includes(rightTab) ? rightTab : availableRightTabs[0]
  const settings = useSettings(bridge, true, false, !serviceUI)
  const appearance = useSettings(serviceUI?.appearanceBridge ?? bridge, Boolean(serviceUI) && active, false)
  const contributions = useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot)
  const [selectedPage, setSelectedPage] = useState<string>()
  const pluginPages = contributions.filter((entry) => entry.slot === 'page')
  const activePage = pluginPages.find((entry) => entry.id === selectedPage)
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
  const pluginProps = {
    bridge,
    hostId,
    sessionId: chat.connection.sessionKey,
    snapshot: chat.state
      ? { connection: chat.connection, state: chat.state, messages: chat.chat.messages, models: chat.models }
      : null,
  }
  const extra = (slot: UiPluginSlot, props: Record<string, unknown> = {}) => (
    <PluginSlot registry={registry} slot={slot} props={{ ...pluginProps, ...props }} />
  )
  const workspacePickerReturnFocus = useRef<HTMLElement | null>(null)
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sidebarWidth, setSidebarWidth] = useState(256)
  const [settingsOpen, setSettingsOpen] = useState(false)
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
  useEffect(() => {
    serviceUI?.onController(serviceUI.serviceId, { ...chat, openSettings: () => setSettingsOpen(true) })
  })
  const [instructionsDirty, setInstructionsDirty] = useState(false)
  const [instructionsSaving, setInstructionsSaving] = useState(false)
  const [rightPaneWidth, setRightPaneWidth] = useState(352)
  const [resizingSide, setResizingSide] = useState<'left' | 'right' | null>(null)
  const [preferredApp, setPreferredApp] = useState<ProjectApp['id']>('finder')
  const ready = chat.connection.status === 'ready' || chat.connection.status === 'idle'
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
    draft: chat.draft,
    onDraft: chat.setDraft,
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
    widgetsBelow: <ExtensionWidgets {...{ widgets: chat.extensionWidgets, placement: 'belowEditor' }} />,
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

  if (!active) return null

  return (
    <PluginRenderers registry={registry} props={pluginProps}>
      <TooltipProvider delayDuration={200}>
        <main
          data-active-service={serviceUI?.serviceId ?? 'local'}
          className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground select-none"
        >
          <div className={settingsOpen ? 'hidden' : 'flex flex-1 min-h-0 flex-col'} inert={settingsOpen}>
            {/* 全局顶栏：横贯窗口顶部，统一交通灯安全区与操作工具栏 */}
            <AppHeader
              nativeWindow={nativeWindow}
              canOpenProject={localPlatform}
              loadProjectApps={bridge.getProjectApps}
              sidebarOpen={sidebarOpen}
              sidebarWidth={sidebarWidth}
              onToggleSidebar={() => setSidebarOpen((value) => !value)}
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
              rightPaneOpen={rightPaneOpen}
              onToggleRightPane={() => setRightPaneOpen((value) => !value)}
              forkedFrom={forkedFrom}
              onOpenForkSource={(path) => void chat.openForkSource(path)}
            />

            {/* 下方主体内容工作区 */}
            <div className="relative flex flex-1 min-h-0 w-full overflow-hidden">
              {/* 侧边栏 */}
              <div
                id="workspace-sidebar"
                aria-hidden={!sidebarOpen}
                inert={!sidebarOpen}
                style={{ width: sidebarOpen ? sidebarWidth : 0 }}
                className={`flex h-full shrink-0 flex-col overflow-hidden ${
                  resizingSide === 'left' ? '' : 'transition-[width] duration-250 ease-[cubic-bezier(0.22,1,0.36,1)]'
                }`}
              >
                <div className="min-h-0 flex-1 overflow-hidden">
                  {serviceUI?.sidebar ?? (
                    <Sidebar
                      {...{
                        menuBridge: bridge,
                        sidebarSettingsBridge: bridge,
                        serviceId: hostId ?? 'local',
                        searchEnabled: !settingsOpen && !serviceUI,
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
                        onSettings: () => setSettingsOpen(true),
                      }}
                    />
                  )}
                </div>
                {extra('sidebar')}
                {pluginPages.length > 0 && (
                  <nav aria-label="插件页面" className="shrink-0 space-y-1 border-t border-border p-2">
                    <button
                      type="button"
                      className="w-full rounded px-2 py-1 text-left text-xs hover:bg-secondary"
                      onClick={() => setSelectedPage(undefined)}
                    >
                      聊天
                    </button>
                    {pluginPages.map((page) => (
                      <button
                        key={page.id}
                        type="button"
                        aria-pressed={page.id === activePage?.id}
                        className="w-full rounded px-2 py-1 text-left text-xs hover:bg-secondary"
                        onClick={() => setSelectedPage(page.id)}
                      >
                        {page.title ?? page.id}
                      </button>
                    ))}
                  </nav>
                )}
              </div>
              {sidebarOpen && (
                <ResizeHandle
                  side="left"
                  width={sidebarWidth}
                  min={200}
                  max={420}
                  onResize={setSidebarWidth}
                  onDraggingChange={(dragging) => setResizingSide(dragging ? 'left' : null)}
                />
              )}

              {/* 工作区主舞台 */}
              {activePage ? (
                <section className="flex-1 min-w-0 overflow-auto p-4" aria-label={activePage.title ?? activePage.id}>
                  <PluginSlot registry={registry} contributionId={activePage.id} slot="page" props={pluginProps} />
                </section>
              ) : (
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
                        onSwitchMessageVersion: (timestamp, version) =>
                          void chat.switchMessageVersion(timestamp, version),
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
                  onSettings={() => setSettingsOpen(true)}
                  editor={editor}
                  switchingVersion={chat.switchingVersion}
                  notice={
                    <>
                      <ErrorNotice
                        message={chat.error || settings.error}
                        onOpenSettings={() => {
                          chat.setError('')
                          settings.dismissError()
                          setSettingsOpen(true)
                        }}
                        onDismiss={() => {
                          chat.setError('')
                          settings.dismissError()
                        }}
                      />
                      <ErrorNotice
                        message={chat.extensionError?.message ?? ''}
                        extension
                        onOpenSettings={() => setSettingsOpen(true)}
                        onDismiss={chat.dismissExtensionError}
                      />
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
              )}
              <div
                id="workspace-right-sidebar"
                aria-hidden={!rightPaneOpen}
                inert={!rightPaneOpen}
                style={{ width: rightPaneOpen ? rightPaneWidth + 1 : 0 }}
                className={`flex h-full shrink-0 overflow-hidden ${
                  resizingSide === 'right' ? '' : 'transition-[width] duration-250 ease-[cubic-bezier(0.22,1,0.36,1)]'
                }`}
              >
                {(rightPaneOpen || rightPaneMounted) && (
                  <>
                    <ResizeHandle
                      side="right"
                      width={rightPaneWidth}
                      min={280}
                      max={560}
                      onResize={setRightPaneWidth}
                      onDraggingChange={(dragging) => setResizingSide(dragging ? 'right' : null)}
                    />
                    <RightSidebar
                      tab={activeRightTab}
                      availableTabs={availableRightTabs}
                      onTab={setRightTab}
                      onClose={() => setRightPaneOpen(false)}
                      width={rightPaneWidth}
                    >
                      {activeRightTab === 'subagents' ? (
                        <SubagentsPanel
                          key={chat.connection.sessionKey}
                          bridge={bridge}
                          sessionKey={chat.connection.sessionKey}
                        />
                      ) : activeRightTab === 'plan' ? (
                        <PlanPanel
                          key={chat.connection.sessionKey}
                          documents={chat.planDocuments}
                          selectedId={selectedPlanId}
                          onSelect={setSelectedPlanId}
                        />
                      ) : activeRightTab === 'git' ? (
                        <GitPanel {...{ cwd: chat.connection.cwd, bridge, refreshToken: chat.refreshToken }} />
                      ) : activeRightTab === 'session-tree' ? (
                        <SessionTreePanel
                          {...{
                            sessionEntries: chat.chat.sessionEntries,
                            onSwitchVersion: (timestamp, version) => void chat.switchMessageVersion(timestamp, version),
                          }}
                        />
                      ) : (
                        <p className="px-3 py-5 text-center text-xs text-muted-foreground">
                          当前项目暂无可显示的内容。
                        </p>
                      )}
                    </RightSidebar>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* 扩展通知 Toast 堆栈 */}
          <ExtensionNotices {...{ notices: chat.extensionNotices, onDismiss: chat.dismissNotice }} />

          {/* 设置页面 */}
          {settingsOpen && (
            <SettingsPage
              dirty={instructionsDirty}
              saving={instructionsSaving}
              onDiscard={() => setInstructionsDirty(false)}
              onDismiss={() => setSettingsOpen(false)}
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
                if (section === 'plugins' || section === 'skills')
                  return (
                    <ResourceCenter
                      key={section}
                      client={resources}
                      plugins={plugins}
                      initialKind={section === 'skills' ? 'skill' : 'all'}
                      cwd={cwd}
                      commands={chat.commands}
                      skillUsages={chat.chat.skillUsages}
                      resourceSnapshot={chat.state?.resourceSnapshot}
                      onChanged={async () => {
                        await refreshPlugins()
                        await chat.refreshSnapshot()
                      }}
                      onUse={(command) => {
                        if (command.source === 'skill') {
                          chat.setSelectedSkills([...chat.selectedSkills, command])
                          chat.setDraft(`${chat.draft}${chat.draft ? ' ' : ''}${skillMarker} `)
                        } else chat.setDraft(`${chat.draft}${chat.draft ? ' ' : ''}/${command.name} `)
                        setSettingsOpen(false)
                      }}
                      renderPluginSettings={(id) => (
                        <PluginSlot registry={registry} pluginId={id} slot="settings" props={pluginProps} />
                      )}
                    />
                  )
                if (section === 'general' || section === 'appearance' || section === 'personalization')
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
                if (section === 'profile') return <ProfileSettings {...{ loadUsage: bridge.getUsageStats }} />
                if (section === 'extensions')
                  return (
                    <DeveloperSettings call={call}>
                      <ExtensionsSettings
                        mode={chat.connection.accessMode}
                        busy={chat.busy}
                        onOpen={() => void settings.openExtensionsDirectory()}
                      />
                      <SettingsContent section="personalization" advanced {...contentProps} />
                      <PluginCenter
                        developer
                        client={plugins}
                        plugins={pluginDescriptors}
                        errors={registry.errors()}
                        onRefresh={refreshPlugins}
                        renderSettings={(id) => (
                          <PluginSlot registry={registry} pluginId={id} slot="settings" props={pluginProps} />
                        )}
                      />
                    </DeveloperSettings>
                  )
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
