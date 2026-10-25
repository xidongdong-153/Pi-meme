import { useSchedules } from '@pi-meme/schedules/ui/use-schedules'
import { ScheduleLocationSelector } from './shell/schedule-location-selector'
import { PageHeader, PageHeaderNavigation } from './layout/page-header'
import { ActivityPanel } from '@pi-meme/activities/ui/activity-panel'
import { useActivities } from '@pi-meme/activities/ui/activity-store'
import { GoalControl } from '@pi-meme/goals/ui/goal-control'
import { GitMenu } from '@pi-meme/git/ui/git-menu'
import { LocationSelector } from './shell/location-selector'
import { serviceLabel, serviceStatus, type ServiceUI } from './shell/service-ui'
import { SubagentsPanel } from './panels/subagents-panel'
import { createResourceClient } from '@pi-meme/client/resource-client'
import { appendSkillInvocation, invokeSkillInNewSession } from './settings/invoke-skill'
import { AccessSettings } from '@pi-meme/permissions/ui/access-settings'
import { AgentAccessSelector } from '@pi-meme/permissions/ui/agent-access-selector'
import { AppHeader } from './layout/app-header'
import { AppRail } from './layout/app-rail'
import { ProjectsPage } from './projects/projects-page'
import { ProjectDialog } from './projects/project-dialog'
import { ForkNotice } from './layout/fork-notice'
import { WorkspaceContent } from './layout/workspace-content'
import { ErrorNotice, SystemErrorStack, SystemErrorToast } from './layout/error-notice'
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
} from 'react'
import { Composer } from '@pi-meme/chat/ui/composer/composer'
import { MessageImageLoaderContext } from '@pi-meme/chat/ui/content/message-image'
import { Conversation } from '@pi-meme/chat/ui/conversation/conversation'
import { Sidebar } from '@pi-meme/workspace/ui/sidebar/sidebar'
import { SidebarMenus } from '@pi-meme/workspace/ui/sidebar/sidebar-menus'
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
import { SourcesPanel } from './panels/sources-panel'
import { collectSources } from './panels/sources-data'
import type { RightSidebarTab } from './layout/right-sidebar'
import type { PluginClient } from '@pi-meme/client/plugin-client'
import type { UiContributionProps, UiPluginDescriptor, UiPluginSlot, UiPanel, UiTarget } from '@pi-meme/plugin-sdk/ui'
import { freezeUiValue } from '@pi-meme/contracts/plugin-ui-data'
import { PluginRenderers } from './plugins/plugin-renderers'
import { beforeSendHookAvailable, UiPluginRegistry, pluginUiGranted } from './plugins/plugin-registry'
import { PluginUiConsent, PluginConsentDialog } from './plugins/plugin-ui-consent'
import { usePluginComposerController } from './plugins/plugin-composer-adapter'
import { useAppNavigation } from './layout/use-app-navigation'
import { PluginWorkspacePage, pluginRouteForEntry, rememberPluginRoute } from './layout/plugin-workspace-page'
import type { RegisteredNavigation } from '@pi-meme/plugin-sdk/navigation'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@pi-meme/ui/components/ui/dialog'
import { PluginSlot } from './plugins/plugin-slot'
import { WorkspacePanels } from './layout/workspace-panels'
import { sessionUiTarget, panelAvailable } from './layout/panel-layout'
import { useAgentPluginSelection } from './plugins/use-agent-plugin-selection'
import {
  Activity,
  FileDiff,
  Folder,
  Globe,
  TerminalSquare,
  Network,
  ListTree,
  NotebookPen,
  GitFork,
} from 'lucide-react'
import type { HostApi, AppSession } from '@pi-meme/contracts/app-host'
import { CustomizationPage } from './plugins/customization-page'
import { PluginPage } from './settings/plugin-page'
import { SettingsPage, type SettingsSection } from './settings/settings-page'
import { SkillPage } from './settings/skill-page'
import { useUserProfile } from './settings/user-profile'
import { loadPluginUI } from './plugins/load-plugin-ui'
import type { DesktopBridge, ProjectApp } from '@pi-meme/contracts/desktop'
import { useShortcutHandlers, useShortcuts } from './shortcuts/shortcut-provider'
import { ShortcutHelpDialog } from './shortcuts/shortcut-help-dialog'
import { ShortcutSettings } from './shortcuts/shortcut-settings'

const SchedulesPage = lazy(() =>
  import('@pi-meme/schedules/ui/schedules-page').then((module) => ({ default: module.SchedulesPage })),
)
const HostSettings = lazy(() => import('./settings/host-settings').then((module) => ({ default: module.HostSettings })))
const ModelConfigSettings = lazy(() =>
  import('@pi-meme/models/ui/model-config/model-config-settings').then((module) => ({
    default: module.ModelConfigSettings,
  })),
)
const SubagentDefaultsSettings = lazy(() =>
  import('@pi-meme/subagents/ui/subagent-defaults-settings').then((module) => ({
    default: module.SubagentDefaultsSettings,
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
  const userProfile = useUserProfile(bridge)
  const shortcuts = useShortcuts()
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false)
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false)
  const [openModelsVersion, setOpenModelsVersion] = useState(0)
  const openShortcutHelp = () => setShortcutHelpOpen(true)
  const resources = useMemo(() => createResourceClient(call, plugins.onChange), [call, plugins])
  const [registry] = useState(() => new UiPluginRegistry(host, loadPluginUI, plugins))
  const [pluginConsent] = useState(() => new PluginUiConsent())
  useSyncExternalStore(registry.subscribe, registry.getVersion, registry.getVersion)
  useEffect(() => {
    registry.setConfirmation(pluginConsent.request, (id) => pluginConsent.cancel(id))
    return () => pluginConsent.cancel()
  }, [registry, pluginConsent])
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
  const generationMetrics = useMemo(
    () => ({
      subscribe: chat.chatStream.subscribe,
      getSnapshot: () => chat.chatStream.getSnapshot().generationMetrics,
    }),
    [chat.chatStream],
  )
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (fileStore.hasDirty() || chat.hasUnstoredDraft()) event.preventDefault()
    }
    window.addEventListener('beforeunload', unload)
    return () => window.removeEventListener('beforeunload', unload)
  }, [fileStore, chat.hasUnstoredDraft])
  const active = serviceUI?.active ?? true
  const currentService = serviceUI?.services.find((service) => service.id === serviceUI.serviceId)
  const remoteOffline = Boolean(currentService && !currentService.local && currentService.status !== 'connected')
  const scheduleState = useSchedules(
    host,
    currentService
      ? currentService.status === 'connected'
      : chat.connection.status !== 'disconnected' && chat.connection.status !== 'connecting',
  )
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
    if (chat.navigationBusy) return
    const installed = new Map(pluginDescriptors.map((plugin) => [plugin.id, plugin]))
    const descriptors = (chat.uiPlugins ?? pluginDescriptors).map((snapshot) => {
      const current = installed.get(snapshot.id)
      if (!current || !current.enabled || current.grantChanging || !current.grant?.trusted.ui)
        return { ...snapshot, enabled: false }
      if (current.generation === snapshot.generation) return { ...current, ui: snapshot.ui, enabled: snapshot.enabled }
      return current
    })
    void registry.synchronize(descriptors)
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
  // 按运行时会话缓存已解析的 AppSession：回到看过的会话立即有目标，首次进入仍等解析完成。
  const [resolvedSessions, setResolvedSessions] = useState<Record<string, AppSession>>({})
  const runtimeSessionKey = chat.connection.sessionKey
  useEffect(() => {
    let current = true
    if (!runtimeSessionKey) return
    void bridge
      .resolveAppSession(runtimeSessionKey)
      .then((value) => {
        if (!current) return
        chat.bindDraftSession(runtimeSessionKey, value.sessionId)
        setResolvedSessions((sessions) => {
          const next = { ...sessions, [runtimeSessionKey]: value }
          const keys = Object.keys(next)
          for (const key of keys.slice(0, Math.max(0, keys.length - 20))) delete next[key]
          return next
        })
      })
      .catch((cause) => {
        if (!current) return
        chat.setError(String(cause))
        // 解析失败时移除该会话的目标，避免右栏和插件作用域指向已失效会话。
        setResolvedSessions((sessions) => {
          if (!(runtimeSessionKey in sessions)) return sessions
          const next = { ...sessions }
          delete next[runtimeSessionKey]
          return next
        })
      })
    return () => {
      current = false
    }
  }, [bridge, runtimeSessionKey, chat.bindDraftSession, chat.setError])
  const appSession = runtimeSessionKey ? resolvedSessions[runtimeSessionKey] : undefined
  const activities = useActivities(host, appSession)
  const loadConversationImage = useMemo(() => {
    if (!appSession) return undefined
    const ref = { hostId: appSession.hostId, sessionId: appSession.sessionId }
    return (relativePath: string) => host.files.preview(ref, relativePath)
  }, [host, appSession])
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
  const [instructionsDirty, setInstructionsDirty] = useState(false)
  const [instructionsSaving, setInstructionsSaving] = useState(false)
  const [dirtyPage, setDirtyPage] = useState<{ pluginId: string; generation: number; routeInstance: string } | null>(
    null,
  )
  const [pluginPageError, setPluginPageError] = useState('')
  const discardPluginPage = () => {
    if (dirtyPage)
      void registry
        .setPageDirty(dirtyPage.pluginId, dirtyPage.generation, dirtyPage.routeInstance, false)
        .catch((cause) => chat.setError(String(cause)))
    setDirtyPage(null)
    setPluginPageError('')
  }
  const navigation = useAppNavigation({
    dirty: instructionsDirty || Boolean(dirtyPage),
    saving: instructionsSaving,
    onDiscard: () => {
      setInstructionsDirty(false)
      discardPluginPage()
    },
  })
  const route = navigation.route
  useEffect(() => pluginConsent.cancel(), [pluginConsent, route])
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (dirtyPage || instructionsDirty || instructionsSaving) event.preventDefault()
    }
    window.addEventListener('beforeunload', unload)
    return () => window.removeEventListener('beforeunload', unload)
  }, [dirtyPage, instructionsDirty, instructionsSaving])
  const settingsSection = route.kind === 'settings' ? route.section : null
  const settingsOpen = settingsSection !== null
  const projectsOpen = route.kind === 'projects'
  const customizationOpen = route.kind === 'customization'
  const chatVisible = route.kind === 'chat'
  const openSettings = (section: SettingsSection = 'general') => navigation.open({ kind: 'settings', section })
  const pluginPages = useSyncExternalStore(registry.subscribe, registry.getPages, registry.getPages)
  const pluginNavigation = useSyncExternalStore(registry.subscribe, registry.getNavigation, registry.getNavigation)
  const pluginPageRequest = useSyncExternalStore(registry.subscribe, registry.getPageRequest, registry.getPageRequest)
  const pluginBackRequest = useSyncExternalStore(registry.subscribe, registry.getBackRequest, registry.getBackRequest)
  const beforeSendHooks = useSyncExternalStore(
    registry.subscribe,
    registry.getBeforeSendHooks,
    registry.getBeforeSendHooks,
  )
  const pluginMetadata = useSyncExternalStore(
    registry.dataSource.reactive.metadata.subscribe,
    registry.dataSource.reactive.metadata.getSnapshot,
    registry.dataSource.reactive.metadata.getSnapshot,
  )
  const pluginTarget = useMemo(
    () => sessionUiTarget(hostId ?? appSession?.hostId ?? '', appSession),
    [hostId, appSession],
  )
  const publicPluginTarget = useMemo(() => freezeUiValue(structuredClone(pluginTarget)), [pluginTarget])
  const pluginProps: UiContributionProps = useMemo(
    () => ({
      host,
      target: publicPluginTarget,
      snapshot: pluginMetadata.session,
    }),
    [host, publicPluginTarget, pluginMetadata.session],
  )
  const authorizationRevision = JSON.stringify(
    pluginDescriptors.map((plugin) => [
      plugin.id,
      plugin.generation,
      plugin.grant?.revision,
      plugin.grantChanging,
      plugin.policyHash,
    ]),
  )
  const requiredBeforeSendHooks = useMemo(
    () =>
      pluginDescriptors.flatMap((plugin) => {
        const projectPlugin = chat.uiPlugins?.find((entry) => entry.id === plugin.id)
        if (!plugin.enabled || !projectPlugin?.enabled || !pluginUiGranted(plugin, 'composer.before-send')) return []
        return (plugin.permissions?.beforeSend ?? [])
          .filter((id) => plugin.grant?.beforeSend.includes(id))
          .map((hookId) => ({ pluginId: plugin.id, hookId, generation: plugin.generation }))
      }),
    [pluginDescriptors, chat.uiPlugins],
  )
  const pluginComposer = usePluginComposerController({
    chat,
    hostId,
    session: appSession,
    visible: active && chatVisible,
    agentPlugins: agentPluginSelection,
    hooks: beforeSendHooks,
    requiredHooks: requiredBeforeSendHooks,
    authorizationRevision,
    canProcess: (hook) =>
      beforeSendHookAvailable(
        hook,
        pluginDescriptors.find((entry) => entry.id === hook.pluginId),
        chat.uiPlugins?.find((entry) => entry.id === hook.pluginId),
      ),
  })
  useEffect(() => {
    registry.setComposerController(pluginComposer.adapter)
    registry.setChatVisible(active && chatVisible)
    return () => registry.setComposerController(null)
  }, [registry, pluginComposer.adapter, active, chatVisible])
  useEffect(() => registry.dataSource.attach(chat.chatStream), [registry, chat.chatStream])
  useEffect(() => {
    registry.dataSource.setEnvironment({
      target: pluginTarget,
      connection: { status: chat.connection.status },
      view:
        route.kind === 'plugin'
          ? { kind: 'plugin', pluginId: route.pluginId, pageId: route.pageId, target: route.target }
          : { kind: 'chat' },
      session:
        chat.state && appSession
          ? {
              status: chat.connection.status,
              running: chat.chat.running,
              agentPlugins,
              selectedPlugins: agentPlugins,
              effectivePlugins: chat.state.pluginPolicy?.effectivePlugins,
              unavailablePlugins: chat.state.pluginPolicy?.unavailablePlugins,
              capabilities: chat.state.pluginPolicy?.capabilities,
              policyRevision: chat.state.pluginPolicy?.policyRevision,
              deniedReasons: chat.state.pluginPolicy
                ? Object.fromEntries(
                    chat.state.pluginPolicy.unavailablePlugins.map((plugin) => [plugin.id, plugin.reason]),
                  )
                : undefined,
              usage: chat.sessionStats
                ? {
                    input: chat.sessionStats.tokens.input,
                    output: chat.sessionStats.tokens.output,
                    total: chat.sessionStats.tokens.total,
                    estimated: false,
                  }
                : undefined,
              requestedMode: chat.mode,
              effectiveMode: chat.chat.activeMode ?? chat.mode,
              mode: chat.mode,
              accessMode: chat.connection.accessMode,
              requestedAccess: chat.connection.accessMode,
              effectiveAccess:
                (chat.chat.activeMode ?? chat.mode) === 'plan' ? 'read-only' : chat.connection.accessMode,
              model: chat.state.model,
              thinkingLevel: chat.state.thinkingLevel,
              queue: { steering: chat.chat.steering.length, followUp: chat.chat.followUp.length },
              paused: chat.chat.paused,
              queuePaused: chat.chat.queuePaused,
            }
          : null,
    })
  }, [
    registry,
    pluginTarget,
    route,
    chat.connection.status,
    chat.connection.accessMode,
    chat.state,
    appSession,
    agentPlugins,
    chat.mode,
    chat.chat.activeMode,
    chat.chat.running,
    chat.chat.paused,
    chat.chat.queuePaused,
    chat.chat.steering.length,
    chat.chat.followUp.length,
    chat.sessionStats,
  ])
  const lastBackRequest = useRef(0)
  useEffect(() => {
    if (pluginBackRequest === lastBackRequest.current) return
    lastBackRequest.current = pluginBackRequest
    navigation.back()
  }, [pluginBackRequest])
  useEffect(() => {
    if (!pluginPageRequest) return
    navigation.open({
      kind: 'plugin',
      pluginId: pluginPageRequest.pluginId,
      pageId: pluginPageRequest.pageId,
      target: pluginPageRequest.target,
      params: pluginPageRequest.params,
    })
    registry.consumePageRequest(pluginPageRequest.revision)
  }, [pluginPageRequest, registry])
  useEffect(() => {
    navigation.prune(
      (entry) =>
        entry.kind !== 'plugin' ||
        pluginPages.some(
          (page) => page.pluginId === entry.pluginId && page.id === entry.pageId && entry.target.hostId === hostId,
        ),
    )
  }, [pluginPages, hostId])
  function openPlugin(entry: RegisteredNavigation) {
    const next = pluginRouteForEntry(entry, pluginPages, pluginProps.target)
    if (next) navigation.open(next)
    else chat.setError('插件页面需要对应项目或会话，请先在聊天中选择目标。')
  }
  const pluginRailProps = {
    onSchedules: () => navigation.open({ kind: 'schedules' }),
    schedulesActive: route.kind === 'schedules',
    schedulesUnread: scheduleState.tasks.some((task) => task.unreadCount > 0),
    onShortcutHelp: openShortcutHelp,
    pluginNavigation,
    activePluginId: route.kind === 'plugin' ? route.pluginId : undefined,
    onPlugin: openPlugin,
  }
  const pluginRoute = route.kind === 'plugin' ? route : undefined
  const currentPluginPage = pluginRoute
    ? pluginPages.find((page) => page.pluginId === pluginRoute.pluginId && page.id === pluginRoute.pageId)
    : undefined
  const currentPluginNavigation = pluginRoute
    ? pluginNavigation.find((entry) => entry.pluginId === pluginRoute.pluginId)
    : undefined
  const currentPluginHost = useMemo(
    () =>
      currentPluginPage
        ? (signal: AbortSignal) => {
            const scoped = registry.getPageHost(currentPluginPage, signal)
            if (!scoped) throw new Error('plugin-retired：插件页面已退役')
            return scoped
          }
        : undefined,
    [registry, currentPluginPage],
  )
  const pluginPageInstance =
    currentPluginPage && pluginRoute
      ? JSON.stringify([
          currentPluginPage.pluginId,
          currentPluginPage.generation,
          currentPluginPage.id,
          pluginRoute.target.hostId,
          pluginRoute.target.project?.projectId,
          pluginRoute.target.session?.sessionId,
        ])
      : ''
  const currentPluginPageInstance = useRef(pluginPageInstance)
  currentPluginPageInstance.current = pluginPageInstance
  useEffect(() => {
    if (
      dirtyPage &&
      !pluginPages.some((page) => page.pluginId === dirtyPage.pluginId && page.generation === dirtyPage.generation)
    ) {
      setDirtyPage(null)
      setPluginPageError('')
    }
  }, [pluginPages, dirtyPage])
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
  const [creatingProject, setCreatingProject] = useState(false)
  const creatingSkillSession = useRef(false)
  const assertRestartAllowed = () => {
    if (fileStore.hasDirty() || instructionsDirty || instructionsSaving || dirtyPage)
      throw new Error('仍有未保存的文件或指令，请先保存后再维护存储')
    if (chat.hasDraftInput()) throw new Error('仍有未发送的草稿或附件，请先处理后再维护存储')
  }
  useEffect(() => {
    serviceUI?.onController(serviceUI.serviceId, {
      ...chat,
      openSettings: () => openSettings('general'),
      openSchedules: () => navigation.open({ kind: 'schedules' }),
      assertRestartAllowed,
      assertRemoveAllowed: () => {
        if (instructionsSaving || chat.navigationBusy || chat.modelSaving || chat.sendingAttachments.length)
          throw new Error('正在保存、提交或切换，请完成后再移除连接')
        if (fileStore.hasDirty() || instructionsDirty || dirtyPage)
          throw new Error('仍有未保存的文件、指令或插件页面，请先保存或放弃修改后再移除连接')
        if (chat.hasDraftInput() || chat.editing)
          throw new Error('仍有未发送的草稿、附件或消息编辑，请先处理后再移除连接')
      },
      openProjectDialog: () => setCreatingProject(true),
      beforeDeactivate: async () => {
        if (instructionsSaving) return false
        if (!dirtyPage && !instructionsDirty) return true
        const accepted = await pluginConsent.request({
          pluginId: dirtyPage?.pluginId ?? '应用指令',
          title: '切换前放弃未保存的更改？',
          description: '当前插件页面或指令有未保存更改。切换会话或服务后，这些修改不会自动恢复。',
        })
        if (accepted) {
          discardPluginPage()
          setInstructionsDirty(false)
        }
        return accepted
      },
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
        : 'Pi meme'
  const first = chat.chat.messages.find((message) => message.role === 'user')
  const status =
    remoteOffline && currentService
      ? serviceStatus(currentService)
      : chat.chat.running
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
    if (active) document.title = customizationOpen ? '插件与技能' : projectsOpen ? '项目' : chat.extensionTitle || title
  }, [chat.extensionTitle, title, active, projectsOpen, customizationOpen])

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
  const pluginComposerStatus = (
    <div className="space-y-2 text-xs text-muted-foreground">
      {pluginComposer.availabilityReason && <p role="status">{pluginComposer.availabilityReason}</p>}
      {Boolean(pluginComposer.view?.processors.length) && (
        <p role="status">
          发送前处理：{pluginComposer.view?.processors.map((processor) => processor.title).join('、')}
          {pluginComposer.view?.submissionState === 'preparing' ? ' · 正在处理…' : ''}
        </p>
      )}
      {pluginComposer.view?.failure && (
        <div role="alert" className="rounded-lg border border-border p-2">
          <p>
            {pluginComposer.view.failure.title}：{pluginComposer.view.failure.reason}
          </p>
          <div className="mt-1 flex flex-wrap gap-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void pluginComposer.retry().catch((cause) => chat.setError(String(cause)))}
            >
              重试
            </Button>
            <Button size="sm" variant="ghost" onClick={chat.focusDraft}>
              查看草稿
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                const view = pluginComposer.view
                const failure = view?.failure
                if (!view || !failure) return
                const signal = pluginComposer.getFailureSignal(failure.attemptId)
                if (!signal || signal.aborted) return
                void pluginConsent
                  .request({
                    pluginId: failure.pluginId,
                    title: '仅本次跳过发送前处理？',
                    description: `跳过 ${failure.title}，不改变长期授权。目标：${JSON.stringify({ target: view.ref.target, session: view.ref.session, context: view.ref.context })}。草稿或目标变化后，本次许可失效。`,
                    signal,
                  })
                  .then((accepted) => (accepted ? pluginComposer.skip(failure.attemptId) : undefined))
                  .catch((cause) => chat.setError(String(cause)))
              }}
            >
              仅本次跳过
            </Button>
          </div>
        </div>
      )}
      {chat.failedDrafts.map((draft, index) => (
        <div key={index} className="flex items-center justify-between gap-2 rounded-lg border border-border p-2">
          <span className="truncate">发送失败的待恢复草稿：{draft.draft.slice(0, 80) || '附件'}</span>
          <Button
            size="sm"
            variant="outline"
            disabled={Boolean(chat.draft || chat.attachments.length)}
            title={chat.draft || chat.attachments.length ? '请先处理当前草稿' : undefined}
            onClick={() => chat.restoreFailedDraft(index)}
          >
            恢复草稿
          </Button>
        </div>
      ))}
    </div>
  )
  const composerProps: ComponentProps<typeof Composer> = {
    compact: interaction?.method === 'questions',
    mode: chat.mode,
    onMode: chat.changeMode,
    onPlanCommand: chat.activatePlan,
    onGoalCommand: chat.goalsSupported ? chat.activateGoal : undefined,
    onCompact: () => void chat.compactNow(),
    sessionStarted: chat.chat.messages.length > 0 || chat.chat.live !== null,
    sessionName: chat.state?.sessionName,
    onRenameSession: async (name) => {
      if (!chat.chat.messages.length && !chat.chat.live) throw new Error('当前还是新会话，开始对话后才能重命名')
      const path = chat.connection.sessionKey
      if (!path) throw new Error('当前没有可重命名的会话')
      await bridge.renameSession(path, name)
      await chat.refreshMenu().catch((cause) => chat.setError(String(cause)))
    },
    [chat.goalDraft ? 'goalControl' : 'goalBanner']: chat.goalsSupported ? (
      <GoalControl
        goal={chat.goalDraft ? undefined : chat.goal}
        draft={chat.goalDraft}
        onDraft={chat.setGoalDraft}
        open={chat.goalOpen}
        onOpen={chat.setGoalOpen}
        editing={chat.goalEditing}
        running={chat.chat.running}
        onAction={chat.goalAction}
        onSave={chat.saveGoal}
        onError={chat.setError}
      />
    ) : undefined,
    recoveredInputs: chat.recoveredInputs,
    onRestoreQueuedInput: chat.restoreQueuedInput,
    sessionKey: chat.connection.sessionKey,
    attachmentContextKey: JSON.stringify([chat.editingEntryId, chat.editingQueue]),
    composerStore: chat.composerStore,
    files: chat.composerFiles,
    uploadAttachment: bridge.uploadAttachment,
    projectPath: chat.connection.cwd,
    loadProjectFiles: bridge.getProjectFiles,
    access: (
      <AgentAccessSelector
        {...{
          mode: chat.connection.accessMode,
          busy: chat.accessBusy,
          supported: chat.connection.restrictedAccessSupported === true,
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
    hint: settings.snapshot?.settings.showComposerHint !== false ? chat.composerHint : undefined,
    onAcceptHint: chat.acceptComposerHint,
    onDismissHint: chat.dismissComposerHint,
    attachments: chat.attachments,
    onAddImages: (images) => chat.setAttachments((value) => [...value, ...images]),
    onRemoveImage: (id) => chat.setAttachments((value) => value.filter((image) => image.id !== id)),
    running: chat.chat.running,
    paused: chat.chat.paused || chat.chat.stopped,
    stopped: chat.chat.stopped,
    queuePaused: chat.chat.queuePaused,
    activeMode: chat.chat.activeMode,
    activeConfiguration: { model: chat.state?.model, thinkingLevel: chat.state?.thinkingLevel },
    editingQueue: chat.editingQueue !== null,
    onResume: () => void chat.resume(),
    onResumeQueue: () => void chat.resumeQueue(),
    resumeLabel: chat.goal?.status === 'paused' ? '继续目标' : undefined,
    recovery: chat.chat.goal && chat.chat.goal.status !== 'complete' ? undefined : chat.chat.recovery,
    recovering: chat.recovering,
    onRecover: () => void chat.recover(),
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
    onStop: chat.stop,
    onClearQueue: () => void chat.clearQueue(),
    editing: chat.editing,
    onCancelEdit: chat.cancelEdit,
    commands: chat.commands,
    widgetsAbove: (
      <>
        {currentService && !currentService.local && (
          <div role="status" className="flex min-w-0 items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground">
            <Globe aria-hidden="true" className="size-3 shrink-0 text-primary" />
            <span className="min-w-0 flex-1 truncate" title={currentService.error}>
              远程 · {serviceLabel(currentService)} · {currentService.transport === 'ssh' ? 'SSH' : 'HTTPS'} ·{' '}
              {serviceStatus(currentService)}
            </span>
            {remoteOffline && (
              <Button size="sm" variant="ghost" onClick={() => openSettings('host')}>
                管理连接
              </Button>
            )}
          </div>
        )}
        {remoteOffline && (
          <p className="px-2 pb-1 text-xs text-muted-foreground">
            当前内容为已加载快照，草稿保留。连接恢复前无法发送；远端任务可能仍在运行。
          </p>
        )}
        <ExtensionWidgets {...{ widgets: chat.extensionWidgets, placement: 'aboveEditor' }} />
        {pluginComposerStatus}
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
    contextUsage:
      settings.snapshot?.settings.showContextUsage !== false ? (
        <ContextUsageRing {...{ stats: chat.sessionStats, generationMetrics }} />
      ) : null,
    model: (
      <ModelPickerPopover
        {...{
          models: chat.models,
          currentModel: chat.selectedConfiguration.model,
          thinkingLevel: chat.selectedConfiguration.thinkingLevel,
          disabled: chat.modelPickerDisabled,
          busy: chat.modelSaving,
          openModelsVersion,
          shortcutLabel: shortcuts.getShortcutLabel('openModelPicker'),
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
        <MessageImageLoaderContext value={loadConversationImage}>
          <Composer {...composerProps} />
        </MessageImageLoaderContext>
      </div>
      {chat.workspaceNotice && (
        <p role="status" className="px-3 text-xs text-muted-foreground">
          {chat.workspaceNotice}
        </p>
      )}
    </div>
  )

  const editor =
    chat.editing && chat.editingEntryId !== null
      ? {
          entryId: chat.editingEntryId,
          model: composerProps.model,
          submitting: chat.editSubmitting,
          submissionLabel: chat.connection.editPhase === 'sending' ? '正在重新发送' : '正在停止原任务',
          composerStore: chat.composerStore,
          files: chat.composerFiles,
          sessionKey: chat.connection.sessionKey,
          uploadAttachment: bridge.uploadAttachment,
          onError: chat.setError,
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
          agentPlugins: agentPluginSelection,
          focusVersion: chat.draftFocusVersion,
          disabled: !ready || chat.inputDisabled,
          onSubmit: () => void chat.send(),
          onCancel: chat.cancelEdit,
        }
      : undefined

  const sidebar = serviceUI?.sidebar ?? (
    <Sidebar
      {...{
        menuBridge: bridge,
        canOpenProject: localPlatform,
        sidebarSettingsBridge: bridge,
        serviceId: hostId ?? 'local',
        searchEnabled: chatVisible && !serviceUI,
        searchOpen: sessionSearchOpen,
        onSearchOpenChange: setSessionSearchOpen,
        searchShortcutLabel: shortcuts.getShortcutLabel('searchSessions'),
        newChatShortcutLabel: shortcuts.getShortcutLabel('newChat'),
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
        onDirectory: () => setCreatingProject(true),
        onNewSession: () => void chat.newSession(),
        onNewSessionInProject: (targetCwd) => void chat.newSessionInProject(targetCwd),
        onSwitchSession: (sessionPath) => void chat.switchSession(sessionPath),
        onTogglePin: (targetPath) => void chat.togglePin(targetPath),
        onPrefetchSession: (sessionPath) => void bridge.prefetchSession(sessionPath).catch(() => {}),
        onSettings: () => openSettings('general'),
      }}
    />
  )
  const operationError = chat.error || settings.error
  const systemErrorItems = [
    ...chat.extensionNotices
      .filter((notice) => notice.type === 'error')
      .reverse()
      .map((notice) => ({
        id: `extension-notice-${notice.id}`,
        message: notice.message,
        onOpenSettings: () => openSettings('general'),
        onDismiss: () => chat.dismissNotice(notice.id),
      })),
    ...(chat.extensionError?.message
      ? [
          {
            id: 'extension-error',
            message: chat.extensionError.message,
            extension: true,
            onOpenSettings: () => openSettings('general'),
            onDismiss: chat.dismissExtensionError,
          },
        ]
      : []),
    ...(operationError
      ? [
          {
            id: 'operation-error',
            message: operationError,
            onOpenSettings: () => {
              chat.setError('')
              settings.dismissError()
              openSettings('general')
            },
            onDismiss: () => {
              chat.setError('')
              settings.dismissError()
            },
          },
        ]
      : []),
  ]
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
            canEditMessages: !chat.inputDisabled && !chat.navigationBusy && !chat.editing,
            canForkReplies: !chat.busy && !chat.navigationBusy && !chat.editing,
            onEditMessage: chat.editMessage,
            onForkReply: (timestamp) => void chat.forkReply(timestamp),
            onCopyError: chat.setError,
            editor,
            sessionKey: chat.connection.sessionKey,
            models: chat.models,
            loadImage: loadConversationImage,
          }}
        />
      }
      canEditMessages={!chat.inputDisabled && !chat.navigationBusy && !chat.editing}
      onEditMessage={chat.editMessage}
      onForkReply={(timestamp) => void chat.forkReply(timestamp)}
      onCopyError={chat.setError}
      onSettings={() => openSettings('general')}
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
      notice={
        <>
          {chat.editing && pluginComposerStatus}
          <SystemErrorToast>
            <SystemErrorStack contained items={systemErrorItems} />
            <ExtensionNotices
              contained
              notices={chat.extensionNotices.filter((notice) => notice.type !== 'error')}
              onDismiss={chat.dismissNotice}
            />
          </SystemErrorToast>
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
  const sources = useMemo(
    () =>
      collectSources({
        branchAttachments: chat.chat.branchAttachments,
        steering: chat.chat.steering,
        followUp: chat.chat.followUp,
        sending: chat.sendingAttachments,
        draft: chat.attachments,
        failed: chat.failedDrafts.flatMap((d) => d.attachments),
      }),
    [
      chat.chat.branchAttachments,
      chat.chat.steering,
      chat.chat.followUp,
      chat.sendingAttachments,
      chat.attachments,
      chat.failedDrafts,
    ],
  )
  const panels: UiPanel[] = [
    {
      id: 'builtin:activities',
      title: activities.count ? `活动 · ${activities.count}` : '活动',
      icon: <Activity />,
      location: 'right',
      scope: 'session',
      render: (props) =>
        props.target.session ? (
          <ActivityPanel
            key={`${props.target.session.hostId}:${props.target.session.sessionId}`}
            store={activities.store}
            session={props.target.session}
            local={hostLocal}
            hostAddress={hostAddress}
          />
        ) : null,
    },
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
            render: () => <SessionTreePanel sessionEntries={chat.chat.sessionEntries} />,
          },
        ]
      : []),
    ...(sources.length > 0
      ? [
          {
            id: 'builtin:sources',
            title: '来源',
            icon: <GitFork />,
            location: 'right' as const,
            scope: 'session' as const,
            render: (props: UiContributionProps) =>
              props.target.session ? (
                <MessageImageLoaderContext value={loadConversationImage}>
                  <SourcesPanel sources={sources} />
                </MessageImageLoaderContext>
              ) : null,
          },
        ]
      : []),
    ...pluginPanels,
  ]
  const handleSidebar = useCallback((open: boolean, width: number) => {
    setSidebarOpen(open)
    setSidebarWidth(width)
  }, [])
  async function invokeSystemSkill(name: string, prompt?: string) {
    if (creatingSkillSession.current) return false
    creatingSkillSession.current = true
    try {
      if (!(await invokeSkillInNewSession(chat, bridge.getCommands, name, prompt))) return false
      navigation.home()
      return true
    } finally {
      creatingSkillSession.current = false
    }
  }
  const chatShortcutsAvailable = active && chatVisible && !interaction
  const openTool = (id: string) => {
    setSystemRequest({ id, revision: Date.now(), target: pluginProps.target })
  }
  useShortcutHandlers(
    {
      openSettings: () => openSettings('general'),
      openShortcutHelp,
      newChat:
        chatShortcutsAvailable && !chat.workspaceDisabledReason && !chat.editingQueue && !fileStore.hasDirty()
          ? async () => {
              await chat.newSession()
            }
          : undefined,
      searchSessions: chatShortcutsAvailable ? (serviceUI?.onSearch ?? (() => setSessionSearchOpen(true))) : undefined,
      pauseTask:
        chatShortcutsAvailable &&
        chat.chat.running &&
        !chat.chat.paused &&
        !chat.chat.queuePaused &&
        !chat.navigationBusy
          ? () => chat.stop()
          : undefined,
      togglePlanMode:
        chatShortcutsAvailable &&
        !chat.busy &&
        !chat.editing &&
        !chat.editingQueue &&
        !chat.savingQueue &&
        chat.goal?.status !== 'active'
          ? () => chat.changeMode(chat.mode === 'plan' ? 'default' : 'plan')
          : undefined,
      openModelPicker:
        chatShortcutsAvailable && !chat.modelPickerDisabled && !chat.modelSaving && !chat.editing
          ? () => setOpenModelsVersion((version) => version + 1)
          : undefined,
      openFiles:
        chatShortcutsAvailable &&
        panels.some((panel) => panel.id === 'builtin:files' && panelAvailable(panel, pluginProps.target))
          ? () => openTool('builtin:files')
          : undefined,
      openTerminal:
        chatShortcutsAvailable &&
        panels.some((panel) => panel.id === 'builtin:terminal' && panelAvailable(panel, pluginProps.target))
          ? () => openTool('builtin:terminal')
          : undefined,
    },
    active,
  )
  if (!active) return null

  return (
    <PluginRenderers registry={registry} props={pluginProps}>
      <TooltipProvider delayDuration={200}>
        <main
          data-active-service={serviceUI?.serviceId ?? 'local'}
          className="theme-app flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground select-none"
        >
          <div className={!chatVisible ? 'hidden' : 'flex flex-1 min-h-0 flex-col'} inert={!chatVisible}>
            <WorkspacePanels
              sessionTitle={title}
              onFocusComposer={
                !chat.inputDisabled && !chat.editing ? () => chat.composerStore.editor?.focus() : undefined
              }
              shortcutEnabled={chatShortcutsAvailable}
              onShortcutHelp={openShortcutHelp}
              profile={userProfile.profile}
              profileLoading={userProfile.showPlaceholder}
              panels={panels}
              activity={{
                count: activities.count,
                known:
                  activities.state.known &&
                  activities.state.connected &&
                  !activities.state.loading &&
                  !activities.state.error,
              }}
              errors={registry.errors()}
              props={pluginProps}
              session={appSession?.sessionId ?? runtimeSessionKey ?? ''}
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
              onSettings={() => openSettings('general')}
              onUsage={() => openSettings('profile')}
              onAccount={() => openSettings('account')}
              onProjects={() => navigation.open({ kind: 'projects' })}
              onSchedules={() => navigation.open({ kind: 'schedules' })}
              schedulesUnread={scheduleState.tasks.some((task) => task.unreadCount > 0)}
              onNewSession={() => void chat.newSession()}
              onPlugins={() => navigation.open({ kind: 'customization' })}
              pluginNavigation={pluginNavigation}
              onPlugin={openPlugin}
              header={(toggleSidebar, workspaceTabs) => (
                <SidebarMenus
                  bridge={bridge}
                  pinnedPaths={chat.sessions?.pinnedPaths ?? []}
                  onNewSession={(cwd) => void chat.newSessionInProject(cwd)}
                  onTogglePin={(path) => void chat.togglePin(path)}
                  onChanged={chat.refreshMenu}
                  onDeleted={chat.applyMenuDeletion}
                  canOpenProject={localPlatform}
                  disabledReason={remoteOffline ? '远程未连接，请先恢复连接' : undefined}
                >
                  <AppHeader
                    workspaceTabs={workspaceTabs}
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
                    session={activeSummary}
                    canRenameSession={ready && !chat.workspaceDisabledReason}
                    onOpenProject={(app) => void bridge.openProject(app).catch((cause) => chat.setError(String(cause)))}
                    preferredApp={preferredApp}
                    onPreferredApp={(app) => {
                      setPreferredApp(app)
                      void bridge.setPreferredProjectApp(app).catch((cause) => chat.setError(String(cause)))
                    }}
                    forkedFrom={forkedFrom}
                    onOpenForkSource={(path) => void chat.openForkSource(path)}
                  />
                </SidebarMenus>
              )}
            >
              {conversation}
            </WorkspacePanels>
          </div>

          {route.kind === 'schedules' && (
            <Suspense
              fallback={
                <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                  正在打开定时任务…
                </div>
              }
            >
              <SchedulesPage
                host={host}
                state={scheduleState}
                selectedId={route.taskId}
                onSelect={(taskId) => navigation.replace({ kind: 'schedules', taskId })}
                header={
                  <PageHeader>
                    <PageHeaderNavigation
                      nativeWindow={nativeWindow}
                      back={{ label: '返回上一页', onClick: navigation.back, disabled: !navigation.canBack }}
                      forward={{ label: '前进', onClick: navigation.forward, disabled: !navigation.canForward }}
                    />
                  </PageHeader>
                }
                rail={
                  <AppRail
                    profile={userProfile.profile}
                    profileLoading={userProfile.showPlaceholder}
                    {...pluginRailProps}
                    onHome={navigation.home}
                    onProjects={() => navigation.open({ kind: 'projects' })}
                    onPlugins={() => navigation.open({ kind: 'customization' })}
                    onSettings={() => openSettings('general')}
                    onUsage={() => openSettings('profile')}
                    onAccount={() => openSettings('account')}
                  />
                }
                locationLabel={
                  currentService ? serviceLabel(currentService) : hostLocal ? '此计算机' : (hostAddress ?? '当前 Host')
                }
                location={
                  <ScheduleLocationSelector
                    services={serviceUI?.services ?? []}
                    serviceId={serviceUI?.serviceId}
                    label={currentService ? serviceLabel(currentService) : hostLocal ? '此计算机' : '当前 Host'}
                    onSelect={(id) => serviceUI?.onSchedules(id)}
                  />
                }
                defaults={{
                  model: chat.state?.model ?? chat.models[0] ?? { provider: '', id: '' },
                  thinkingLevel: chat.state?.thinkingLevel ?? 'medium',
                  accessMode: settings.snapshot?.settings.defaultAccessMode ?? 'workspace-write',
                  agentPlugins: [...agentPlugins],
                  mode: 'default',
                }}
                plugins={pluginDescriptors
                  .filter((plugin) => plugin.enabled && plugin.capabilities?.agent)
                  .map((plugin) => ({ id: plugin.id, name: plugin.display?.name ?? plugin.id }))}
                renderAccessSelector={(configuration, onChange) => (
                  <AgentAccessSelector
                    mode={configuration.accessMode}
                    busy={false}
                    supported={Boolean(chat.connection.restrictedAccessSupported)}
                    onChange={(accessMode) => onChange({ ...configuration, accessMode })}
                  />
                )}
                renderModelPicker={(configuration, onChange) => (
                  <ModelPickerPopover
                    models={chat.models}
                    currentModel={
                      chat.models.find(
                        (model) =>
                          model.provider === configuration.model.provider && model.id === configuration.model.id,
                      ) ?? configuration.model
                    }
                    thinkingLevel={configuration.thinkingLevel}
                    disabled={false}
                    onSelectModel={(model) => onChange({ ...configuration, model })}
                    onSelectThinkingLevel={(thinkingLevel) => onChange({ ...configuration, thinkingLevel })}
                  />
                )}
                onOpenSession={async (ref) => {
                  const session = await host.sessions.get(ref)
                  if (!session.sessionFile) throw new Error('聊天尚未保存，请等待本次运行开始后重试')
                  if (await chat.switchSession(session.sessionFile)) navigation.home()
                }}
              />
            </Suspense>
          )}
          {scheduleState.notice && (
            <div
              role="status"
              className="fixed bottom-5 right-5 z-50 flex max-w-sm items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3 text-sm shadow-xl"
            >
              <button
                type="button"
                className="min-w-0 truncate text-left"
                onClick={() => {
                  navigation.open({ kind: 'schedules', taskId: scheduleState.notice!.taskId })
                  scheduleState.dismissNotice()
                }}
              >
                {scheduleState.notice.text}
              </button>
              <button
                type="button"
                aria-label="关闭任务提醒"
                className="text-muted-foreground hover:text-foreground"
                onClick={scheduleState.dismissNotice}
              >
                关闭
              </button>
            </div>
          )}

          {projectsOpen && !settingsOpen && !customizationOpen && (
            <ProjectsPage
              bridge={bridge}
              sessions={chat.sessions}
              nativeWindow={nativeWindow}
              canOpenProject={localPlatform}
              onDismiss={navigation.back}
              onCreate={async (input) => {
                await host.projects.register(input, { idempotencyKey: window.crypto.randomUUID() })
              }}
              onChanged={chat.refreshMenu}
              onDeleted={chat.applyMenuDeletion}
              onNewSession={async (cwd) => {
                if (await chat.newSessionInProject(cwd)) navigation.home()
              }}
              onSwitchSession={async (path) => {
                if (await chat.switchSession(path)) navigation.home()
              }}
              onTogglePin={async (cwd) => {
                await chat.togglePin(cwd)
              }}
              onPrefetchSession={(path) => void bridge.prefetchSession(path).catch(() => {})}
              notice={
                <ErrorNotice
                  message={chat.error}
                  onDismiss={() => chat.setError('')}
                  onOpenSettings={() => openSettings('general')}
                />
              }
              rail={
                <AppRail
                  profile={userProfile.profile}
                  profileLoading={userProfile.showPlaceholder}
                  {...pluginRailProps}
                  projectsActive
                  onHome={navigation.home}
                  onProjects={() => navigation.open({ kind: 'projects' })}
                  onPlugins={() => navigation.open({ kind: 'customization' })}
                  onSettings={() => openSettings('general')}
                  onUsage={() => openSettings('profile')}
                  onAccount={() => openSettings('account')}
                />
              }
            />
          )}

          {customizationOpen && (
            <div className={settingsOpen ? 'hidden' : 'flex min-h-0 flex-1 flex-col'} inert={settingsOpen}>
              <CustomizationPage
                plugins={pluginDescriptors}
                nativeWindow={nativeWindow}
                onDismiss={navigation.back}
                rail={
                  <AppRail
                    profile={userProfile.profile}
                    profileLoading={userProfile.showPlaceholder}
                    {...pluginRailProps}
                    pluginsActive
                    onHome={navigation.home}
                    onProjects={() => navigation.open({ kind: 'projects' })}
                    onPlugins={() => navigation.open({ kind: 'customization' })}
                    onSettings={() => openSettings('general')}
                    onUsage={() => openSettings('profile')}
                    onAccount={() => openSettings('account')}
                  />
                }
                renderContent={(section, selection) =>
                  section === 'plugins' ? (
                    <PluginPage
                      client={plugins}
                      plugins={pluginDescriptors}
                      errors={registry.errors()}
                      view="catalog"
                      selection={selection}
                      onSettings={() => openSettings('plugins')}
                      onChanged={async () => {
                        await refreshPlugins()
                        await chat.refreshSnapshot()
                      }}
                      onCreate={() => invokeSystemSkill('plugin-creator', '帮我创建一个插件')}
                      renderSettings={(id) => (
                        <PluginSlot registry={registry} pluginId={id} slot="settings" props={pluginProps} />
                      )}
                    />
                  ) : (
                    <SkillPage
                      client={resources}
                      cwd={cwd}
                      commands={chat.commands}
                      skillUsages={chat.chat.skillUsages}
                      resourceSnapshot={chat.state?.resourceSnapshot}
                      view="catalog"
                      onSettings={() => openSettings('skills')}
                      onChanged={chat.refreshSnapshot}
                      onUse={(command) => {
                        chat.setSelectedSkills([...chat.selectedSkills, command])
                        chat.setDraft(appendSkillInvocation(chat.draft))
                        chat.focusDraft()
                        navigation.home()
                      }}
                      onCreate={() => invokeSystemSkill('skill-creator')}
                    />
                  )
                }
              />
            </div>
          )}

          {pluginRoute && currentPluginPage && currentPluginNavigation && currentPluginHost && (
            <PluginWorkspacePage
              route={pluginRoute}
              page={currentPluginPage}
              navigation={currentPluginNavigation}
              pages={pluginPages}
              host={currentPluginHost}
              nativeWindow={nativeWindow}
              rail={
                <AppRail
                  profile={userProfile.profile}
                  profileLoading={userProfile.showPlaceholder}
                  {...pluginRailProps}
                  onHome={navigation.home}
                  onProjects={() => navigation.open({ kind: 'projects' })}
                  onPlugins={() => navigation.open({ kind: 'customization' })}
                  onSettings={() => openSettings()}
                  onUsage={() => openSettings('profile')}
                  onAccount={() => openSettings('account')}
                />
              }
              back={{ label: '返回上一页', onClick: navigation.back, disabled: !navigation.canBack }}
              forward={{ label: '前进', onClick: navigation.forward, disabled: !navigation.canForward }}
              onOpen={navigation.open}
              onParams={(params) => {
                const next = { ...pluginRoute, params }
                rememberPluginRoute(next)
                navigation.replace(next)
              }}
              onDirty={(dirty) => {
                if (dirty)
                  setDirtyPage({
                    pluginId: currentPluginPage.pluginId,
                    generation: currentPluginPage.generation,
                    routeInstance: pluginPageInstance,
                  })
                else {
                  setDirtyPage((value) => (value?.routeInstance === pluginPageInstance ? null : value))
                  if (currentPluginPageInstance.current === pluginPageInstance) setPluginPageError('')
                }
                void registry
                  .setPageDirty(currentPluginPage.pluginId, currentPluginPage.generation, pluginPageInstance, dirty)
                  .catch((cause) => {
                    if (currentPluginPageInstance.current === pluginPageInstance) setPluginPageError(String(cause))
                  })
              }}
              onManage={() => openSettings('plugins')}
              unavailableReason={pluginPageError || registry.getEditingError(currentPluginPage.pluginId)}
            />
          )}

          {/* 设置页面 */}
          {settingsSection && (
            <SettingsPage
              initialSection={settingsSection}
              dirty={instructionsDirty}
              saving={instructionsSaving}
              nativeWindow={nativeWindow}
              onDiscard={() => setInstructionsDirty(false)}
              onDismiss={navigation.back}
              onHome={navigation.home}
              dismissLabel="返回上一页"
              onProjects={() => navigation.open({ kind: 'projects' })}
              onPlugins={() => navigation.open({ kind: 'customization' })}
              renderRail={(onDismiss, navigate, onProjects, onPlugins) => (
                <AppRail
                  profile={userProfile.profile}
                  profileLoading={userProfile.showPlaceholder}
                  {...pluginRailProps}
                  onHome={onDismiss}
                  onProjects={onProjects}
                  onPlugins={onPlugins}
                  onSettings={() => navigate('general')}
                  onUsage={() => navigate('profile')}
                  onAccount={() => navigate('account')}
                />
              )}
              renderContent={(section, navigate) => {
                if (section === 'shortcuts') return <ShortcutSettings />
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
                  onEditor: (value) => void settings.saveEditor(value),
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
                        navigation.home()
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
                              navigation.home()
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
                if (section === 'subagents')
                  return (
                    <SubagentDefaultsSettings
                      models={chat.models}
                      value={settings.subagentDefaults}
                      loading={!settings.snapshot}
                      connected={!remoteOffline}
                      pending={settings.subagentPending}
                      status={settings.subagentStatus}
                      failed={settings.subagentFailed}
                      onSave={settings.saveSubagentDefaults}
                      onModels={() => navigate('models')}
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
                if (section === 'account')
                  return (
                    <AccountSettings
                      profile={userProfile.profile}
                      loading={userProfile.loading}
                      updateProfile={userProfile.updateProfile}
                    />
                  )
                if (section === 'profile') return <ProfileSettings {...{ loadUsage: bridge.getUsageStats }} />
                return null
              }}
            />
          )}

          <ShortcutHelpDialog
            open={shortcutHelpOpen}
            onOpenChange={setShortcutHelpOpen}
            onEdit={() => openSettings('shortcuts')}
          />
          <PluginConsentDialog consent={pluginConsent} />
          <Dialog
            open={navigation.confirmation}
            onOpenChange={(open) => {
              if (!open) navigation.cancelLeave()
            }}
          >
            <DialogContent>
              <DialogTitle>放弃未保存的更改？</DialogTitle>
              <DialogDescription>离开后，当前插件页面或指令中尚未保存的修改不会自动恢复。</DialogDescription>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={navigation.cancelLeave}>
                  继续编辑
                </Button>
                <Button onClick={navigation.discardAndLeave}>放弃修改并离开</Button>
              </div>
            </DialogContent>
          </Dialog>

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

          {creatingProject && (
            <ProjectDialog
              pickDirectory={bridge.pickProjectDirectory}
              onDismiss={() => setCreatingProject(false)}
              onCreate={async (input) => {
                const registered = await host.projects.register(input, { idempotencyKey: window.crypto.randomUUID() })
                void chat.refreshMenu().catch(() => {})
                void chat.selectWorkspace({ kind: 'project', cwd: registered.cwd }).catch((cause) => {
                  chat.setError(`项目已创建，切换失败：${String(cause)}`)
                })
              }}
            />
          )}
        </main>
      </TooltipProvider>
    </PluginRenderers>
  )
}
