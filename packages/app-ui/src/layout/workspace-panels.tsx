import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import {
  Copy,
  Download,
  ExternalLink,
  Globe,
  Grid2X2,
  History,
  Layers,
  LoaderCircle,
  MessageCircle,
  MessageSquarePlus,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Search,
  Settings,
  X,
} from 'lucide-react'
import { Button } from '@pi-meme/ui/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@pi-meme/ui/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@pi-meme/ui/components/ui/dropdown-menu'
import { OverflowTooltip, Tooltip, TooltipContent, TooltipTrigger } from '@pi-meme/ui/components/ui/tooltip'
import { BrowserFavicon, BrowserOmnibox } from '@pi-meme/browser/ui/browser-omnibox'
import { isLocalBrowserUrl } from '@pi-meme/browser/shared/navigation'
import type { BrowserPlatform, BrowserSnapshot, BrowserTab } from '@pi-meme/contracts/browser'
import type { UiContributionProps, UiPanel, UiTarget } from '@pi-meme/plugin-sdk/ui'
import type { RegisteredNavigation } from '@pi-meme/plugin-sdk/navigation'
import { AppRail } from './app-rail'
import { PageHeader } from './page-header'
import type { SidebarLayout } from './use-sidebar-layout'
import {
  useSidebarContainer,
  useWorkspaceSidebar,
  WorkspaceSidebar,
  type WorkspaceSidebarState,
} from './workspace-sidebar'
import type { UserProfile } from '../settings/user-profile'
import { useShortcutHandlers, useShortcuts } from '../shortcuts/shortcut-provider'
import {
  closePanel,
  defaultPanelLayout,
  openPanel,
  panelStorageKey,
  readPanelLayout,
  sanitizePanelLayout,
  sideChatTabId,
  toolsTabId,
  type PanelLayoutState,
} from './panel-layout'

import { RetainedToolPanels, type PanelOpenRequest } from './retained-tool-panels'
import { resolvePanelAvailability, type PanelDataFacts } from './panel-availability'
import { usePaneMotion } from './pane-motion'
import { ResizeHandle } from './resize-handle'
import type { WorkspaceView } from './use-workspace-view'

const emptyBrowserPanels: string[] = []
const emptyBrowserTabs: BrowserTab[] = []
const tabIconClassName =
  'flex size-3.5 shrink-0 items-center justify-center [&_img]:size-3.5 [&_img]:object-contain [&_svg]:size-3.5'

export function WorkspacePanels({
  panels,
  onOpenWebPage,
  browserPlatform,
  browserTabs = emptyBrowserTabs,
  onBrowserSettings,
  onClosePanel,
  browserPanelIds = emptyBrowserPanels,
  chatAnnotationCount = 0,
  focusComposerRequest,
  activity,
  dataFacts = {},
  onDataRetry,
  onToolsVisibilityChange,
  onSystemSnapshot,
  props,
  session,
  sessionTitle = '聊天',
  terminalCwd,
  onFocusComposer,
  requestPanel,
  onPanelRequestHandled,
  errors = {},
  requestRight,
  requestRightToken,
  onRightRequestHandled,
  sidebar,
  sidebarLayout,
  visible = true,
  workspaceView,
  header,
  profile,
  profileLoading,
  onSettings,
  onUsage,
  onAccount,
  onNewSession,
  onPlugins,
  onProjects,
  onMaterials,
  onSchedules,
  schedulesUnread,
  pluginNavigation,
  onPlugin,
  shortcutEnabled = true,
  onShortcutHelp,
  sideChat,
  sideChatActive,
  closingPanelIds,
  onOpenSideChat,
  onSideChatContainer,
  onSideChatVisibilityChange,
  onChatVisibilityChange,
  children,
}: {
  onOpenWebPage?: (url: string) => void
  browserPlatform?: BrowserPlatform
  browserTabs?: BrowserTab[]
  onBrowserSettings?: (section?: 'general' | 'history' | 'downloads' | 'clear') => void
  onClosePanel?: (id: string) => void | boolean | Promise<void | boolean>
  browserPanelIds?: string[]
  chatAnnotationCount?: number
  focusComposerRequest?: number
  panels: UiPanel[]
  activity?: { count: number; known: boolean }
  dataFacts?: PanelDataFacts
  onDataRetry?: () => void
  onToolsVisibilityChange?: (visible: boolean) => void
  onSystemSnapshot?: (snapshot: { sessionId: string; layout: PanelLayoutState } | null) => void
  props: UiContributionProps
  session: string
  sessionTitle?: string
  terminalCwd?: string
  onFocusComposer?: () => void
  errors?: Record<string, string>
  requestPanel?: {
    id: string
    revision: number
    target: UiTarget
    intent?: UiContributionProps['panelOpenIntent']
  } | null
  onPanelRequestHandled?: (revision: number) => void
  requestRight?: string
  requestRightToken?: string
  onRightRequestHandled?: () => void
  sidebar: ReactNode
  sidebarLayout: SidebarLayout
  visible?: boolean
  workspaceView: WorkspaceView
  header: (sidebar: WorkspaceSidebarState, workspaceTabs?: (menu?: ReactNode) => ReactNode) => ReactNode
  profile: UserProfile
  profileLoading: boolean
  onSettings?: () => void
  onUsage?: () => void
  onAccount?: () => void
  onNewSession?: () => void
  onPlugins?: () => void
  onMaterials?: () => void
  onProjects?: () => void
  onSchedules?: () => void
  schedulesUnread?: boolean
  pluginNavigation?: readonly RegisteredNavigation[]
  onPlugin?: (entry: RegisteredNavigation) => void
  shortcutEnabled?: boolean
  onShortcutHelp?: () => void
  sideChat?: ReactNode
  sideChatActive?: boolean
  closingPanelIds?: string[]
  onOpenSideChat?: () => void | boolean | Promise<void | boolean>
  onSideChatContainer?: (element: HTMLDivElement | null) => void
  onSideChatVisibilityChange?: (visible: boolean) => void
  onChatVisibilityChange?: (visible: boolean) => void
  children: ReactNode
}) {
  const { open: sidebarOpen, width: sidebarWidth, change: onSidebar } = sidebarLayout
  const storageKey = panelStorageKey(props.target.hostId, session)
  const readLayout = (): PanelLayoutState | undefined => {
    try {
      const raw = window.localStorage.getItem(storageKey)
      if (raw === null) return undefined
      // 损坏或旧版本存档按“无存档”处理，避免用默认布局覆盖原记录。
      if ((JSON.parse(raw) as { version?: unknown }).version !== 2) return undefined
      return readPanelLayout(raw)
    } catch {
      return undefined
    }
  }
  const [state, updateState] = useState(() => {
    const saved = readLayout()
    const initial = saved ?? defaultPanelLayout()
    const tabs =
      sideChatActive && !initial.tabs.includes(sideChatTabId) ? [...initial.tabs, sideChatTabId] : initial.tabs
    const active = sideChatActive ? sideChatTabId : initial.active
    const open = sideChatActive ? true : initial.open
    return {
      storageKey,
      openRequests: {} as Record<string, PanelOpenRequest>,
      inherited: false,
      layout: { ...initial, tabs, active, open },
      toolActive: saved?.toolActive ?? false,
    }
  })
  const { unified, change: setUnified } = workspaceView
  const toolActive = state.toolActive
  const setToolActive = useCallback((action: boolean | ((prev: boolean) => boolean)) => {
    updateState((value) => ({
      ...value,
      toolActive: typeof action === 'function' ? action(value.toolActive) : action,
    }))
  }, [])
  const [search, setSearch] = useState('')
  const [browserSnapshot, setBrowserSnapshot] = useState<BrowserSnapshot>()
  const [openError, setOpenError] = useState('')
  const openRevision = useRef(0)
  const handledRequest = useRef<number | undefined>(undefined)
  const handledRightRequest = useRef<string | undefined>(undefined)
  const [internalClosingTabs, setInternalClosingTabs] = useState<string[]>([])
  const isClosingTab = useCallback(
    (id: string) => internalClosingTabs.includes(id) || Boolean(closingPanelIds?.includes(id)),
    [internalClosingTabs, closingPanelIds],
  )
  if (state.storageKey !== storageKey) {
    const saved = readLayout()
    updateState({
      storageKey,
      openRequests: {},
      inherited: false,
      layout: saved ?? defaultPanelLayout(),
      toolActive: saved?.toolActive ?? false,
    })
    setSearch('')
    setOpenError('')
  }
  useEffect(() => {
    const bind = (event: Event) => {
      const detail = (event as CustomEvent<{ hostId: string; from: string; to: string }>).detail
      if (detail.hostId !== props.target.hostId) return
      const from = panelStorageKey(detail.hostId, detail.from)
      const to = panelStorageKey(detail.hostId, detail.to)
      updateState((value) => {
        if (value.storageKey !== from) return value
        try {
          const saved = localStorage.getItem(to)
          if (saved !== null) {
            const layout = readPanelLayout(saved)
            return { ...value, storageKey: to, layout, openRequests: {}, toolActive: layout.toolActive ?? false }
          }
          localStorage.setItem(to, JSON.stringify({ ...value.layout, toolActive: value.toolActive }))
        } catch {
          /* 保留内存中的状态。 */
        }
        return { ...value, storageKey: to }
      })
    }
    window.addEventListener('pi-meme:workspace-bound', bind)
    return () => window.removeEventListener('pi-meme:workspace-bound', bind)
  }, [props.target.hostId])
  const layout = state.layout
  useEffect(() => {
    onSystemSnapshot?.({ sessionId: session, layout: { ...layout, tabs: [...layout.tabs], toolActive } })
    return () => onSystemSnapshot?.(null)
  }, [onSystemSnapshot, session, layout, toolActive])
  const setLayout = useCallback((update: (value: PanelLayoutState) => PanelLayoutState) => {
    updateState((value) => ({ ...value, inherited: false, layout: update(value.layout) }))
  }, [])
  useEffect(() => {
    if (!browserPlatform) {
      setBrowserSnapshot(undefined)
      return
    }
    let cancelled = false
    const refresh = () => {
      void browserPlatform
        .snapshot()
        .then((value) => {
          if (!cancelled) setBrowserSnapshot(value)
        })
        .catch(() => {})
    }
    refresh()
    const release = browserPlatform.onEvent((event) => {
      if (event.type === 'changed') refresh()
    })
    return () => {
      cancelled = true
      release()
    }
  }, [browserPlatform])
  const { container, width: containerWidth } = useSidebarContainer()
  const launcherFocus = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const focused = launcherFocus.current
    if (!focused || focused.isConnected) return
    launcherFocus.current = null
    if (document.activeElement === document.body)
      container.current
        ?.querySelector<HTMLInputElement>(
          'input[aria-label="输入网址、搜索或打开工具"], input[aria-label="查找工具和插件"]',
        )
        ?.focus()
  })
  const tabList = useRef<HTMLDivElement>(null)
  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(sanitizePanelLayout({ ...layout, toolActive })))
    } catch {
      /* 浏览器禁用存储时仍可使用标签页。 */
    }
  }, [storageKey, layout, toolActive])
  const available = panels.filter((panel) => resolvePanelAvailability(panel, props.target, dataFacts).canRetain)
  const open = useCallback(
    (id: string, intent: PanelOpenRequest['intent'] = 'manual') => {
      if (id !== toolsTabId && id !== sideChatTabId) {
        const panel = panels.find((entry) => entry.id === id)
        const availability = panel && resolvePanelAvailability(panel, props.target, dataFacts)
        if (!availability || !(intent === 'launcher' ? availability.launcherVisible : availability.canExplicitOpen)) {
          setOpenError('此工具当前不可用。')
          return false
        }
      }
      setSearch('')
      setOpenError('')
      setToolActive(true)
      const request = { intent, revision: ++openRevision.current }
      updateState((value) => ({
        ...value,
        inherited: false,
        openRequests: { ...value.openRequests, [id]: request },
        layout: { ...openPanel(value.layout, id), open: unified ? value.layout.open : true },
      }))
      return true
    },
    [unified, panels, props.target, dataFacts],
  )
  useEffect(() => {
    if (!requestRight) {
      handledRightRequest.current = undefined
      return
    }
    const token = requestRightToken ?? requestRight
    if (handledRightRequest.current === token) return
    handledRightRequest.current = token
    open(requestRight, 'manual')
    onRightRequestHandled?.()
  }, [requestRight, requestRightToken, open, onRightRequestHandled])
  useEffect(() => {
    if (!requestPanel) {
      handledRequest.current = undefined
      return
    }
    if (handledRequest.current === requestPanel.revision) return
    handledRequest.current = requestPanel.revision
    const matches =
      requestPanel.target.hostId === props.target.hostId &&
      requestPanel.target.session?.sessionId === props.target.session?.sessionId &&
      requestPanel.target.project?.projectId === props.target.project?.projectId
    if (matches) {
      if (open(requestPanel.id, requestPanel.intent ?? 'manual') && requestPanel.id.startsWith('builtin:file:'))
        setUnified(true)
    }
    // 过期目标、撤权和未知面板均是终态，不能让旧请求永久阻塞后续打开。
    onPanelRequestHandled?.(requestPanel.revision)
  }, [requestPanel, open, props.target, onPanelRequestHandled, setUnified])
  const previousSideChatActive = useRef(sideChatActive)
  useEffect(() => {
    const previous = previousSideChatActive.current
    previousSideChatActive.current = sideChatActive
    if (previous && !sideChatActive) {
      setInternalClosingTabs((prev) => prev.filter((item) => item !== sideChatTabId))
      setLayout((value) => {
        if (!value.tabs.includes(sideChatTabId)) return value
        return closePanel(value, sideChatTabId)
      })
    } else if (!previous && sideChatActive) {
      setLayout((value) => {
        if (value.tabs.includes(sideChatTabId)) return { ...value, active: sideChatTabId, open: true }
        return {
          ...value,
          tabs: [...value.tabs, sideChatTabId],
          active: sideChatTabId,
          open: true,
        }
      })
    }
  }, [sideChatActive, setLayout])
  useEffect(() => {
    tabList.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [layout.active, layout.open, unified, toolActive])
  const visibleTabs = layout.tabs.filter(
    (id) => id === toolsTabId || id === sideChatTabId || available.some((panel) => panel.id === id),
  )
  const tabs = unified || visibleTabs.length ? visibleTabs : [toolsTabId]
  const active = tabs.includes(layout.active) ? layout.active : tabs[0]
  const selected = available.find((panel) => panel.id === active)
  const activeTool = toolActive && tabs.includes(layout.active)
  const showTool = unified && activeTool
  useEffect(() => {
    onChatVisibilityChange?.(!showTool)
    return () => onChatVisibilityChange?.(false)
  }, [showTool, onChatVisibilityChange])
  const toolsVisible =
    (unified ? showTool : layout.open) && !selected && active !== sideChatTabId && props.visible !== false
  useEffect(() => {
    const update = () => onToolsVisibilityChange?.(toolsVisible && !document.hidden)
    update()
    document.addEventListener('visibilitychange', update)
    return () => {
      document.removeEventListener('visibilitychange', update)
      onToolsVisibilityChange?.(false)
    }
  }, [toolsVisible, onToolsVisibilityChange])
  const sideChatVisible = active === sideChatTabId && (unified ? showTool : layout.open)
  useEffect(() => {
    onSideChatVisibilityChange?.(sideChatVisible)
  }, [sideChatVisible, onSideChatVisibilityChange])
  const selectTab = (id: string) => {
    setToolActive(id !== 'chat')
    if (id !== 'chat') setLayout((value) => ({ ...value, active: id }))
  }
  const closeTab = (id: string) => {
    if (isClosingTab(id)) return
    const restoreFocus = tabList.current?.contains(document.activeElement)

    const finalize = () => {
      setInternalClosingTabs((prev) => prev.filter((item) => item !== id))
      updateState((value) => {
        if (!value.layout.tabs.includes(id)) return value
        const openRequests = { ...value.openRequests }
        delete openRequests[id]
        const nextLayout = closePanel(value.layout, id)
        const nextVisibleTabs = nextLayout.tabs.filter(
          (tabId) => tabId === toolsTabId || tabId === sideChatTabId || available.some((panel) => panel.id === tabId),
        )
        const nextTabs = unified || nextVisibleTabs.length ? nextVisibleTabs : [toolsTabId]
        const nextToolActive = nextTabs.length === 1 && nextTabs[0] === toolsTabId ? false : value.toolActive
        return {
          ...value,
          inherited: false,
          openRequests,
          layout: {
            ...nextLayout,
            open: unified ? value.layout.open : nextLayout.tabs.length > 0,
          },
          toolActive: nextToolActive,
        }
      })
      if (restoreFocus) {
        requestAnimationFrame(() => {
          tabList.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus()
        })
      }
    }

    if (!onClosePanel) {
      finalize()
      return
    }

    setInternalClosingTabs((prev) => (prev.includes(id) ? prev : [...prev, id]))
    try {
      const outcome = onClosePanel(id)
      if (outcome && typeof (outcome as Promise<unknown>).then === 'function') {
        ;(outcome as Promise<void | boolean>)
          .then((success) => {
            if (success === false) {
              setInternalClosingTabs((prev) => prev.filter((item) => item !== id))
            } else {
              finalize()
            }
          })
          .catch(() => {
            setInternalClosingTabs((prev) => prev.filter((item) => item !== id))
          })
      } else if (outcome === false) {
        setInternalClosingTabs((prev) => prev.filter((item) => item !== id))
      } else {
        finalize()
      }
    } catch {
      setInternalClosingTabs((prev) => prev.filter((item) => item !== id))
    }
  }
  const previousUnified = useRef(unified)
  useLayoutEffect(() => {
    if (previousUnified.current === unified) return
    previousUnified.current = unified
    // 顶栏、快捷键和设置共用切换行为；首次恢复时保留已选工具。
    if (!unified && activeTool) setLayout((value) => ({ ...value, open: true }))
    setToolActive(false)
  }, [unified, activeTool, setLayout, setToolActive])
  const changeView = (next: boolean, forceTool = false) => {
    if (!next && forceTool) setLayout((value) => ({ ...value, open: true }))
    if (next === unified) setToolActive(false)
    setUnified(next)
  }
  const workspaceWidth = Math.max(0, containerWidth - (sidebarOpen ? sidebarWidth : 0))
  const maxWidth = Math.max(0, workspaceWidth - Math.min(480, containerWidth * 0.6))
  const rightWidth = Math.min(layout.width, maxWidth)
  const bothPanesFit = containerWidth - sidebarWidth >= 480 + 280
  useEffect(() => {
    if (visible && !unified && layout.open && sidebarOpen && !bothPanesFit) onSidebar(false, sidebarWidth)
  }, [visible, layout.open, sidebarOpen, bothPanesFit, sidebarWidth, onSidebar, unified])
  const browserIdsKey = browserPanelIds.join(',')
  useEffect(() => {
    if (!browserPanelIds.length) return
    setLayout((value) => {
      const missing = browserPanelIds.filter((id) => !value.tabs.includes(id))
      return missing.length
        ? { ...value, tabs: [...value.tabs, ...missing], active: value.active || missing[0] }
        : value
    })
  }, [browserIdsKey, storageKey, setLayout])
  useEffect(() => {
    if (!focusComposerRequest) return
    if (unified) setToolActive(false)
    requestAnimationFrame(() => onFocusComposer?.())
  }, [focusComposerRequest])
  const changeSidebar = useCallback(
    (open: boolean, width: number) => {
      if (!unified && open && containerWidth - width < 480 + 280) setLayout((value) => ({ ...value, open: false }))
      onSidebar(open, width)
    },
    [unified, containerWidth, onSidebar, setLayout],
  )
  const workspaceSidebar = useWorkspaceSidebar({
    layout: { ...sidebarLayout, change: changeSidebar },
    containerWidth,
    visible,
    shortcutEnabled,
  })
  const { pane: leftPane, flyout } = workspaceSidebar
  const rightPane = usePaneMotion(layout.open || unified, rightWidth, workspaceSidebar.reducedMotion)
  const containerRef = useRef(containerWidth)
  // 只在窗口尺寸变化时取消过渡。折叠左栏也会改变右栏上限，不能因此把左栏宽度动画关掉。
  useLayoutEffect(() => {
    if (containerRef.current === containerWidth) return
    containerRef.current = containerWidth
    rightPane.jump()
  }, [containerWidth, rightPane.jump])
  const toggleRight = () => {
    if (unified) changeView(false, true)
    else setLayout((value) => ({ ...value, open: !value.open }))
  }
  const shortcuts = useShortcuts()
  const toolsShortcut = shortcuts.getShortcutLabel('toggleTools')
  const fullViewShortcut = shortcuts.getShortcutLabel('toggleFullView')

  useShortcutHandlers(
    {
      toggleFullView: () => changeView(!unified),
      toggleTools: () => {
        if (unified) {
          if (!showTool && !tabs.length) open(toolsTabId)
          else setToolActive(!showTool)
        } else toggleRight()
      },
      focusComposer: onFocusComposer
        ? () => {
            setToolActive(false)
            requestAnimationFrame(onFocusComposer)
          }
        : undefined,
    },
    shortcutEnabled,
  )
  const handleOpenSideChat = () => {
    onOpenSideChat?.()
    open(sideChatTabId)
  }

  const normalizedSearch = search.trim().toLocaleLowerCase()
  const matchesSearch = (title: string) => title.toLocaleLowerCase().includes(normalizedSearch)
  const webHeroEnabled = Boolean(browserPlatform && onOpenWebPage)
  const sideChatLauncherVisible = Boolean(onOpenSideChat) && (webHeroEnabled || matchesSearch('侧边聊天'))
  const visiblePanels = available.filter(
    (panel) => panel.id !== sideChatTabId && resolvePanelAvailability(panel, props.target, dataFacts).launcherVisible,
  )
  const filtered = webHeroEnabled ? visiblePanels : visiblePanels.filter((panel) => matchesSearch(panel.title))
  const launcherTools = useMemo(
    () => [
      ...(onOpenSideChat ? [{ id: sideChatTabId, title: '侧边聊天', icon: <MessageSquarePlus /> }] : []),
      ...visiblePanels.map((panel) => ({ id: panel.id, title: panel.title, icon: panel.icon })),
    ],
    [onOpenSideChat, visiblePanels],
  )
  const frequentSites = useMemo(() => {
    if (!webHeroEnabled || !browserSnapshot?.history.length) return []
    const now = Date.now()
    return [...browserSnapshot.history]
      .sort((a, b) => {
        const localA = isLocalBrowserUrl(a.url) ? 25 : 0
        const localB = isLocalBrowserUrl(b.url) ? 25 : 0
        const ageA = Math.max(1, (now - Date.parse(a.visitedAt)) / 3_600_000)
        const ageB = Math.max(1, (now - Date.parse(b.visitedAt)) / 3_600_000)
        const scoreA = localA + (a.visitCount ?? 1) * 8 + 60 / ageA
        const scoreB = localB + (b.visitCount ?? 1) * 8 + 60 / ageB
        return scoreB - scoreA
      })
      .slice(0, 6)
  }, [webHeroEnabled, browserSnapshot?.history])
  const toolErrors = [
    ...new Set([
      ...Object.values(errors),
      ...Object.values(dataFacts).flatMap((fact) => (fact?.status === 'error' && fact.error ? [fact.error] : [])),
      ...(openError ? [openError] : []),
    ]),
  ]
  const directMotion = workspaceSidebar.directMotion || rightPane.dragging || rightPane.instant
  const overscroll = leftPane.overscroll ? 'sidebar' : rightPane.overscroll ? 'right' : undefined
  const shellStyle = {
    '--workspace-sidebar-width': `${leftPane.presented}px`,
    '--workspace-right-width': `${rightPane.presented}px`,
  } as CSSProperties

  const renderTabs = (menu?: ReactNode) => (
    <div className={unified ? 'flex min-w-0 flex-1 items-center gap-1' : 'contents'}>
      <div
        ref={tabList}
        role="tablist"
        aria-label={unified ? '工作区标签' : '右侧栏标签'}
        className="flex min-w-0 items-center gap-1 overflow-x-auto no-drag"
        style={{ scrollbarWidth: 'none' }}
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          const navigationTabs = unified ? ['chat', ...tabs] : tabs
          const index = navigationTabs.indexOf(unified && !showTool ? 'chat' : active)
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? navigationTabs.length - 1
                : (index + (event.key === 'ArrowRight' ? 1 : -1) + navigationTabs.length) % navigationTabs.length
          event.preventDefault()
          selectTab(navigationTabs[next])
          tabList.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
        }}
      >
        {unified && (
          <div
            className={`group flex shrink-0 items-center rounded-lg ${!showTool ? 'bg-background/80 text-foreground shadow-xs' : 'text-muted-foreground hover:bg-background/40'}`}
          >
            <button
              type="button"
              role="tab"
              id="workspace-chat-tab"
              aria-selected={!showTool}
              aria-controls="chat-workspace"
              tabIndex={!showTool ? 0 : -1}
              onClick={() => selectTab('chat')}
              className="flex h-7 w-40 max-w-60 items-center gap-1.5 pl-2.5 pr-1 text-xs"
            >
              <span aria-hidden="true" className={tabIconClassName}>
                <MessageCircle />
              </span>
              <OverflowTooltip content={sessionTitle}>
                <span className="min-w-0 flex-1 truncate">{sessionTitle}</span>
              </OverflowTooltip>
              {showTool && chatAnnotationCount > 0 && (
                <span
                  aria-label={`${chatAnnotationCount} 条待发送批注`}
                  className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-primary/15 px-1 text-[10px] font-semibold tabular-nums text-primary"
                >
                  {chatAnnotationCount}
                </span>
              )}
            </button>
            {menu}
          </div>
        )}
        {tabs.map((id) => {
          const panel = available.find((entry) => entry.id === id)
          const isSideChat = id === sideChatTabId
          const directory = id === 'builtin:terminal' ? terminalCwd : undefined
          const title = directory || (isSideChat ? (panel?.title ?? '侧边聊天') : (panel?.title ?? '新标签页'))
          const browserTab = id.startsWith('builtin:browser:')
          const browserId = browserTab ? id.slice(16) : undefined
          const browserTabItem = browserId ? browserTabs.find((item) => item.id === browserId) : undefined
          const closing = isClosingTab(id)
          const icon = panel?.icon ?? (isSideChat ? <MessageSquarePlus /> : <Grid2X2 />)
          const tabChip = (
            <div
              key={id}
              onAuxClick={(event) => {
                if (event.button === 1) {
                  event.preventDefault()
                  closeTab(id)
                }
              }}
              className={`group flex min-w-0 shrink-0 items-center ${browserTab ? 'rounded-xl border border-transparent' : 'rounded-md'} ${active === id && (!unified || showTool) ? (browserTab ? 'border-border/60 bg-secondary/80 text-foreground shadow-xs' : 'bg-background/80 text-foreground shadow-xs') : 'text-muted-foreground hover:bg-background/40'}`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active === id && (!unified || showTool)}
                id={`workspace-tool-tab-${id}`}
                aria-controls="right-tool-content"
                tabIndex={active === id && (!unified || showTool) ? 0 : -1}
                onClick={() => selectTab(id)}
                className={`flex h-7 min-w-0 items-center gap-1.5 pl-2.5 pr-1 text-xs ${browserTab || directory ? 'min-w-28 max-w-56' : unified ? 'min-w-20 max-w-36' : ''}`}
              >
                <span aria-hidden="true" className={tabIconClassName}>
                  {icon}
                </span>
                <OverflowTooltip content={title}>
                  <span className={`${directory ? 'max-w-48' : 'max-w-28'} min-w-0 truncate`}>{title}</span>
                </OverflowTooltip>
                {browserTabItem?.keepAlive ? (
                  <Pin aria-label="后台常驻运行中" className="size-2.5 shrink-0 text-primary" />
                ) : null}
              </button>
              <button
                type="button"
                aria-label={closing ? `正在关闭标签页：${title}` : `关闭标签页：${title}`}
                disabled={closing}
                aria-busy={closing || undefined}
                className={`mr-1 inline-flex items-center rounded p-1 text-muted-foreground transition-opacity duration-200 ease-out hover:bg-background/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed ${closing ? 'opacity-100 pointer-events-auto text-muted-foreground/60' : browserTab ? 'opacity-70 hover:opacity-100' : 'opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto'}`}
                onClick={(event) => {
                  event.stopPropagation()
                  closeTab(id)
                }}
              >
                {closing ? <LoaderCircle className="size-3 animate-spin" /> : <X className="size-3" />}
              </button>
            </div>
          )
          if (!browserTab || !browserId) return tabChip
          const hasWebUrl = Boolean(browserTabItem?.url && browserTabItem.url !== 'about:blank')
          return (
            <ContextMenu key={id}>
              <ContextMenuTrigger asChild>{tabChip}</ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onSelect={() => void browserPlatform?.command(browserId, { type: 'reload' })}>
                  <RefreshCw />
                  重新加载
                </ContextMenuItem>
                <ContextMenuItem
                  onSelect={() => {
                    if (!browserPlatform) return
                    const ensure = browserTabItem
                      ? browserPlatform.create(browserTabItem.owner, browserId, browserTabItem.url)
                      : Promise.resolve()
                    void ensure
                      .then(() =>
                        browserPlatform.command(browserId, {
                          type: 'keep-alive',
                          enabled: !browserTabItem?.keepAlive,
                        }),
                      )
                      .catch(() => {})
                  }}
                >
                  {browserTabItem?.keepAlive ? <PinOff /> : <Pin />}
                  {browserTabItem?.keepAlive ? '取消后台常驻' : '后台常驻运行'}
                </ContextMenuItem>
                <ContextMenuItem
                  disabled={!hasWebUrl}
                  onSelect={() => {
                    if (browserTabItem?.url) void navigator.clipboard.writeText(browserTabItem.url)
                  }}
                >
                  <Copy />
                  复制网址
                </ContextMenuItem>
                <ContextMenuItem
                  disabled={!hasWebUrl}
                  onSelect={() => void browserPlatform?.command(browserId, { type: 'external' })}
                >
                  <ExternalLink />
                  在系统浏览器打开
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => closeTab(id)}>关闭标签页</ContextMenuItem>
                <ContextMenuItem
                  disabled={!tabs.some((other) => other !== id)}
                  onSelect={() => {
                    for (const other of tabs) {
                      if (other !== id) closeTab(other)
                    }
                  }}
                >
                  关闭其他标签页
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          )
        })}
      </div>
      <div
        className={`flex items-center gap-1 shrink-0 no-drag ${unified ? '[&>button]:size-6 [&>button>svg]:size-3.5' : ''}`}
      >
        <HeaderButton label="新标签页" onClick={() => open(toolsTabId)}>
          <Plus />
        </HeaderButton>
      </div>
    </div>
  )

  return (
    <div
      data-view={unified ? 'unified' : 'split'}
      data-motion={directMotion ? 'direct' : 'slide'}
      data-pane-sidebar={sidebarOpen ? 'open' : 'closed'}
      data-pane-right={unified || layout.open ? 'open' : 'closed'}
      data-overscroll={overscroll}
      style={shellStyle}
      className="workspace-panes flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-secondary"
    >
      {/* 顶部栏：位于最外层外框中，与最左侧 ICON 栏同底色 */}
      <PageHeader>
        <div className="workspace-main-header flex h-full min-w-0 overflow-hidden bg-transparent window-drag">
          {header(workspaceSidebar, unified ? renderTabs : undefined)}
        </div>
        {!unified && rightPane.mounted && (
          <div
            className="right-pane relative flex h-full shrink-0 overflow-hidden bg-transparent window-drag"
            style={{ width: 'var(--workspace-right-width)' }}
            data-testid="right-panel-header"
          >
            {/* 与下方右侧栏左边缘严格对齐的短竖向分割线，折叠时隐藏 */}
            {layout.open && <div className="absolute left-0 top-1/2 -translate-y-1/2 h-4 w-px bg-border shrink-0" />}
            {/* 内容靠右钉住。栏宽拉开时从左侧露出，而不是等宽度到位后整组冒出来。 */}
            <div
              className="pane-clip flex h-full w-full items-center justify-between pl-3 pr-2"
              style={{ width: rightPane.dragging ? '100%' : rightWidth }}
            >
              {renderTabs()}
            </div>
          </div>
        )}
        <div className="absolute inset-y-0 right-3 z-10 flex items-center no-drag">
          <HeaderButton
            label={`${unified ? '退出完整视图' : '进入完整视图'}${fullViewShortcut ? ` · ${fullViewShortcut}` : ''}`}
            ariaLabel={unified ? '退出完整视图' : '进入完整视图'}
            pressed={unified}
            onClick={() => changeView(!unified)}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              style={{ width: 14, height: 14 }}
            >
              <path d={unified ? 'M14 3v7h7M3 14h7v7' : 'M14 3h7v7M3 14v7h7'} />
            </svg>
          </HeaderButton>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={toggleRight}
                aria-label={unified ? '分栏显示工具' : layout.open ? '收起右侧栏' : '展开右侧栏'}
                aria-expanded={layout.open}
                aria-controls="workspace-right-sidebar"
                className="relative size-7 text-muted-foreground hover:text-foreground cursor-pointer"
              >
                {layout.open ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}
                {Boolean(activity?.count) && (
                  <span
                    aria-label={`${activity!.count} 个活动服务`}
                    className="absolute -right-1 -top-1 min-w-3.5 rounded-full bg-primary px-0.5 text-[9px] leading-3.5 text-primary-foreground tabular-nums"
                  >
                    {activity!.count}
                  </span>
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {unified
                ? '分栏显示工具'
                : activity?.count
                  ? `本会话有 ${activity.count} 个活动服务${toolsShortcut ? ` · ${toolsShortcut}` : ''}`
                  : layout.open
                    ? `收起右侧栏${toolsShortcut ? ` · ${toolsShortcut}` : ''}`
                    : `展开右侧栏${toolsShortcut ? ` · ${toolsShortcut}` : ''}`}
            </TooltipContent>
          </Tooltip>
        </div>
      </PageHeader>

      {/* 顶部栏下方：最左侧为 AppRail，右侧为圈起来的圆角内容框体 */}
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {/* 最左侧：AppRail（与顶部外框同色） */}
        <AppRail
          profile={profile}
          profileLoading={profileLoading}
          pluginNavigation={pluginNavigation}
          onPlugin={onPlugin}
          homeActive
          onHome={() => {
            // 首页入口开新会话，浮层里旧的会话列表不必继续悬在正文上。
            flyout.close()
            onNewSession?.()
          }}
          sidebarFlyout={flyout.control ? { entry: 'home', control: flyout.control } : undefined}
          onProjects={onProjects}
          onMaterials={onMaterials}
          onSchedules={onSchedules}
          schedulesUnread={schedulesUnread}
          onPlugins={onPlugins}
          onSettings={onSettings}
          onUsage={onUsage}
          onAccount={onAccount}
          onShortcutHelp={onShortcutHelp}
        />

        {/* 内容部分：被有圆角框体圈起来的 3 部分容器（四角全圆角，右侧与底部留外框边距，复刻 Codex 设计） */}
        <div ref={container} className="content-frame relative bg-background">
          <WorkspaceSidebar sidebar={workspaceSidebar} label="会话导航">
            {sidebar}
          </WorkspaceSidebar>
          <div
            id="chat-workspace"
            role={unified ? 'tabpanel' : undefined}
            aria-labelledby={unified ? 'workspace-chat-tab' : undefined}
            aria-hidden={showTool}
            inert={showTool}
            style={{ display: showTool ? 'none' : undefined }}
            className="theme-workspace flex min-h-0 min-w-0 flex-1 flex-col bg-background"
          >
            {children}
          </div>
          <div
            className="right-pane relative flex min-w-0 shrink-0 border-l border-[var(--surface-hairline)]"
            style={{
              width: unified ? undefined : 'var(--workspace-right-width)',
              flex: unified ? 1 : undefined,
              display: !rightPane.mounted || (unified && !showTool) ? 'none' : undefined,
              borderLeft: unified ? 'none' : undefined,
            }}
          >
            {!unified && layout.open && (
              <ResizeHandle
                side="right"
                width={rightPane.presented}
                min={Math.min(280, maxWidth)}
                max={maxWidth}
                onDragStart={rightPane.beginDrag}
                onDrag={rightPane.dragTo}
                onDragCancel={rightPane.cancelDrag}
                onDragEnd={(result) => {
                  rightPane.endDrag(result)
                  setLayout((value) =>
                    result.collapse ? { ...value, open: false } : { ...value, open: true, width: result.width },
                  )
                }}
              />
            )}
            <aside
              id="workspace-right-sidebar"
              aria-label="右侧栏"
              aria-hidden={unified ? !showTool : !layout.open}
              inert={unified ? !showTool : !layout.open}
              className="flex min-h-0 w-full flex-col overflow-hidden bg-card/40"
              onKeyDown={(event) => {
                if (
                  event.key !== 'Escape' ||
                  event.defaultPrevented ||
                  (event.target as HTMLElement).closest('[role="dialog"]')
                )
                  return
                event.stopPropagation()
                if (unified) {
                  setToolActive(false)
                  tabList.current?.querySelector<HTMLButtonElement>('[role="tab"]')?.focus()
                } else setLayout((value) => ({ ...value, open: false }))
              }}
            >
              <div
                id="right-tool-content"
                role="tabpanel"
                aria-label={
                  unified ? undefined : active === sideChatTabId ? '侧边聊天' : (selected?.title ?? '新标签页')
                }
                className="pane-clip flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden @container"
                style={{ width: unified || rightPane.dragging ? '100%' : rightWidth }}
                aria-labelledby={unified ? `workspace-tool-tab-${active}` : undefined}
              >
                {tabs.includes(sideChatTabId) && sideChat ? (
                  <div
                    ref={onSideChatContainer}
                    hidden={active !== sideChatTabId}
                    className={
                      active === sideChatTabId ? 'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden' : 'hidden'
                    }
                  >
                    {sideChat}
                  </div>
                ) : null}
                <RetainedToolPanels
                  session={storageKey}
                  panels={available.filter((panel) => panel.id !== sideChatTabId)}
                  tabs={layout.tabs}
                  active={active}
                  visible={unified ? showTool : layout.open}
                  contribution={props}
                  openRequests={state.openRequests}
                />
                {!selected && active !== sideChatTabId ? (
                  <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-6 @min-[40rem]:px-8 @min-[40rem]:pt-[14vh]">
                    <div className="mx-auto w-full max-w-2xl space-y-6">
                      <div>
                        {webHeroEnabled ? (
                          <BrowserOmnibox
                            variant="hero"
                            platform={browserPlatform}
                            value={search}
                            onChange={setSearch}
                            searchEngine={browserSnapshot?.settings.search}
                            searchSuggestionsEnabled={browserSnapshot?.settings.searchSuggestions !== false}
                            history={browserSnapshot?.history}
                            searchQueries={browserSnapshot?.searchQueries}
                            openTabs={browserTabs}
                            tools={launcherTools}
                            placeholder="输入网址、搜索或打开工具"
                            autoFocus
                            onSubmitUrl={(input) => {
                              setSearch('')
                              onOpenWebPage?.(input)
                            }}
                            onSwitchTab={(tabId) => {
                              setSearch('')
                              open(`builtin:browser:${tabId}`)
                            }}
                            onSelectTool={(toolId) => {
                              setSearch('')
                              if (toolId === sideChatTabId) handleOpenSideChat()
                              else open(toolId, 'launcher')
                            }}
                            onRemoveSearchQuery={(query) => void browserPlatform?.searchQuery({ remove: query })}
                          />
                        ) : (
                          <form
                            onSubmit={(event) => {
                              event.preventDefault()
                              const firstId = sideChatLauncherVisible ? sideChatTabId : filtered[0]?.id
                              if (!firstId) return
                              setSearch('')
                              if (firstId === sideChatTabId) handleOpenSideChat()
                              else open(firstId, 'launcher')
                            }}
                          >
                            <label className="flex h-11 min-w-0 flex-1 items-center gap-2.5 rounded-full border border-border/60 bg-secondary/55 px-4 text-sm text-muted-foreground shadow-xs focus-within:border-ring/60 focus-within:bg-secondary/80">
                              <Search className="size-4 shrink-0 text-muted-foreground" />
                              <input
                                autoFocus
                                aria-label="查找工具和插件"
                                placeholder="查找工具和插件"
                                value={search}
                                onChange={(event) => setSearch(event.target.value)}
                                className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                              />
                              {search ? (
                                <button
                                  type="button"
                                  aria-label="清空输入"
                                  onClick={() => setSearch('')}
                                  className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground"
                                >
                                  <X className="size-3" />
                                </button>
                              ) : null}
                            </label>
                          </form>
                        )}
                      </div>

                      <div>
                        <div className="mb-2.5 flex items-center justify-between">
                          <h2 className="text-xs font-medium text-muted-foreground">打开</h2>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                size="icon-sm"
                                variant="ghost"
                                aria-label="更多启动台操作"
                                className="size-7 rounded-full text-muted-foreground hover:text-foreground"
                              >
                                <MoreHorizontal className="size-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" side="bottom" className="w-44">
                              <DropdownMenuItem disabled={!onNewSession} onSelect={onNewSession}>
                                <Globe />
                                新会话
                              </DropdownMenuItem>
                              <DropdownMenuItem disabled={!onPlugins} onSelect={onPlugins}>
                                <Layers />
                                扩展中心
                              </DropdownMenuItem>
                              {onBrowserSettings ? (
                                <>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem onSelect={() => onBrowserSettings('history')}>
                                    <History />
                                    历史记录
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onSelect={() => onBrowserSettings('downloads')}>
                                    <Download />
                                    下载记录
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onSelect={() => onBrowserSettings('general')}>
                                    <Settings />
                                    浏览器设置
                                  </DropdownMenuItem>
                                </>
                              ) : null}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>

                        <div
                          className="grid grid-cols-2 gap-2.5 @min-[36rem]:grid-cols-4"
                          onFocusCapture={(event) => {
                            launcherFocus.current = event.target as HTMLElement
                          }}
                        >
                          {sideChatLauncherVisible && (
                            <button
                              type="button"
                              onClick={handleOpenSideChat}
                              className="group flex min-h-20 min-w-0 flex-col items-start justify-between gap-3 rounded-xl border border-border/40 bg-secondary/40 p-3.5 text-left text-sm text-foreground transition-colors hover:bg-secondary/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
                            >
                              <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground group-hover:text-foreground [&>svg]:size-4">
                                <MessageSquarePlus />
                              </span>
                              <span className="w-full truncate text-xs font-medium">侧边聊天</span>
                            </button>
                          )}
                          {filtered.map((panel) => (
                            <button
                              key={panel.id}
                              type="button"
                              onClick={() => open(panel.id, 'launcher')}
                              className="group flex min-h-20 min-w-0 flex-col items-start justify-between gap-3 rounded-xl border border-border/40 bg-secondary/40 p-3.5 text-left text-sm text-foreground transition-colors hover:bg-secondary/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
                            >
                              <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground group-hover:text-foreground [&>svg]:size-4">
                                {panel.icon}
                              </span>
                              <span className="w-full truncate text-xs font-medium">{panel.title}</span>
                            </button>
                          ))}
                        </div>
                        {!filtered.length && !sideChatLauncherVisible && !toolErrors.length && (
                          <p className="py-4 text-xs text-muted-foreground">
                            {normalizedSearch ? '没有匹配的工具。' : '当前聊天暂无可用工具。'}
                          </p>
                        )}
                      </div>

                      {frequentSites.length > 0 ? (
                        <div>
                          <h2 className="mb-2.5 text-xs font-medium text-muted-foreground">常访与最近</h2>
                          <div className="grid grid-cols-1 gap-2 @min-[28rem]:grid-cols-2 @min-[42rem]:grid-cols-3">
                            {frequentSites.map((item) => {
                              const host = (() => {
                                try {
                                  return new URL(item.url).host
                                } catch {
                                  return item.url
                                }
                              })()
                              return (
                                <div
                                  key={item.id}
                                  className="group relative flex min-w-0 items-center rounded-xl border border-border/40 bg-secondary/35 transition-colors hover:bg-secondary/65"
                                >
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <button
                                        type="button"
                                        onClick={() => onOpenWebPage?.(item.url)}
                                        className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2.5 pr-8 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-xl cursor-pointer"
                                      >
                                        <BrowserFavicon src={item.favicon} className="size-4 shrink-0" />
                                        <div className="min-w-0 flex-1">
                                          <p className="truncate text-xs font-medium text-foreground">
                                            {item.title || host}
                                          </p>
                                          <p className="truncate text-[11px] text-muted-foreground">{host}</p>
                                        </div>
                                      </button>
                                    </TooltipTrigger>
                                    <TooltipContent side="bottom">{item.url}</TooltipContent>
                                  </Tooltip>
                                  <button
                                    type="button"
                                    aria-label={`移除常访记录：${item.title || host}`}
                                    onClick={(event) => {
                                      event.stopPropagation()
                                      void browserPlatform?.history(item.id)
                                    }}
                                    className="absolute right-1.5 inline-flex size-5 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-background/70 hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
                                  >
                                    <X className="size-3" />
                                  </button>
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      ) : null}

                      {toolErrors.length > 0 && (
                        <div role="alert" className="mt-3 flex items-start gap-2 text-xs text-destructive">
                          <p className="min-w-0 flex-1 break-words">{toolErrors.join('；')}</p>
                          {onDataRetry && (
                            <button
                              type="button"
                              className="shrink-0 rounded underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              onClick={() => {
                                setOpenError('')
                                onDataRetry?.()
                              }}
                            >
                              重试
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ) : null}
              </div>
            </aside>
          </div>
        </div>
      </div>
    </div>
  )
}

function HeaderButton({
  label,
  ariaLabel,
  pressed,
  onClick,
  children,
}: {
  label: string
  ariaLabel?: string
  pressed?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel ?? label}
          aria-pressed={pressed}
          onClick={onClick}
          className="flex size-7 shrink-0 items-center justify-center rounded-lg aria-pressed:bg-background/80 aria-pressed:text-foreground text-muted-foreground hover:bg-secondary hover:text-foreground no-drag [&>svg]:size-4"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}
