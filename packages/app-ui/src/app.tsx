import type { ProfileSettings } from '@pi-meme/usage/ui/profile-settings'
import type { SkillsSettings } from '@pi-meme/resources/ui/skills-settings'
import type { ExtensionsSettings } from '@pi-meme/resources/ui/extensions-settings'
import type { AccessSettings } from '@pi-meme/permissions/ui/access-settings'
import type { ToolExecutionSettingsPanel } from '@pi-meme/codemode/ui/tool-execution-settings'
import type { SubagentsSettings } from '@pi-meme/subagents/ui/subagents-settings'
import type { AgentAccessSelector } from '@pi-meme/permissions/ui/agent-access-selector'
import { AppHeader } from './app-header'
import { ForkNotice } from './fork-notice'
import { WorkspaceContent } from './workspace-content'
import { ErrorNotice } from './error-notice'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ComponentProps } from 'react'
import type { Composer } from '@pi-meme/chat/ui/composer/composer'
import type { Conversation } from '@pi-meme/chat/ui/conversation/conversation'
import type { Sidebar } from '@pi-meme/workspace/ui/sidebar/sidebar'
import type { ModelPickerPopover } from '@pi-meme/models/ui/model-picker-popover'
import type { ModelConfigSettings } from '@pi-meme/models/ui/model-config/model-config-settings'
import type { McpSettings } from '@pi-meme/mcp/ui/mcp-settings'
import type { SettingsPage as SettingsContent } from '@pi-meme/settings/ui/settings-page'
import type { ExtensionWidgets } from '@pi-meme/pi-extensions/ui/extension-widgets'
import type { ExtensionStatusBadges } from '@pi-meme/pi-extensions/ui/extension-statuses'
import type { ExtensionDialog } from '@pi-meme/pi-extensions/ui/extension-dialog'
import type { ExtensionNotices } from '@pi-meme/pi-extensions/ui/extension-notices'
import type { GitPanel } from '@pi-meme/git/ui/git-panel'
import type { ProjectSelector } from '@pi-meme/workspace/ui/project-selector'
import { formatSessionTitle } from '@pi-meme/workspace/ui/sidebar/session-title'
import { useAppSession } from './use-app-session'
import { messageText } from '@pi-meme/chat/ui/model/message-text'
import type { ContextUsageRing } from '@pi-meme/models/ui/context-usage-ring'
import { useSettings } from '@pi-meme/settings/ui/use-settings'
import { TooltipProvider } from '@pi-meme/ui/components/ui/tooltip'
import type { SessionTreePanel } from '@pi-meme/history/ui/session-tree-panel'
import { RightSidebar } from './right-sidebar'
import { ResizeHandle } from './resize-handle'
import type { RightSidebarTab } from './right-sidebar'
import type { PluginClient } from '@pi-meme/client/plugin-client'
import type { UiPluginDescriptor, UiPluginSlot } from '@pi-meme/plugin-sdk/ui'
import { PluginToolCardProvider } from '@pi-meme/ui/components/plugin-tool-card'
import { UiPluginRegistry } from './plugin-registry'
import { PluginSlot } from './plugin-slot'
import { PluginCenter } from './plugin-center'
import { SettingsPage } from './settings-page'
import { HostSettings } from './host-settings'
import { loadPluginUI } from './load-plugin-ui'
import type { DesktopBridge, ProjectApp } from '@pi-meme/contracts/desktop'

type BuiltinData = {
  profileProps?: ComponentProps<typeof ProfileSettings>
  skillsProps?: ComponentProps<typeof SkillsSettings>
  extensionsProps?: ComponentProps<typeof ExtensionsSettings>
  defaultAccessProps?: ComponentProps<typeof AccessSettings>
  toolsProps?: ComponentProps<typeof ToolExecutionSettingsPanel>
  subagentsProps?: ComponentProps<typeof SubagentsSettings>
  accessProps?: ComponentProps<typeof AgentAccessSelector>
  projectSelectorProps?: ComponentProps<typeof ProjectSelector>
  contextProps?: ComponentProps<typeof ContextUsageRing>
  composerProps?: ComponentProps<typeof Composer>
  sessionTreeProps?: ComponentProps<typeof SessionTreePanel>
  conversationProps?: ComponentProps<typeof Conversation>
  sidebarProps?: ComponentProps<typeof Sidebar>
  modelPickerProps?: ComponentProps<typeof ModelPickerPopover>
  modelSettingsProps?: ComponentProps<typeof ModelConfigSettings>
  mcpSettingsProps?: ComponentProps<typeof McpSettings>
  settingsProps?: ComponentProps<typeof SettingsContent>
  widgetProps?: ComponentProps<typeof ExtensionWidgets>
  statusProps?: ComponentProps<typeof ExtensionStatusBadges>
  dialogProps?: ComponentProps<typeof ExtensionDialog>
  dialogKey?: string
  noticesProps?: ComponentProps<typeof ExtensionNotices>
  gitProps?: ComponentProps<typeof GitPanel>
}

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
}: {
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
  const [registry] = useState(() => new UiPluginRegistry(bridge, loadPluginUI, call))
  const [pluginDescriptors, setPluginDescriptors] = useState<UiPluginDescriptor[]>([])
  const enabled = (id: string) => pluginDescriptors.some((plugin) => plugin.id === `@pi-meme/${id}` && plugin.enabled)
  const chat = useAppSession(bridge, { chatEnabled: enabled('chat'), workspaceEnabled: enabled('workspace') })
  const settings = useSettings(bridge, enabled('settings'), enabled('subagents'))
  const contributions = useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot)
  const [selectedPage, setSelectedPage] = useState<string>()
  const pluginPages = contributions.filter((entry) => entry.slot === 'page' && !registry.isBuiltin(entry.id))
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
  const pluginProps = {
    bridge,
    hostId,
    sessionId: chat.connection.sessionKey,
    snapshot: chat.state
      ? { connection: chat.connection, state: chat.state, messages: chat.chat.messages, models: chat.models }
      : null,
  }
  const builtin = (id: string, slot: UiPluginSlot, area: string, data: BuiltinData) => (
    <PluginSlot registry={registry} pluginId={`@pi-meme/${id}`} slot={slot} props={{ ...pluginProps, area, ...data }} />
  )
  const extra = (slot: UiPluginSlot, props: Record<string, unknown> = {}) => (
    <PluginSlot registry={registry} externalOnly slot={slot} props={{ ...pluginProps, ...props }} />
  )
  const workspacePickerReturnFocus = useRef<HTMLElement | null>(null)
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sidebarWidth, setSidebarWidth] = useState(256)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [instructionsDirty, setInstructionsDirty] = useState(false)
  const [instructionsSaving, setInstructionsSaving] = useState(false)
  const [rightPaneOpen, setRightPaneOpen] = useState(false)
  const [rightTab, setRightTab] = useState<RightSidebarTab>('git')
  const [rightPaneWidth, setRightPaneWidth] = useState(352)
  const [resizingSide, setResizingSide] = useState<'left' | 'right' | null>(null)
  const [preferredApp, setPreferredApp] = useState<ProjectApp['id']>('finder')
  const ready = chat.connection.status === 'ready' || chat.connection.status === 'idle'
  const project =
    chat.connection.workspaceKind === 'standalone'
      ? '不在项目中工作'
      : chat.connection.cwd
        ? chat.connection.cwd.split(/[\\/]/).filter(Boolean).at(-1) || '选择项目'
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
    document.title = chat.extensionTitle || title
  }, [chat.extensionTitle, title])

  const composerProps: ComponentProps<typeof Composer> = {
    workspace: builtin('workspace', 'composer', 'project', {
      projectSelectorProps: {
        cwd: chat.connection.cwd,
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
        notice: chat.workspaceNotice,
      },
    }),
    projectPath: chat.connection.cwd,
    loadProjectFiles: bridge.getProjectFiles,
    access: builtin('permissions', 'composer', 'access', {
      accessProps: {
        mode: chat.connection.accessMode,
        cwd: chat.connection.cwd,
        busy: chat.accessBusy,
        supported: chat.connection.restrictedAccessSupported === true,
        onChange: (mode) => void chat.setAccessMode(mode),
      },
    }),
    selectedSkills: chat.selectedSkills,
    onSkills: chat.setSelectedSkills,
    draft: chat.draft,
    onDraft: chat.setDraft,
    attachments: chat.attachments,
    onAddImages: (images) => chat.setAttachments((value) => [...value, ...images]),
    onRemoveImage: (id) => chat.setAttachments((value) => value.filter((image) => image.id !== id)),
    running: chat.chat.running,
    disabled: !ready || chat.inputDisabled,
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
        {builtin('pi-extensions', 'composer', 'above', {
          widgetProps: { widgets: chat.extensionWidgets, placement: 'aboveEditor' },
        })}
        {extra('composer')}
      </>
    ),
    widgetsBelow: builtin('pi-extensions', 'composer', 'below', {
      widgetProps: { widgets: chat.extensionWidgets, placement: 'belowEditor' },
    }),
    statusBadges: (
      <>
        {builtin('pi-extensions', 'status', 'status', { statusProps: { statuses: chat.extensionStatuses } })}
        {extra('status')}
      </>
    ),
    focusVersion: chat.draftFocusVersion,
    onError: chat.setError,
    contextUsage: builtin('models', 'status', 'context', { contextProps: { stats: chat.sessionStats } }),
    model: builtin('models', 'composer', 'model', {
      modelPickerProps: {
        models: chat.models,
        currentModel: chat.state?.model,
        thinkingLevel: chat.state?.thinkingLevel,
        availableThinkingLevels: chat.thinkingLevels,
        disabled: chat.modelPickerDisabled,
        onSelectModel: (model) => void chat.selectModel(model),
        onSelectThinkingLevel: (level) => void chat.selectThinkingLevel(level),
      },
    }),
  }

  // 原位置编辑期间，底部输入区只保留说明，避免两个含义不明的输入区。
  const composer = chat.editing ? (
    <div data-testid="editing-hint" className="px-3 py-2 text-center text-xs text-muted-foreground/70">
      正在编辑历史消息
    </div>
  ) : enabled('chat') ? (
    builtin('chat', 'composer', 'composer', { composerProps })
  ) : (
    <p className="py-3 text-center text-sm text-muted-foreground">聊天插件已停用，可在插件中心重新启用。</p>
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

  return (
    <PluginToolCardProvider render={(tool) => extra('tool-card', { tool })}>
      <TooltipProvider delayDuration={200}>
        <main className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground select-none">
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
              onShowGit={() => {
                setRightTab('git')
                setRightPaneOpen(true)
              }}
              rightPaneOpen={rightPaneOpen}
              onToggleRightPane={() => setRightPaneOpen((value) => !value)}
              rightTab={rightTab}
              onShowSessionTree={() => {
                setRightTab('session-tree')
                setRightPaneOpen(true)
              }}
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
                  resizingSide === 'left'
                    ? ''
                    : 'transition-[width] duration-250 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none'
                }`}
              >
                <div className="min-h-0 flex-1 overflow-hidden">
                  {builtin('workspace', 'sidebar', 'sidebar', {
                    sidebarProps: {
                      menuBridge: bridge,
                      onMenuChanged: chat.refreshMenu,
                      onMenuDeleted: chat.applyMenuDeletion,
                      projectName: project,
                      cwd: chat.connection.cwd,
                      ready,
                      status,
                      piVersion: chat.connection.piVersion,
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
                    },
                  })}
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
                  conversation={builtin('chat', 'page', 'chat', {
                    conversationProps: {
                      chat: chat.chat,
                      canEditMessages: !chat.busy && !chat.navigationBusy && !chat.editing,
                      onEditMessage: chat.editMessage,
                      onSwitchMessageVersion: (timestamp, version) =>
                        void chat.switchMessageVersion(timestamp, version),
                      onForkReply: (timestamp) => void chat.forkReply(timestamp),
                      onCopyError: chat.setError,
                      editor,
                      switchingVersion: chat.switchingVersion,
                    },
                  })}
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
              {rightPaneOpen && (
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
                    tab={rightTab}
                    onTab={setRightTab}
                    onClose={() => setRightPaneOpen(false)}
                    width={rightPaneWidth}
                  >
                    {rightTab === 'git'
                      ? builtin('git', 'page', 'git', {
                          gitProps: { cwd: chat.connection.cwd, bridge, refreshToken: chat.refreshToken },
                        })
                      : builtin('history', 'page', 'history', {
                          sessionTreeProps: {
                            sessionEntries: chat.chat.sessionEntries,
                            onSwitchVersion: (timestamp, version) => void chat.switchMessageVersion(timestamp, version),
                          },
                        })}
                  </RightSidebar>
                </>
              )}
            </div>
          </div>

          {/* 扩展通知 Toast 堆栈 */}
          {builtin('pi-extensions', 'page', 'notices', {
            noticesProps: { notices: chat.extensionNotices, onDismiss: chat.dismissNotice },
          })}

          {/* 设置页面 */}
          {settingsOpen && (
            <SettingsPage
              dirty={instructionsDirty}
              saving={instructionsSaving}
              onDiscard={() => setInstructionsDirty(false)}
              onDismiss={() => setSettingsOpen(false)}
              renderContent={(section, navigate) => {
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
                if (section === 'plugins')
                  return (
                    <PluginCenter
                      client={plugins}
                      plugins={pluginDescriptors}
                      errors={registry.errors()}
                      onRefresh={refreshPlugins}
                    />
                  )
                if (section === 'plugin-settings')
                  return contributions.some((entry) => entry.slot === 'settings' && !registry.isBuiltin(entry.id)) ? (
                    extra('settings')
                  ) : (
                    <p className="text-sm text-muted-foreground">当前没有插件提供额外设置。</p>
                  )
                const owner = {
                  general: 'settings',
                  appearance: 'settings',
                  personalization: 'settings',
                  profile: 'usage',
                  models: 'models',
                  mcp: 'mcp',
                  skills: 'resources',
                  extensions: 'resources',
                  access: 'permissions',
                  tools: 'codemode',
                  subagents: 'subagents',
                }[section]
                if (!enabled(owner))
                  return (
                    <p role="status" className="text-sm text-muted-foreground">
                      此功能的插件已停用。
                      <button
                        type="button"
                        className="ml-2 text-primary hover:underline"
                        onClick={() => navigate('plugins')}
                      >
                        管理插件
                      </button>
                    </p>
                  )
                if (section === 'general' || section === 'appearance' || section === 'personalization')
                  return builtin('settings', 'settings', 'settings', {
                    settingsProps: {
                      section,
                      bridge,
                      cwd: chat.connection.cwd,
                      busy: chat.busy || chat.connection.status === 'connecting',
                      snapshot: settings.snapshot,
                      piVersion: chat.connection.piVersion,
                      error: settings.error,
                      onDirty: setInstructionsDirty,
                      onSaving: setInstructionsSaving,
                      onAccess: () => navigate('access'),
                      onAppearance: settings.saveAppearance,
                      onPreview: settings.previewAppearance,
                      onFlush: settings.flushAppearance,
                      loadFonts: settings.getInstalledFonts,
                      onImport: () => void settings.importTheme(),
                      onExport: (theme) => void settings.exportTheme(theme),
                      onReload: () => void settings.reload(),
                      onOpenDirectory: () => void settings.openDirectory(),
                    },
                  })
                if (section === 'models')
                  return builtin('models', 'settings', 'models', {
                    modelSettingsProps: { busy: chat.modelPickerDisabled, bridge, models: chat.models },
                  })
                if (section === 'mcp')
                  return builtin('mcp', 'settings', 'mcp', {
                    mcpSettingsProps: {
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
                    },
                  })
                if (section === 'profile')
                  return builtin('usage', 'settings', 'profile', { profileProps: { loadUsage: bridge.getUsageStats } })
                if (section === 'skills')
                  return builtin('resources', 'settings', 'skills', {
                    skillsProps: {
                      commands: chat.commands,
                      ready,
                      loading: chat.loading,
                      onRefresh: chat.refreshCommands,
                    },
                  })
                if (section === 'extensions')
                  return builtin('resources', 'settings', 'extensions', {
                    extensionsProps: {
                      directory: settings.snapshot?.extensionsDirectory ?? '',
                      mode: chat.connection.accessMode,
                      busy: chat.busy,
                      onOpen: () => void settings.openExtensionsDirectory(),
                    },
                  })
                if (section === 'access')
                  return builtin('permissions', 'settings', 'access', {
                    defaultAccessProps: {
                      value: settings.snapshot?.settings.defaultAccessMode,
                      supported: Boolean(chat.connection.restrictedAccessSupported),
                      busy: chat.busy,
                      saving: settings.saving,
                      onSave: (mode) => void settings.saveAccessMode(mode),
                    },
                  })
                if (section === 'tools')
                  return builtin('codemode', 'settings', 'tools', {
                    toolsProps: {
                      value: {
                        codemodeEnabled: Boolean(settings.snapshot?.settings.codemodeEnabled),
                        mcpEnabled: Boolean(settings.snapshot?.settings.mcpEnabled),
                      },
                      busy: chat.busy,
                      saving: settings.saving,
                      onSave: (value) => void settings.saveCapabilities(value),
                    },
                  })
                return builtin('subagents', 'settings', 'subagents', {
                  subagentsProps: {
                    catalog: settings.subagents,
                    enabled: Boolean(settings.snapshot?.settings.subagentsEnabled),
                    enabledAgentIds: settings.snapshot?.settings.enabledSubagents ?? [],
                    busy: chat.busy,
                    saving: settings.saving,
                    onSave: (enabled, ids) => void settings.saveSubagents(enabled, ids),
                    onReload: () => void settings.reloadSubagents(),
                  },
                })
              }}
            />
          )}

          {/* 扩展交互请求弹窗 */}
          {chat.extensionDialogs[0] &&
            builtin('pi-extensions', 'page', 'dialog', {
              dialogKey: chat.extensionDialogs[0].id,
              dialogProps: {
                request: chat.extensionDialogs[0],
                onRespond: chat.answerExtensionDialog,
              },
            })}
        </main>
      </TooltipProvider>
    </PluginToolCardProvider>
  )
}
