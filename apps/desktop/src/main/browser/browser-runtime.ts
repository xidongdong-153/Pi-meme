import { existsSync, constants } from 'node:fs'
import { lstat, mkdir, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  app,
  BrowserWindow,
  WebContentsView,
  dialog,
  ipcMain,
  session,
  shell,
  systemPreferences,
  type DownloadItem,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  BrowserAnnotation,
  BrowserAnnotationMode,
  BrowserCommand,
  BrowserDownload,
  BrowserEvent,
  BrowserOverlayAction,
  BrowserOverlayAnnotationItem,
  BrowserOverlayState,
  BrowserPermission,
  BrowserRect,
  BrowserSnapshot,
  BrowserSuggestion,
  BrowserTab,
  BrowserViewMode,
  BrowserWorkspace,
  BrowserWorkspaceMetadata,
} from '@pi-meme/contracts/browser'
import type { ThemeColors } from '@pi-meme/contracts/settings'
import { browserUrl, isLikelyUrlInput, isLocalBrowserUrl } from '@pi-meme/browser/shared/navigation'
import { validAnnotation } from '@pi-meme/browser/shared/annotations'
import {
  browserClientReadNames,
  clientReadList,
  clientReadPage,
  systemMetadataUrl,
} from '@pi-meme/contracts/system-client-reads'
import {
  browserAgentOperations,
  browserBatchMaxSteps,
  type BrowserActionReceipt,
  type BrowserAgentSelectorTarget,
  type BrowserAgentSnapshot,
  type BrowserAgentTarget,
  type BrowserBatchStep,
  type BrowserPreparedUploadFile,
  type BrowserReadOptions,
  type BrowserScrollInput,
  type BrowserSelectOption,
  type BrowserWaitCondition,
  type BrowserWaitObservation,
} from '@pi-meme/contracts/browser-agent'
import {
  readInteger,
  readText,
  readRecord,
  SystemReadError,
  validateReadArguments,
} from '@pi-meme/contracts/system-read'
import { runBrowserAgentPage } from './browser-agent-page'
import { BrowserCdpController } from './browser-debugger'

const agentDefinitions = new Map(browserAgentOperations.map((operation) => [operation.name, operation]))
function agentTabMetadata(tab: BrowserTab): Omit<BrowserTab, 'favicon'> {
  const { id, owner, title, documentId, zoom, loading, canGoBack, canGoForward, error, keepAlive } = tab
  return {
    id,
    owner,
    title: title.slice(0, 512),
    documentId,
    zoom,
    loading,
    canGoBack,
    canGoForward,
    error,
    ...(keepAlive ? { keepAlive: true } : {}),
    url: systemMetadataUrl(tab.url),
  }
}

function waitUrl(input: string) {
  const url = URL.parse(input)
  if (!url || url.username || url.password) return undefined
  if (url.href === 'about:blank') return url.href
  return ['http:', 'https:'].includes(url.protocol) ? url.origin + url.pathname : undefined
}

type Rpc = <T>(method: string, args?: unknown[]) => Promise<T>
type Tab = {
  state: BrowserTab
  view: WebContentsView
  bounds?: BrowserRect
  enabled: boolean
  mode: BrowserAnnotationMode
  viewMode: BrowserViewMode
  original: boolean
  theme: 'dark' | 'light'
  colors?: ThemeColors
  annotations: BrowserAnnotation[]
  editorVisible: boolean
  editor?: BrowserAnnotation
  editorPosition?: BrowserRect
  editorOriginal?: BrowserAnnotation
  editorScreenshotInitial?: BrowserSnapshot['settings']['screenshots']
  editorError?: string
  editorHeight?: number
  expanded: boolean
  hidden: boolean
  toolbarOffset: { x: number; y: number }
  toolbarWidth?: number
  toolbarHeight?: number
  toolbarMenuOpen: boolean
  screenshot: BrowserSnapshot['settings']['screenshots']
  find?: { requestId: number; text: string }
  capture?: Promise<string>
  cdp: BrowserCdpController
  domReady: boolean
  agentAbort?: AbortController
  agentActivity?: { active: boolean; label?: string }
  agentHandoff?: { reason: string; actionHint?: string }
  lastViewport: { width: number; height: number }
  agentKeepAliveUntil: number
  agentKeepAliveTimer?: ReturnType<typeof setTimeout>
  uploadTempDirs: string[]
  popupCollector?: Array<{ tabId: string; url: string }>
}
type Overlay = { view: WebContentsView; kind: 'editor' | 'toolbar'; tab: Tab }

export function registerBrowserRuntime(options: {
  getWindow: () => BrowserWindow | null
  origin: () => string
  rpc: Rpc
}) {
  const tabs = new Map<string, Tab>()
  const visitedWorkspaces = new Set<string>()
  const overlays = new Set<Overlay>()
  const activeDownloads = new Map<string, DownloadItem>()
  const guestSession = session.fromPartition('persist:pi-meme-browser-v1')
  let snapshot: BrowserSnapshot | undefined
  let attachedWindow: BrowserWindow | undefined
  let visible: Tab | undefined
  let lastFocusedSurface: 'window' | 'overlay' | string = 'window'
  let permissionPending = false
  let overlayBusy = false
  let submitBusy = false
  const refresh = async () => {
    snapshot = await options.rpc<BrowserSnapshot>('browser:snapshot')
    return snapshot
  }
  const emit = (event: BrowserEvent) => {
    const window = options.getWindow()
    if (window && !window.isDestroyed()) window.webContents.send('browser:event', event)
  }
  const changed = () => emit({ type: 'changed' })
  const liveWeb = (view: WebContentsView): WebContents | undefined => {
    try {
      const web = view.webContents as WebContents | undefined
      return web && !web.isDestroyed() ? web : undefined
    } catch {
      return undefined
    }
  }
  const tabFor = (sender: WebContents) => [...tabs.values()].find((tab) => liveWeb(tab.view) === sender)
  const overlayFor = (sender: WebContents) => [...overlays].find((item) => liveWeb(item.view) === sender)
  const detachTabView = (tab: Tab) => {
    // Electron can give an attached view native focus during navigation even when it is hidden.
    tab.view.setVisible(false)
    if (attachedWindow && !attachedWindow.isDestroyed()) attachedWindow.contentView.removeChildView(tab.view)
  }
  const isKeepAliveEffective = (tab: Tab) => Boolean(tab.state.keepAlive || tab.agentKeepAliveUntil > Date.now())
  const syncTabHosting = (tab: Tab) => {
    const web = liveWeb(tab.view)
    if (!web) return
    const keepAlive = isKeepAliveEffective(tab)
    if (visible === tab) {
      web.setBackgroundThrottling(!keepAlive)
      return
    }
    if (
      keepAlive &&
      !tab.state.error &&
      tab.state.url !== 'about:blank' &&
      attachedWindow &&
      !attachedWindow.isDestroyed()
    ) {
      web.setBackgroundThrottling(false)
      tab.view.setBounds({
        x: -20_000,
        y: -20_000,
        width: tab.lastViewport.width,
        height: tab.lastViewport.height,
      })
      if (!attachedWindow.contentView.children.includes(tab.view)) attachedWindow.contentView.addChildView(tab.view)
      tab.view.setVisible(true)
      return
    }
    web.setBackgroundThrottling(true)
    detachTabView(tab)
  }
  const clearAgentKeepAlive = (tab: Tab) => {
    tab.agentKeepAliveUntil = 0
    if (tab.agentKeepAliveTimer) {
      clearTimeout(tab.agentKeepAliveTimer)
      tab.agentKeepAliveTimer = undefined
    }
  }
  const touchAgentKeepAlive = (tab: Tab, durationMs = 30_000) => {
    tab.agentKeepAliveUntil = Math.max(tab.agentKeepAliveUntil, Date.now() + durationMs)
    if (tab.agentKeepAliveTimer) clearTimeout(tab.agentKeepAliveTimer)
    const delay = Math.max(100, tab.agentKeepAliveUntil - Date.now() + 50)
    tab.agentKeepAliveTimer = setTimeout(() => {
      tab.agentKeepAliveTimer = undefined
      syncTabHosting(tab)
    }, delay)
    syncTabHosting(tab)
  }
  const publish = (tab: Tab) => emit({ type: 'tab', tab: { ...tab.state } })
  const preview = (tab: Tab) =>
    tab.state.error || tab.state.url === 'about:blank'
      ? Promise.resolve(null)
      : tab.view.webContents
          .capturePage()
          .then((image) => image.resize({ width: Math.min(1200, image.getSize().width) }).toDataURL())
          .catch(() => null)
  const closeOverlays = (kind?: Overlay['kind']) => {
    for (const item of overlays)
      if (!kind || item.kind === kind) {
        overlays.delete(item)
        if (item.kind === 'toolbar') item.tab.toolbarMenuOpen = false
        if (attachedWindow && !attachedWindow.isDestroyed()) attachedWindow.contentView.removeChildView(item.view)
        liveWeb(item.view)?.close()
      }
  }
  const picker = (tab: Tab, value: object) => {
    liveWeb(tab.view)?.send('browser:picker', value)
  }
  const visibleMarkers = (tab: Tab) =>
    tab.annotations.flatMap((annotation, index) =>
      annotation.tabId === tab.state.id && annotation.documentId === tab.state.documentId
        ? [{ ...annotation, markerNumber: index + 1 }]
        : [],
    )
  const overlayItems = (tab: Tab): BrowserOverlayAnnotationItem[] =>
    tab.annotations.map((annotation, index) => ({
      id: annotation.id,
      markerNumber: index + 1,
      tabId: annotation.tabId,
      documentId: annotation.documentId,
      url: annotation.url,
      title: annotation.title,
      kind: annotation.kind,
      tag: annotation.tag,
      comment: annotation.comment,
      rect: annotation.rect,
      isCurrentPage: annotation.tabId === tab.state.id && annotation.documentId === tab.state.documentId,
      hasImage: Boolean(annotation.image),
    }))
  const editorMarkerNumber = (tab: Tab) => {
    if (!tab.editor) return undefined
    if (tab.editorOriginal) {
      const index = tab.annotations.findIndex((item) => item.id === tab.editorOriginal?.id)
      return index >= 0 ? index + 1 : tab.annotations.length + 1
    }
    return tab.annotations.length + 1
  }
  const hasUnsavedEditorChanges = (tab: Tab) => {
    if (!tab.editorVisible || !tab.editor) return false
    if (!tab.editorOriginal) return tab.editor.comment.trim().length > 0
    return (
      tab.editor.comment !== tab.editorOriginal.comment ||
      (tab.editorScreenshotInitial !== undefined && tab.screenshot !== tab.editorScreenshotInitial)
    )
  }
  const overlayState = (item: Overlay): BrowserOverlayState => ({
    kind: item.kind,
    tabId: item.tab.state.id,
    owner: item.tab.state.owner,
    annotation: item.tab.editor ? { ...item.tab.editor, image: undefined } : undefined,
    markerNumber: editorMarkerNumber(item.tab),
    items: overlayItems(item.tab),
    mode: item.tab.mode,
    viewMode: item.tab.viewMode,
    screenshot: item.tab.screenshot,
    count: item.tab.annotations.length,
    enabled: item.tab.enabled,
    hidden: item.tab.hidden,
    original: item.tab.original,
    editing: !!item.tab.editorOriginal,
    expanded: item.tab.expanded,
    toolbarOffset: item.tab.toolbarOffset,
    viewportWidth: item.tab.bounds?.width,
    theme: item.tab.theme,
    colors: item.tab.colors,
    error: item.kind === 'editor' ? item.tab.editorError : undefined,
  })
  const positionOverlays = (tab: Tab) => {
    const bounds = tab.bounds
    if (!bounds) return
    for (const item of overlays)
      if (item.tab === tab) {
        if (item.kind === 'toolbar') {
          const maxWidth = Math.max(180, bounds.width - 12)
          const width = Math.min(Math.max(220, tab.toolbarWidth ?? 580), maxWidth)
          const fallbackHeight = tab.toolbarMenuOpen ? 280 : 48
          const height = Math.min(Math.max(44, tab.toolbarHeight ?? fallbackHeight), Math.max(44, bounds.height - 16))
          const originX = Math.round((bounds.width - width) / 2)
          const x = Math.max(6, Math.min(bounds.width - width - 6, originX + tab.toolbarOffset.x))
          const bottomAnchor = bounds.height - 10 + tab.toolbarOffset.y
          const y = Math.max(8, Math.min(bounds.height - height - 8, bottomAnchor - height))
          item.view.setBounds({
            x: bounds.x + Math.round(x),
            y: bounds.y + Math.round(y),
            width: Math.round(width),
            height: Math.round(height),
          })
        } else {
          const sourceBox = tab.editorPosition ?? tab.editor?.rect
          const zoom = tab.view.webContents.getZoomFactor()
          const box = sourceBox
            ? {
                x: sourceBox.x * zoom,
                y: sourceBox.y * zoom,
                width: sourceBox.width * zoom,
                height: sourceBox.height * zoom,
              }
            : undefined
          if (!box) continue
          const width = Math.min(tab.expanded ? 372 : 356, Math.max(240, bounds.width - 16))
          const height = Math.min(Math.max(112, tab.editorHeight ?? 148), Math.max(112, bounds.height - 76))
          const below = box.y + box.height + 10
          const above = box.y - height - 10
          const y =
            below + height <= bounds.height - 64
              ? below
              : above >= 8
                ? above
                : Math.max(8, Math.min(bounds.height - height - 64, below))
          item.view.setBounds({
            x: bounds.x + Math.round(Math.max(8, Math.min(box.x, bounds.width - width - 8))),
            y: bounds.y + Math.round(Math.max(8, Math.min(y, bounds.height - height - 8))),
            width: Math.round(width),
            height: Math.round(height),
          })
        }
        item.view.webContents.send('browser:overlay-update', overlayState(item))
      }
  }
  const showOverlay = async (tab: Tab, kind: Overlay['kind']) => {
    const window = options.getWindow()
    if (
      !window ||
      visible !== tab ||
      !tab.view.getVisible() ||
      !tab.bounds ||
      !tab.enabled ||
      (kind === 'editor' && !tab.editorVisible)
    )
      return
    const found = [...overlays].find((item) => item.kind === kind && item.tab === tab)
    if (found) {
      positionOverlays(tab)
      if (kind === 'editor') found.view.webContents.focus()
      return
    }
    closeOverlays(kind)
    const view = new WebContentsView({
      webPreferences: {
        partition: 'pi-meme-browser-chrome',
        preload: path.join(__dirname, 'browser-overlay.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    view.setBackgroundColor('#00000000')
    view.setVisible(false)
    const item: Overlay = { view, kind, tab }
    overlays.add(item)
    window.contentView.addChildView(view)
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    view.webContents.on('will-navigate', (event) => event.preventDefault())
    view.webContents.on('focus', () => {
      lastFocusedSurface = 'overlay'
    })
    positionOverlays(tab)
    try {
      await view.webContents.loadURL(`${options.origin()}/?browser-overlay=${kind}`)
    } catch (cause) {
      // 加载中的浮层被主动关闭时，Electron 也会以 ERR_FAILED 拒绝 loadURL。
      if (!overlays.has(item)) return
      closeOverlays(kind)
      throw cause
    }
  }
  const capture = async (tab: Tab, mode: Tab['screenshot'], annotation: BrowserAnnotation) => {
    if (mode === 'none') return { ...annotation, image: undefined }
    const web = tab.view.webContents
    const documentId = tab.state.documentId
    picker(tab, { original: true })
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 35))
      const bounds = tab.bounds
      if (!bounds) throw new Error('网页当前不可见，无法截图')
      const zoom = web.getZoomFactor()
      const box =
        mode === 'viewport'
          ? { x: 0, y: 0, width: bounds.width, height: bounds.height }
          : {
              x: annotation.rect.x * zoom,
              y: annotation.rect.y * zoom,
              width: annotation.rect.width * zoom,
              height: annotation.rect.height * zoom,
            }
      const x = Math.max(0, Math.floor(box.x))
      const y = Math.max(0, Math.floor(box.y))
      const width = Math.min(Math.ceil(box.width + Math.min(0, box.x)), bounds.width - x)
      const height = Math.min(Math.ceil(box.height + Math.min(0, box.y)), bounds.height - y)
      if (width < 1 || height < 1) throw new Error('选中区域已移出页面，请重新选择')
      let image = await web.capturePage({ x, y, width, height })
      if (documentId !== tab.state.documentId) throw new Error('网页已跳转，请重新选择元素')
      if (image.getSize().width > 1800) image = image.resize({ width: 1800 })
      const data = image.toPNG().toString('base64')
      if (data.length > 8 * 1024 * 1024) throw new Error('截图过大，请选择更小的区域')
      return { ...annotation, image: { type: 'image' as const, mimeType: 'image/png', data } }
    } finally {
      picker(tab, { original: false })
    }
  }
  const setEnabled = async (tab: Tab, enabled: boolean, region?: boolean) => {
    tab.enabled = enabled
    if (region !== undefined) tab.mode = region ? 'region' : 'element'
    if (!enabled) {
      tab.original = false
      tab.editorVisible = false
      tab.editorError = undefined
      tab.toolbarMenuOpen = false
    }
    picker(tab, {
      enabled,
      region: tab.mode === 'region',
      hidden: tab.hidden,
      original: tab.original,
      editing: enabled && tab.editorVisible,
      nextNumber: tab.annotations.length + 1,
      annotations: visibleMarkers(tab),
      colors: tab.colors,
      reset: !enabled,
    })
    emit({ type: 'annotation-mode', tabId: tab.state.id, enabled, mode: tab.mode })
    if (enabled) {
      await showOverlay(tab, 'toolbar')
      if (tab.editor && tab.editorVisible) await showOverlay(tab, 'editor')
      positionOverlays(tab)
    } else closeOverlays()
  }
  const command = async (tab: Tab, value: BrowserCommand) => {
    const web = tab.view.webContents
    switch (value.type) {
      case 'navigate': {
        tab.state.error = undefined
        const trimmed = value.url.trim()
        if (trimmed && !isLikelyUrlInput(trimmed)) {
          void options
            .rpc('browser:search-query', [trimmed])
            .then(changed)
            .catch(() => {})
        }
        await web.loadURL(browserUrl(value.url, (snapshot ?? (await refresh())).settings.search)).catch(() => {})
        break
      }
      case 'go-to-index': {
        if (!Number.isInteger(value.index)) throw new Error('历史索引无效')
        const entries = web.navigationHistory.getAllEntries()
        if (value.index >= 0 && value.index < entries.length) web.navigationHistory.goToIndex(value.index)
        break
      }
      case 'back':
        if (web.navigationHistory.canGoBack()) web.navigationHistory.goBack()
        break
      case 'forward':
        if (web.navigationHistory.canGoForward()) web.navigationHistory.goForward()
        break
      case 'reload':
        tab.state.error = undefined
        publish(tab)
        web.reload()
        break
      case 'keep-alive': {
        tab.state.keepAlive = Boolean(value.enabled)
        syncTabHosting(tab)
        publish(tab)
        const workspace = await options
          .rpc<BrowserWorkspace>('browser:workspace', [tab.state.owner])
          .catch(() => undefined)
        if (workspace) {
          const nextTabs = workspace.tabs.some((item) => item.id === tab.state.id)
            ? workspace.tabs.map((item) =>
                item.id === tab.state.id ? { ...item, keepAlive: tab.state.keepAlive } : item,
              )
            : [...workspace.tabs, { ...tab.state }]
          await options
            .rpc('browser:save-workspace', [tab.state.owner, { ...workspace, tabs: nextTabs }])
            .catch(() => {})
        }
        break
      }
      case 'stop':
        web.stop()
        break
      case 'focus':
        if (visible === tab && tab.view.getVisible()) web.focus()
        break
      case 'external':
        if (/^https?:/.test(tab.state.url)) await shell.openExternal(tab.state.url)
        break
      case 'zoom':
        if (!Number.isFinite(value.value) || value.value < 0.25 || value.value > 3)
          throw new Error('缩放范围为 25% 至 300%')
        web.setZoomFactor(value.value)
        tab.state.zoom = value.value
        publish(tab)
        break
      case 'find':
        if (typeof value.text !== 'string' || value.text.length > 1000) throw new Error('查找文字无效')
        if (value.text) {
          const next = value.next === true && tab.find?.text === value.text
          if (!next) web.stopFindInPage('clearSelection')
          tab.find = {
            // Electron 的 findNext 对应 Chromium 的 new_session；新查找传 true，继续查找传 false。
            requestId: web.findInPage(value.text, { forward: value.forward !== false, findNext: !next }),
            text: value.text,
          }
        } else {
          tab.find = undefined
          web.stopFindInPage('clearSelection')
        }
        break
      case 'annotate':
        await setEnabled(tab, value.enabled, value.region)
        break
      case 'view-mode':
        if (tab.viewMode !== value.mode) {
          tab.viewMode = value.mode
          positionOverlays(tab)
        }
        break
      case 'markers':
        if (!Array.isArray(value.annotations)) throw new Error('批注标记无效')
        tab.annotations = value.annotations.filter(validAnnotation)
        picker(tab, { annotations: visibleMarkers(tab), nextNumber: tab.annotations.length + 1 })
        positionOverlays(tab)
        break
      case 'annotation-state':
        emit({ type: 'annotation-mode', tabId: tab.state.id, enabled: tab.enabled, mode: tab.mode })
        break
      case 'restore-editor':
        if (!validAnnotation(value.annotation) || value.annotation.tabId !== tab.state.id)
          throw new Error('待恢复批注无效')
        tab.editor = value.annotation
        tab.editorPosition = value.annotation.rect
        tab.editorOriginal = tab.annotations.find((item) => item.id === value.annotation.id)
        tab.editorScreenshotInitial = tab.screenshot
        tab.editorError = undefined
        tab.editorHeight = undefined
        tab.editorVisible = true
        picker(tab, { highlightId: tab.editorOriginal?.id ?? null, editing: true })
        await setEnabled(tab, true)
        await showOverlay(tab, 'editor')
        break
      case 'screenshot': {
        if (!tab.bounds) throw new Error('网页当前不可见')
        const annotation: BrowserAnnotation = {
          id: randomUUID(),
          tabId: tab.state.id,
          documentId: tab.state.documentId,
          url: tab.state.url,
          title: tab.state.title,
          capturedAt: new Date().toISOString(),
          kind: 'region',
          text: '',
          comment: '当前页面截图',
          rect: { x: 0, y: 0, width: tab.bounds.width, height: tab.bounds.height },
          viewport: {
            width: tab.bounds.width,
            height: tab.bounds.height,
            scale: web.getZoomFactor(),
            scrollX: 0,
            scrollY: 0,
          },
        }
        const captured = await capture(tab, 'viewport', annotation)
        const workspace = await options.rpc<BrowserWorkspace>('browser:workspace', [tab.state.owner])
        const annotations = [...workspace.annotations, captured]
        await options.rpc('browser:save-workspace', [tab.state.owner, { ...workspace, annotations }])
        tab.annotations = annotations
        picker(tab, { annotations: visibleMarkers(tab), nextNumber: tab.annotations.length + 1 })
        emit({ type: 'annotation', owner: tab.state.owner, annotation: captured })
        positionOverlays(tab)
        break
      }
    }
  }
  const makeTab = async (owner: string, id: string, url = 'about:blank'): Promise<BrowserTab> => {
    if (!owner || owner.length > 2048 || !/^[a-zA-Z0-9-]{1,128}$/.test(id)) throw new Error('网页标签参数无效')
    const existing = tabs.get(id)
    if (existing) {
      if (existing.state.owner !== owner) throw new Error('网页标签不属于当前聊天')
      return { ...existing.state }
    }
    const window = options.getWindow()
    if (!window) throw new Error('桌面窗口已关闭')
    if (attachedWindow !== window) {
      attachedWindow = window
      const windowWeb = window.webContents
      const onWindowFocus = () => {
        lastFocusedSurface = 'window'
      }
      windowWeb.on('focus', onWindowFocus)
      window.once('closed', () => {
        attachedWindow = undefined
        if (!windowWeb.isDestroyed()) windowWeb.removeListener('focus', onWindowFocus)
        closeOverlays()
        for (const tab of tabs.values()) {
          tab.agentAbort?.abort()
          clearAgentKeepAlive(tab)
          tab.cdp.dispose()
          for (const dir of tab.uploadTempDirs) void rm(dir, { recursive: true, force: true }).catch(() => {})
          liveWeb(tab.view)?.close()
        }
        tabs.clear()
        visible = undefined
        lastFocusedSurface = 'window'
      })
    }
    const view = new WebContentsView({
      webPreferences: {
        partition: 'persist:pi-meme-browser-v1',
        preload: path.join(__dirname, 'browser-guest.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    })
    view.setBackgroundColor('#ffffff')
    view.setBounds({ x: 0, y: 0, width: 1024, height: 768 })
    const config = snapshot ?? (await refresh())
    const tab: Tab = {
      view,
      state: {
        id,
        owner,
        url: browserUrl(url, config.settings.search),
        title: '新网页',
        documentId: Date.now(),
        loading: false,
        canGoBack: false,
        canGoForward: false,
      },
      enabled: false,
      mode: 'element',
      viewMode: 'split',
      original: false,
      theme: 'dark',
      annotations: [],
      editorVisible: false,
      expanded: false,
      hidden: false,
      toolbarOffset: { x: 0, y: 0 },
      toolbarMenuOpen: false,
      screenshot: config.settings.screenshots,
      cdp: new BrowserCdpController(view),
      domReady: false,
      lastViewport: { width: 1024, height: 768 },
      agentKeepAliveUntil: 0,
      uploadTempDirs: [],
    }
    tabs.set(id, tab)
    view.setVisible(false)
    const web = view.webContents
    web.on('focus', () => {
      if (visible === tab) {
        lastFocusedSurface = tab.state.id
        return
      }
      if (!attachedWindow || attachedWindow.isDestroyed() || !attachedWindow.isFocused()) return
      if (lastFocusedSurface === 'overlay') {
        const editorOverlay = [...overlays].find((item) => item.kind === 'editor')
        const editorWeb = editorOverlay ? liveWeb(editorOverlay.view) : undefined
        if (editorWeb) {
          editorWeb.focus()
          return
        }
      }
      if (lastFocusedSurface === visible?.state.id && visible) {
        const visibleWeb = liveWeb(visible.view)
        if (visibleWeb) {
          visibleWeb.focus()
          return
        }
      }
      attachedWindow.webContents.focus()
    })
    web.on('found-in-page', (_event, result) => {
      if (!tab.find || result.requestId !== tab.find.requestId || !result.finalUpdate) return
      emit({
        type: 'find-result',
        tabId: id,
        text: tab.find.text,
        active: result.activeMatchOrdinal,
        matches: result.matches,
      })
    })
    web.on('before-input-event', (event, input) => {
      if (visible !== tab || input.type !== 'keyDown' || input.isComposing || input.alt) return
      const key = input.key.toLowerCase()
      const modifier = process.platform === 'darwin' ? input.meta : input.control
      const action =
        modifier && !input.shift && key === 'f'
          ? 'find'
          : modifier && !input.shift && key === 'l'
            ? 'address'
            : key === 'escape' && tab.find
              ? 'close-find'
              : undefined
      if (!action) return
      event.preventDefault()
      window.webContents.focus()
      emit({ type: 'browser-shortcut', tabId: id, action })
    })
    const sync = () => {
      if (web.isDestroyed()) return
      tab.state = {
        ...tab.state,
        url: web.getURL() || tab.state.url,
        title: web.getURL() === 'about:blank' ? '新网页' : web.getTitle() || '新网页',
        zoom: web.getZoomFactor(),
        loading: web.isLoading(),
        canGoBack: web.navigationHistory.canGoBack(),
        canGoForward: web.navigationHistory.canGoForward(),
      }
      publish(tab)
    }
    let lastHistoryVisit: { url: string; visitedAt: string; hasFavicon: boolean } | undefined
    const recordHistory = (updateFaviconOnly = false) => {
      if (!/^https?:/.test(tab.state.url)) return
      if (updateFaviconOnly) {
        if (
          !tab.state.favicon ||
          !lastHistoryVisit ||
          lastHistoryVisit.url !== tab.state.url ||
          lastHistoryVisit.hasFavicon
        )
          return
        lastHistoryVisit.hasFavicon = true
        void options
          .rpc('browser:history', [
            {
              id: randomUUID(),
              url: tab.state.url,
              title: tab.state.title,
              visitedAt: lastHistoryVisit.visitedAt,
              favicon: tab.state.favicon,
            },
          ])
          .then(changed)
          .catch(console.error)
        return
      }
      const visitedAt = new Date().toISOString()
      lastHistoryVisit = { url: tab.state.url, visitedAt, hasFavicon: Boolean(tab.state.favicon) }
      void options
        .rpc('browser:history', [
          {
            id: randomUUID(),
            url: tab.state.url,
            title: tab.state.title,
            visitedAt,
            favicon: tab.state.favicon,
          },
        ])
        .then(changed)
        .catch(console.error)
    }
    web.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => {
      if (isMainFrame && !inPlace) {
        tab.find = undefined
        tab.domReady = false
        tab.cdp.resetNavigationState()
        tab.state.documentId++
        tab.state.error = undefined
        tab.state.favicon = undefined
        lastHistoryVisit = undefined
        tab.editorVisible = false
        if (visible === tab) closeOverlays('editor')
      }
    })
    web.on('did-start-loading', sync)
    web.on('did-stop-loading', sync)
    web.on('page-title-updated', sync)
    web.on('update-target-url', (_event, url) => emit({ type: 'target-url', tabId: tab.state.id, url }))
    web.on('page-favicon-updated', (_event, favicons) => {
      const candidate = favicons.find((value) => /^https?:|^data:image\//.test(value))
      const documentId = tab.state.documentId
      if (!candidate) return
      if (candidate.startsWith('data:image/')) {
        if (candidate.length <= 700_000) {
          tab.state.favicon = candidate
          publish(tab)
          if (!web.isLoading()) recordHistory(true)
        }
        return
      }
      void guestSession
        .fetch(candidate)
        .then(async (response) => {
          const mimeType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
          if (!response.ok || !mimeType?.startsWith('image/')) return
          const bytes = Buffer.from(await response.arrayBuffer())
          if (bytes.length > 512 * 1024 || tab.state.documentId !== documentId || web.isDestroyed()) return
          tab.state.favicon = `data:${mimeType};base64,${bytes.toString('base64')}`
          publish(tab)
          if (!web.isLoading()) recordHistory(true)
        })
        .catch(() => {})
    })
    web.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
      if (!isMainFrame) return
      tab.state.documentId++
      tab.editorVisible = false
      tab.state.favicon = undefined
      lastHistoryVisit = undefined
      if (visible === tab) closeOverlays('editor')
      sync()
      picker(tab, { enabled: tab.enabled, documentId: tab.state.documentId, annotations: [], reset: true })
    })
    web.on('dom-ready', () => {
      tab.domReady = true
      picker(tab, {
        enabled: tab.enabled,
        region: tab.mode === 'region',
        hidden: tab.hidden,
        original: tab.original,
        documentId: tab.state.documentId,
        annotations: visibleMarkers(tab),
        nextNumber: tab.annotations.length + 1,
        colors: tab.colors,
      })
      if (tab.enabled && visible === tab) void showOverlay(tab, 'toolbar').catch(console.error)
    })
    web.on('did-finish-load', () => {
      sync()
      recordHistory(false)
      if (visible !== tab) syncTabHosting(tab)
    })
    web.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) {
        clearAgentKeepAlive(tab)
        web.setBackgroundThrottling(true)
        tab.state.error = `网页加载失败：${description}（${code}）`
        sync()
        detachTabView(tab)
        if (visible === tab) closeOverlays()
      }
    })
    web.on('render-process-gone', (_event, details) => {
      clearAgentKeepAlive(tab)
      web.setBackgroundThrottling(true)
      tab.state.documentId++
      tab.state.error = `网页进程已退出：${details.reason}`
      tab.state.loading = false
      detachTabView(tab)
      if (visible === tab) closeOverlays()
      publish(tab)
    })
    web.on('will-navigate', (event, target) => {
      try {
        browserUrl(target)
      } catch {
        event.preventDefault()
      }
    })
    web.setWindowOpenHandler((details) => {
      try {
        browserUrl(details.url)
      } catch {
        return { action: 'deny' }
      }
      if ((details.features || details.postBody) && !tab.popupCollector)
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            parent: window,
            width: 600,
            height: 720,
            webPreferences: {
              partition: 'persist:pi-meme-browser-v1',
              sandbox: true,
              contextIsolation: true,
              nodeIntegration: false,
              preload: undefined,
            },
          },
        }
      const newId = randomUUID()
      const fromAgent = Boolean(tab.popupCollector)
      if (tab.popupCollector) {
        tab.popupCollector.push({ tabId: newId, url: systemMetadataUrl(details.url) })
      }
      void makeTab(tab.state.owner, newId, details.url)
        .then((value) => {
          emit({ type: fromAgent ? 'tab' : 'open', tab: value })
        })
        .catch(console.error)
      return { action: 'deny' }
    })
    web.on('did-create-window', (popup) => {
      popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      popup.webContents.on('will-navigate', (event, target) => {
        try {
          browserUrl(target)
        } catch {
          event.preventDefault()
        }
      })
    })
    void web.loadURL(tab.state.url).catch(() => {})
    return { ...tab.state }
  }
  const guestHandler = (event: Electron.IpcMainEvent) => {
    const tab = tabFor(event.sender)
    return tab && event.senderFrame === event.sender.mainFrame && event.senderFrame.url === tab.state.url
      ? tab
      : undefined
  }
  const clearEditorState = (tab: Tab) => {
    tab.editor = undefined
    tab.editorPosition = undefined
    tab.editorOriginal = undefined
    tab.editorScreenshotInitial = undefined
    tab.editorError = undefined
    tab.editorHeight = undefined
    tab.editorVisible = false
    tab.expanded = false
  }
  const saveEditor = async (tab: Tab, options_?: { keepOverlayOpen?: boolean }) => {
    if (overlayBusy || !tab.editor) throw new Error('正在处理批注，请稍后重试')
    overlayBusy = true
    const selected = structuredClone(tab.editor)
    try {
      const annotation =
        selected.documentId === tab.state.documentId
          ? {
              ...(await capture(
                tab,
                tab.screenshot,
                tab.editorPosition ? { ...selected, rect: tab.editorPosition } : selected,
              )),
              rect: selected.rect,
            }
          : tab.screenshot === 'none'
            ? { ...selected, image: undefined }
            : selected.image
              ? selected
              : undefined
      if (!annotation) throw new Error('旧页面没有保存截图，请关闭截图后加入，或重新选择元素')
      if (visible !== tab || tab.editor?.id !== selected.id) throw new Error('批注目标已切换')
      const workspace = await options.rpc<BrowserWorkspace>('browser:workspace', [tab.state.owner])
      const previous = workspace.annotations.findIndex((value) => value.id === annotation.id)
      const annotations = [...workspace.annotations]
      if (previous < 0) annotations.push(annotation)
      else annotations[previous] = annotation
      await options.rpc('browser:save-workspace', [tab.state.owner, { ...workspace, annotations, editor: undefined }])
      tab.annotations = annotations
      clearEditorState(tab)
      picker(tab, { annotations: visibleMarkers(tab), nextNumber: tab.annotations.length + 1, reset: true })
      emit({ type: 'annotation', owner: tab.state.owner, annotation })
      emit({ type: 'editor', owner: tab.state.owner })
      if (!options_?.keepOverlayOpen) closeOverlays('editor')
      positionOverlays(tab)
    } finally {
      overlayBusy = false
    }
  }
  const openMarkerEditor = async (tab: Tab, id: string, scroll = false) => {
    const annotation = tab.annotations.find(
      (item) => item.id === id && item.tabId === tab.state.id && item.documentId === tab.state.documentId,
    )
    if (!annotation) return
    if (tab.editorVisible && tab.editor?.id === id) {
      if (scroll) picker(tab, { highlightId: id, editing: true, scrollToId: id })
      return
    }
    if (hasUnsavedEditorChanges(tab)) {
      try {
        await saveEditor(tab, { keepOverlayOpen: true })
      } catch (cause) {
        tab.editorError = String(cause)
        positionOverlays(tab)
        return
      }
    }
    tab.editorOriginal = annotation
    tab.editorScreenshotInitial = tab.screenshot
    tab.editorError = undefined
    tab.editorHeight = undefined
    tab.editor = structuredClone(annotation)
    tab.editorPosition = annotation.rect
    tab.editorVisible = true
    tab.expanded = false
    picker(tab, { highlightId: id, editing: true, ...(scroll ? { scrollToId: id } : {}) })
    emit({ type: 'editor', owner: tab.state.owner, annotation: tab.editor })
    await showOverlay(tab, 'editor')
    positionOverlays(tab)
  }
  ipcMain.on('browser:selected', (event, value: unknown) => {
    const tab = guestHandler(event)
    if (
      !tab ||
      !tab.enabled ||
      tab !== visible ||
      !value ||
      typeof value !== 'object' ||
      (value as BrowserAnnotation).documentId !== tab.state.documentId
    )
      return
    const annotation = {
      ...(value as BrowserAnnotation),
      id: randomUUID(),
      tabId: tab.state.id,
      documentId: tab.state.documentId,
      url: tab.state.url,
      title: tab.state.title,
      capturedAt: new Date().toISOString(),
      comment: '',
    }
    delete annotation.image
    if (!validAnnotation(annotation)) return
    void (async () => {
      if (hasUnsavedEditorChanges(tab)) {
        try {
          await saveEditor(tab, { keepOverlayOpen: true })
        } catch (cause) {
          tab.editorError = String(cause)
          picker(tab, {
            highlightId: tab.editorOriginal?.id ?? null,
            editing: true,
            annotations: visibleMarkers(tab),
            nextNumber: tab.annotations.length + 1,
          })
          positionOverlays(tab)
          return
        }
      }
      if (!tab.enabled || tab !== visible || tab.state.documentId !== annotation.documentId) return
      tab.editor = annotation
      tab.editorPosition = annotation.rect
      tab.editorOriginal = undefined
      tab.editorScreenshotInitial = tab.screenshot
      tab.editorError = undefined
      tab.editorHeight = undefined
      tab.expanded = false
      picker(tab, { highlightId: null, editing: true, nextNumber: tab.annotations.length + 1 })
      tab.editorVisible = true
      try {
        const saved = await capture(tab, tab.screenshot, annotation)
        if (tab.editor?.id !== annotation.id || tab.state.documentId !== annotation.documentId) return
        tab.editor = saved
        emit({ type: 'editor', owner: tab.state.owner, annotation: saved })
        await showOverlay(tab, 'editor')
        positionOverlays(tab)
      } catch (cause) {
        if (tab.editor?.id !== annotation.id || tab.state.documentId !== annotation.documentId) return
        tab.editor = annotation
        emit({ type: 'editor', owner: tab.state.owner, annotation })
        await showOverlay(tab, 'editor').catch(console.error)
        positionOverlays(tab)
        console.error(String(cause))
      }
    })()
  })
  ipcMain.on('browser:selection-position', (event, box: BrowserRect) => {
    const tab = guestHandler(event)
    if (tab?.editor && tab.editorVisible && box && [box.x, box.y, box.width, box.height].every(Number.isFinite)) {
      tab.editorPosition = box
      positionOverlays(tab)
    }
  })
  ipcMain.on('browser:selection-dismiss', (event) => {
    const tab = guestHandler(event)
    if (!tab || tab !== visible || !tab.enabled || !tab.editorVisible) return
    void (async () => {
      if (hasUnsavedEditorChanges(tab)) {
        try {
          await saveEditor(tab)
          return
        } catch (cause) {
          tab.editorError = String(cause)
          positionOverlays(tab)
          return
        }
      }
      clearEditorState(tab)
      picker(tab, { reset: true, nextNumber: tab.annotations.length + 1 })
      emit({ type: 'editor', owner: tab.state.owner })
      closeOverlays('editor')
      positionOverlays(tab)
    })()
  })
  ipcMain.on('browser:selection-cancel', (event) => {
    const tab = guestHandler(event)
    if (!tab || tab !== visible || !tab.enabled || !tab.editorVisible) return
    clearEditorState(tab)
    picker(tab, { reset: true, nextNumber: tab.annotations.length + 1 })
    emit({ type: 'editor', owner: tab.state.owner })
    closeOverlays('editor')
    positionOverlays(tab)
  })
  ipcMain.on('browser:marker-click', (event, id: unknown) => {
    const tab = guestHandler(event)
    if (!tab || !tab.enabled || typeof id !== 'string') return
    void openMarkerEditor(tab, id).catch(console.error)
  })
  ipcMain.on('browser:original-toggle', (event, pressed: unknown) => {
    const tab = guestHandler(event)
    if (!tab || !tab.enabled || typeof pressed !== 'boolean') return
    tab.original = pressed
    picker(tab, { original: pressed })
    positionOverlays(tab)
  })
  ipcMain.on('browser:picker-exit', (event) => {
    const tab = guestHandler(event)
    if (tab) void setEnabled(tab, false)
  })
  const trusted = (event: IpcMainInvokeEvent) => {
    const window = options.getWindow()
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== event.sender.mainFrame ||
      new URL(event.senderFrame.url).origin !== options.origin()
    )
      throw new Error('不允许此页面调用浏览器接口')
  }
  ipcMain.handle('browser:overlay-state', (event) => {
    const item = overlayFor(event.sender)
    if (!item || event.senderFrame !== event.sender.mainFrame) throw new Error('批注浮层已失效')
    return overlayState(item)
  })
  ipcMain.handle('browser:overlay-action', async (event, action: BrowserOverlayAction) => {
    const item = overlayFor(event.sender)
    if (!item || event.senderFrame !== event.sender.mainFrame || visible !== item.tab) throw new Error('批注目标已切换')
    const tab = item.tab
    if (!action || typeof action.type !== 'string') throw new Error('批注操作无效')
    if (action.type === 'ready') {
      if (item.kind === 'toolbar' ? !tab.enabled : !tab.editorVisible) return
      positionOverlays(tab)
      item.view.setVisible(true)
      if (item.kind === 'editor') item.view.webContents.focus()
      return
    }
    if (action.type === 'mode') {
      if (!['element', 'region'].includes(action.mode)) throw new Error('批注模式无效')
      tab.mode = action.mode
      picker(tab, { region: tab.mode === 'region' })
      emit({ type: 'annotation-mode', tabId: tab.state.id, enabled: tab.enabled, mode: tab.mode })
      positionOverlays(tab)
      return
    }
    if (action.type === 'comment') {
      if (item.kind !== 'editor' || !tab.editor || typeof action.text !== 'string' || action.text.length > 16000)
        throw new Error('批注评论无效')
      tab.editor.comment = action.text
      tab.editorError = undefined
      emit({ type: 'editor', owner: tab.state.owner, annotation: tab.editor })
      return
    }
    if (action.type === 'include') {
      if (!['element', 'viewport', 'none'].includes(action.screenshot)) throw new Error('截图方式无效')
      tab.screenshot = action.screenshot
      tab.editorError = undefined
      positionOverlays(tab)
      return
    }
    if (action.type === 'hide') {
      tab.hidden = action.hidden
      picker(tab, { hidden: action.hidden })
      positionOverlays(tab)
      return
    }
    if (action.type === 'expand') {
      if (item.kind !== 'editor') throw new Error('批注浮层已失效')
      tab.expanded = action.expanded
      positionOverlays(tab)
      return
    }
    if (action.type === 'resize-editor') {
      if (item.kind !== 'editor' || !Number.isFinite(action.height) || action.height < 64 || action.height > 4096)
        throw new Error('批注输入高度无效')
      const height = Math.round(action.height)
      if (tab.editorHeight !== height) {
        tab.editorHeight = height
        positionOverlays(tab)
      }
      return
    }
    if (action.type === 'resize-toolbar') {
      if (
        item.kind !== 'toolbar' ||
        !Number.isFinite(action.width) ||
        !Number.isFinite(action.height) ||
        action.width < 120 ||
        action.width > 1600 ||
        action.height < 40 ||
        action.height > 900
      )
        throw new Error('工具条尺寸无效')
      const width = Math.round(action.width)
      const height = Math.round(action.height)
      if (tab.toolbarWidth !== width || tab.toolbarHeight !== height) {
        tab.toolbarWidth = width
        tab.toolbarHeight = height
        positionOverlays(tab)
      }
      return
    }
    if (action.type === 'move-toolbar') {
      if (item.kind !== 'toolbar' || !tab.bounds || !Number.isFinite(action.x) || !Number.isFinite(action.y))
        throw new Error('工具条位置无效')
      const width = Math.min(Math.max(220, tab.toolbarWidth ?? 580), Math.max(180, tab.bounds.width - 12))
      const originX = Math.round((tab.bounds.width - width) / 2)
      tab.toolbarOffset = {
        x: Math.max(-originX + 6, Math.min(tab.bounds.width - width - originX - 6, action.x)),
        y: Math.max(-(tab.bounds.height - 64), Math.min(4, action.y)),
      }
      positionOverlays(tab)
      return
    }
    if (action.type === 'toolbar-menu') {
      if (item.kind !== 'toolbar') throw new Error('批注工具条已失效')
      tab.toolbarMenuOpen = action.open
      positionOverlays(tab)
      return
    }
    if (action.type === 'original') {
      tab.original = action.pressed
      picker(tab, { original: action.pressed })
      positionOverlays(tab)
      return
    }
    if (action.type === 'focus-marker') {
      if (typeof action.id !== 'string') throw new Error('批注标识无效')
      tab.toolbarMenuOpen = false
      await openMarkerEditor(tab, action.id, true)
      return
    }
    if (action.type === 'open-chat') {
      emit({ type: 'focus-chat', owner: tab.state.owner })
      return
    }
    if (action.type === 'cancel') {
      clearEditorState(tab)
      picker(tab, { reset: true, nextNumber: tab.annotations.length + 1 })
      emit({ type: 'editor', owner: tab.state.owner })
      closeOverlays('editor')
      positionOverlays(tab)
      return
    }
    if (action.type === 'remove') {
      const id = action.id ?? tab.editorOriginal?.id
      if (!id) throw new Error('批注目标无效')
      const workspace = await options.rpc<BrowserWorkspace>('browser:workspace', [tab.state.owner])
      const annotations = workspace.annotations.filter((value) => value.id !== id)
      await options.rpc('browser:save-workspace', [tab.state.owner, { ...workspace, annotations, editor: undefined }])
      tab.annotations = annotations
      if (tab.editorOriginal?.id === id || tab.editor?.id === id) {
        clearEditorState(tab)
        closeOverlays('editor')
      }
      picker(tab, {
        annotations: visibleMarkers(tab),
        nextNumber: tab.annotations.length + 1,
        reset: !tab.editorVisible,
      })
      emit({ type: 'annotation-remove', owner: tab.state.owner, id })
      if (!tab.editorVisible) emit({ type: 'editor', owner: tab.state.owner })
      positionOverlays(tab)
      return
    }
    if (action.type === 'exit') {
      await setEnabled(tab, false)
      return
    }
    if (action.type === 'discard') {
      const workspace = await options.rpc<BrowserWorkspace>('browser:workspace', [tab.state.owner])
      await options.rpc('browser:save-workspace', [
        tab.state.owner,
        { ...workspace, annotations: [], editor: undefined },
      ])
      tab.annotations = []
      clearEditorState(tab)
      picker(tab, { annotations: [], nextNumber: 1, reset: true })
      emit({ type: 'editor', owner: tab.state.owner })
      emit({ type: 'discard', owner: tab.state.owner })
      closeOverlays('editor')
      positionOverlays(tab)
      return
    }
    if (action.type === 'submit') {
      if (submitBusy) return
      submitBusy = true
      try {
        if (tab.editorVisible && tab.editor) await saveEditor(tab)
        await setEnabled(tab, false)
        if (visible === tab) emit({ type: 'submit', owner: tab.state.owner })
      } finally {
        submitBusy = false
      }
      return
    }
    if (action.type === 'screenshot') {
      await command(tab, { type: 'screenshot' })
      return
    }
    if (action.type === 'add') {
      await saveEditor(tab)
    }
  })
  guestSession.setPermissionCheckHandler((web, permission, origin) => {
    if (!web || (!tabFor(web) && !BrowserWindow.fromWebContents(web)?.getParentWindow())) return false
    return (
      snapshot?.permissions.find((item) => item.origin === origin && item.permission === permission)?.value === 'allow'
    )
  })
  guestSession.setPermissionRequestHandler((web, permission, callback, details) => {
    void (async () => {
      const config = snapshot ?? (await refresh())
      let origin: string
      try {
        origin = new URL(details.requestingUrl || web.getURL()).origin
      } catch {
        callback(false)
        return
      }
      const value =
        config.permissions.find((item) => item.origin === origin && item.permission === permission)?.value ?? 'ask'
      if (value === 'deny') {
        callback(false)
        return
      }
      const allowed = ['media', 'geolocation', 'clipboard-read', 'notifications', 'fullscreen']
      if (!allowed.includes(permission) || permissionPending) {
        callback(false)
        return
      }
      let grant = value === 'allow'
      if (!grant) {
        const window = options.getWindow()
        if (!window) {
          callback(false)
          return
        }
        permissionPending = true
        try {
          const result = await dialog.showMessageBox(window, {
            type: 'question',
            title: '网站权限',
            message: `${origin} 请求${({ media: '使用摄像头或麦克风', geolocation: '获取位置', 'clipboard-read': '读取剪贴板', notifications: '发送通知', fullscreen: '进入全屏' } as Record<string, string>)[permission]}`,
            buttons: ['拒绝', '仅本次允许', '始终允许', '始终拒绝'],
            defaultId: 0,
            cancelId: 0,
          })
          grant = result.response === 1 || result.response === 2
          if (result.response >= 2)
            snapshot = await options.rpc('browser:permission', [
              { origin, permission, value: result.response === 2 ? 'allow' : 'deny' } satisfies BrowserPermission,
            ])
          changed()
        } finally {
          permissionPending = false
        }
      }
      if (grant && permission === 'media' && process.platform === 'darwin') {
        const types = (details as { mediaTypes?: string[] }).mediaTypes ?? []
        for (const type of types)
          if (type === 'audio' || type === 'video')
            grant = (await systemPreferences.askForMediaAccess(type === 'audio' ? 'microphone' : 'camera')) && grant
      }
      callback(grant)
    })().catch(() => callback(false))
  })
  guestSession.on('will-download', (_event, item, web) => {
    const tab = tabFor(web)
    if (!tab) {
      item.cancel()
      return
    }
    const id = randomUUID()
    activeDownloads.set(id, item)
    const record: BrowserDownload = {
      id,
      url: item.getURL(),
      name: item.getFilename(),
      path: '',
      received: 0,
      total: item.getTotalBytes(),
      state: 'progressing',
      createdAt: new Date().toISOString(),
    }
    let lastWrite = 0
    const save = () =>
      options
        .rpc('browser:download', [{ ...record }])
        .then(changed)
        .catch(console.error)
    item.on('updated', (_event, state) => {
      record.received = item.getReceivedBytes()
      record.total = item.getTotalBytes()
      record.path = item.getSavePath()
      if (state === 'interrupted') record.state = 'interrupted'
      if (Date.now() - lastWrite > 700) {
        lastWrite = Date.now()
        void save()
      }
    })
    item.once('done', (_event, state) => {
      activeDownloads.delete(id)
      record.state = state
      record.path = item.getSavePath()
      record.received = item.getReceivedBytes()
      void save()
    })
    const config = snapshot?.settings
    if (config?.askDownload)
      item.setSaveDialogOptions({
        defaultPath: path.join(config.downloadDirectory || app.getPath('downloads'), path.basename(item.getFilename())),
      })
    else {
      const directory = config?.downloadDirectory || app.getPath('downloads')
      const name = path.basename(item.getFilename())
      const extension = path.extname(name)
      const stem = name.slice(0, name.length - extension.length)
      let destination = path.join(directory, name)
      for (let index = 1; existsSync(destination); index++)
        destination = path.join(directory, `${stem} (${index})${extension}`)
      item.setSavePath(destination)
    }
    void save()
  })
  const cleanupTab = (tab: Tab) => {
    tab.agentAbort?.abort()
    clearAgentKeepAlive(tab)
    tab.cdp.dispose()
    for (const dir of tab.uploadTempDirs) void rm(dir, { recursive: true, force: true }).catch(() => {})
    tab.uploadTempDirs = []
  }

  const isPointTarget = (value: unknown): value is { x: number; y: number } =>
    Boolean(value && typeof value === 'object' && !Array.isArray(value) && 'x' in value && 'y' in value)

  const getCrossOriginId = (target: unknown): string | undefined => {
    if (typeof target === 'string' && target.startsWith('ax:')) return target
    if (
      target &&
      typeof target === 'object' &&
      'elementId' in target &&
      typeof (target as { elementId?: unknown }).elementId === 'string' &&
      (target as { elementId: string }).elementId.startsWith('ax:')
    )
      return (target as { elementId: string }).elementId
    return undefined
  }

  const operationLabel = (operation: string) =>
    (
      ({
        back: '正在后退网页',
        forward: '正在前进网页',
        reload: '正在刷新网页',
        activate: '正在切换网页标签',
        keepAlive: '正在更新后台常驻状态',
        click: '正在点击网页元素',
        dblclick: '正在双击网页元素',
        hover: '正在悬停网页元素',
        drag: '正在拖拽网页元素',
        input: '正在输入网页内容',
        paste: '正在粘贴网页内容',
        press: '正在发送网页按键',
        select: '正在选择下拉选项',
        scroll: '正在滚动网页',
        dialog: '正在处理网页弹窗',
        upload: '正在上传工作区文件',
        batch: '正在批量执行网页操作',
        evaluate: '正在执行页面脚本',
        fetch: '正在发起页内请求',
        handOff: '等待人工接管网页',
      }) as Record<string, string>
    )[operation] ?? `正在执行 ${operation}`

  const executeTabOperation = async (
    tab: Tab,
    owner: string,
    operation: string,
    input: unknown[],
    deadline: number,
    signal: AbortSignal,
  ): Promise<unknown> => {
    const web = tab.view.webContents
    const assertSignal = () => {
      if (signal.aborted) throw new SystemReadError('cancelled', '用户已接管当前网页操作')
    }
    assertSignal()
    const { id: tabId, documentId } = tab.state
    const url = web.getURL() || tab.state.url
    const sameDocument = () =>
      !web.isDestroyed() &&
      tab.state.owner === owner &&
      tab.state.documentId === documentId &&
      (web.getURL() || tab.state.url) === url
    const assertDocument = (expected: unknown) => {
      if (web.isDestroyed()) throw new SystemReadError('not-found', '网页已关闭')
      if (expected !== documentId || !sameDocument())
        throw new SystemReadError('stale-cursor', '网页文档已变化，请重新调用 browser.read', {
          reason: 'stale-document',
        })
    }

    if (operation === 'back' || operation === 'forward' || operation === 'reload') {
      await command(tab, { type: operation })
      return agentTabMetadata(tab.state)
    }
    if (operation === 'activate') {
      emit({ type: 'open', tab: { ...tab.state } })
      return { activated: true, tabId }
    }
    if (operation === 'keepAlive') {
      await command(tab, { type: 'keep-alive', enabled: Boolean(input[1]) })
      return { tabId, keepAlive: Boolean(tab.state.keepAlive) }
    }
    if (operation === 'handOff') {
      const payload = input[1] as { reason: string; actionHint?: string }
      tab.agentHandoff = payload
      emit({ type: 'open', tab: { ...tab.state } })
      emit({ type: 'agent-handoff', owner, tabId, reason: payload.reason, actionHint: payload.actionHint })
      return { handedOff: true, tabId }
    }

    if (tab.state.error) throw new SystemReadError('not-loaded', '网页加载失败或进程已退出，请先检查标签状态')
    const pageDeadline = Math.min(deadline, Date.now() + 15_000)

    if (operation === 'dialog') {
      const action = input[1] as 'accept' | 'dismiss'
      const promptText = input[2] as string | undefined
      const handledDialog = await tab.cdp.handleDialog(pageDeadline, action === 'accept', promptText)
      return { tabId, handled: true, dialog: handledDialog }
    }

    if (operation === 'console.list') {
      await tab.cdp.ensureObserving(pageDeadline)
      const query = readRecord(input[1], ['level', 'cursor', 'offset', 'limit'])
      const level = query.level as string | undefined
      const items = tab.cdp.getConsoleLogs().filter((entry) => !level || entry.level === level)
      const { cursor, offset, limit } = query
      return clientReadList(items, { cursor, offset, limit }, `console.list:${tabId}`)
    }

    if (operation === 'network.list') {
      await tab.cdp.ensureObserving(pageDeadline)
      const query = readRecord(input[1], ['failedOnly', 'resourceType', 'cursor', 'offset', 'limit'])
      const failedOnly = query.failedOnly === true
      const resourceType = typeof query.resourceType === 'string' ? query.resourceType.toLowerCase() : undefined
      const items = tab.cdp.getNetworkLogs().filter((entry) => {
        if (failedOnly && !entry.failed) return false
        if (resourceType && entry.resourceType.toLowerCase() !== resourceType) return false
        return true
      })
      const { cursor, offset, limit } = query
      return clientReadList(items, { cursor, offset, limit }, `network.list:${tabId}`)
    }

    if (operation === 'read') {
      const readOpts = (input[1] as BrowserReadOptions | undefined) ?? {}
      const pendingDialog = tab.cdp.getPendingDialog()
      if (readOpts.frameId && !readOpts.frameId.startsWith('frame:')) {
        const elements = await tab.cdp.readCrossOriginFrame(pageDeadline, readOpts.frameId)
        return {
          tab: agentTabMetadata(tab.state),
          documentId,
          title: tab.state.title.slice(0, 512),
          text: '',
          elements,
          truncated: { text: false, elements: elements.length >= 150 },
          viewport: { width: 1024, height: 768, scrollX: 0, scrollY: 0, scrollHeight: 768, scrollWidth: 1024 },
          hasMoreBelow: false,
          totalElements: elements.length,
          ...(pendingDialog ? { pendingDialog } : {}),
        } satisfies BrowserAgentSnapshot
      }
      const result = await runBrowserAgentPage(web, documentId, url, pageDeadline, {
        type: 'read',
        prefix: randomUUID(),
        options: readOpts,
      })
      assertDocument(documentId)
      let frames: BrowserAgentSnapshot['frames']
      if (!readOpts.frameId && /^https?:/.test(url)) {
        try {
          const origin = new URL(url).origin
          const listed = await tab.cdp.listFrames(Math.min(pageDeadline, Date.now() + 2000), origin)
          if (listed.length) frames = listed
        } catch {
          // Do not block browser.read if DevTools occupies debugger.
        }
      }
      return {
        tab: agentTabMetadata(tab.state),
        documentId,
        ...result,
        ...(frames ? { frames } : {}),
        ...(pendingDialog ? { pendingDialog } : {}),
      } satisfies BrowserAgentSnapshot
    }

    if (operation === 'query') {
      const target = input[1] as BrowserAgentSelectorTarget
      const opts = readRecord(input[2], ['limit'])
      const limit = readInteger(opts.limit, 20, 50, 1)
      const matches = await runBrowserAgentPage(web, documentId, url, pageDeadline, {
        type: 'query',
        prefix: randomUUID(),
        target,
        limit,
      })
      assertDocument(documentId)
      return { tabId, documentId, matches }
    }

    if (operation === 'waitFor') {
      const condition = input[1] as BrowserWaitCondition
      const committedUrl = web.getURL()
      let matched = false
      if (condition.kind === 'url') {
        const expected = waitUrl(condition.url)
        if (!expected) throw new SystemReadError('invalid-input', '等待的网址须为完整 HTTP(S) 地址或 about:blank')
        matched = waitUrl(committedUrl) === expected
      } else if (condition.kind === 'ready') {
        matched = Boolean(committedUrl) && !web.isLoadingMainFrame()
      } else if (condition.kind === 'loadState') {
        matched =
          condition.state === 'domcontentloaded'
            ? Boolean(committedUrl) && tab.domReady
            : Boolean(committedUrl) && !web.isLoadingMainFrame()
      } else if (condition.kind === 'networkIdle') {
        await tab.cdp.ensureObserving(pageDeadline)
        matched = tab.cdp.isNetworkIdle(condition.idleMs ?? 500)
      } else if (condition.kind === 'download') {
        const profile = await refresh()
        matched = profile.downloads.some(
          (item) => item.state === 'completed' && (!condition.since || item.createdAt >= condition.since),
        )
      } else {
        if (condition.documentId !== undefined) assertDocument(condition.documentId)
        if (committedUrl && !web.isLoadingMainFrame()) {
          matched = await runBrowserAgentPage(web, documentId, url, pageDeadline, { type: 'probe', condition })
          if (condition.documentId !== undefined) assertDocument(condition.documentId)
        }
      }
      return { matched, tabId, documentId, url: systemMetadataUrl(committedUrl) } satisfies BrowserWaitObservation
    }

    assertDocument(input[1])

    const resolvePoint = async (target: BrowserAgentTarget, allowHiddenFile = false) => {
      if (isPointTarget(target)) return { x: target.x, y: target.y }
      const axId = getCrossOriginId(target)
      if (axId) {
        const box = await tab.cdp.resolveCrossOriginBox(pageDeadline, axId)
        if (!box) throw new SystemReadError('stale-cursor', '跨域帧控件已失效，请重新读取')
        return { x: box.x, y: box.y, backendDOMNodeId: box.backendDOMNodeId }
      }
      const meta = await runBrowserAgentPage(web, documentId, url, pageDeadline, {
        type: 'resolve',
        prefix: randomUUID(),
        target,
        allowHiddenFile,
      })
      return { x: meta.x, y: meta.y, meta }
    }

    const withPopupTracking = async (
      run: () => Promise<Partial<BrowserActionReceipt> | void>,
    ): Promise<BrowserActionReceipt> => {
      const collector: Array<{ tabId: string; url: string }> = []
      tab.popupCollector = collector
      try {
        const extra = (await run()) ?? {}
        const dialogInfo = tab.cdp.getPendingDialog()
        return {
          tabId,
          documentId: tab.state.documentId,
          delivery: extra.delivery ?? 'delivered_verified',
          ...(collector.length ? { openedTabs: collector } : {}),
          ...(dialogInfo ? { dialog: dialogInfo } : {}),
          ...(extra.scroll ? { scroll: extra.scroll } : {}),
        }
      } finally {
        if (tab.popupCollector === collector) tab.popupCollector = undefined
      }
    }

    if (operation === 'click' || operation === 'dblclick' || operation === 'hover') {
      const target = input[2] as BrowserAgentTarget
      const opts =
        (input[3] as { button?: 'left' | 'middle' | 'right'; clickCount?: number; modifiers?: string[] } | undefined) ??
        {}
      return withPopupTracking(async () => {
        const resolved = await resolvePoint(target)
        assertSignal()
        if (operation === 'hover') {
          await tab.cdp.dispatchHover(pageDeadline, resolved.x, resolved.y)
        } else {
          await tab.cdp.dispatchClick(pageDeadline, resolved.x, resolved.y, {
            button: opts.button,
            clickCount: operation === 'dblclick' ? 2 : opts.clickCount,
            modifiers: opts.modifiers,
          })
        }
      })
    }

    if (operation === 'drag') {
      const fromTarget = input[2] as BrowserAgentTarget
      const toTarget = input[3] as BrowserAgentTarget
      return withPopupTracking(async () => {
        const from = await resolvePoint(fromTarget)
        const to = await resolvePoint(toTarget)
        assertSignal()
        await tab.cdp.dispatchDrag(pageDeadline, from.x, from.y, to.x, to.y)
      })
    }

    if (operation === 'input') {
      const target = input[2] as BrowserAgentTarget
      const text = input[3] as string
      const opts = (input[4] as { mode?: 'replace' | 'append' | 'type' } | undefined) ?? {}
      const mode = opts.mode ?? 'replace'
      return withPopupTracking(async () => {
        const axId = getCrossOriginId(target)
        if (isPointTarget(target) || axId) {
          const resolved = await resolvePoint(target)
          if (resolved.backendDOMNodeId) await tab.cdp.focusBackendNode(pageDeadline, resolved.backendDOMNodeId)
          else await tab.cdp.dispatchClick(pageDeadline, resolved.x, resolved.y)
          await tab.cdp.insertText(pageDeadline, text, mode)
          return
        }
        const prepared = await runBrowserAgentPage(web, documentId, url, pageDeadline, {
          type: 'prepareInput',
          prefix: randomUUID(),
          target,
          mode,
          text,
        })
        assertSignal()
        if (!prepared.fallbackApplied) {
          await tab.cdp.insertText(pageDeadline, text, mode)
        }
      })
    }

    if (operation === 'paste') {
      const target = input[2] as BrowserAgentTarget | null
      const payload = input[3] as { text: string; html?: string }
      return withPopupTracking(async () => {
        if (target && (isPointTarget(target) || getCrossOriginId(target))) {
          const resolved = await resolvePoint(target)
          if (resolved.backendDOMNodeId) await tab.cdp.focusBackendNode(pageDeadline, resolved.backendDOMNodeId)
          else await tab.cdp.dispatchClick(pageDeadline, resolved.x, resolved.y)
          await tab.cdp.insertText(pageDeadline, payload.text, 'replace')
          return
        }
        const domRes = await runBrowserAgentPage(web, documentId, url, pageDeadline, {
          type: 'pasteDom',
          prefix: randomUUID(),
          target: target as BrowserAgentSelectorTarget | null,
          text: payload.text,
          html: payload.html,
        })
        if (!domRes.handled) {
          await tab.cdp.insertText(pageDeadline, payload.text, 'replace')
        }
      })
    }

    if (operation === 'press') {
      const target = input[2] as BrowserAgentTarget | null
      const key = input[3] as string
      return withPopupTracking(async () => {
        let beforeKey:
          | ((
              send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>,
            ) => Promise<void>)
          | undefined
        if (target !== null) {
          const axId = getCrossOriginId(target)
          if (isPointTarget(target) || axId) {
            const resolved = await resolvePoint(target)
            beforeKey = async (send) => {
              if (resolved.backendDOMNodeId) await tab.cdp.focusBackendNodeWithSend(send, resolved.backendDOMNodeId)
              else await tab.cdp.clickWithSend(send, resolved.x, resolved.y)
            }
          } else {
            beforeKey = async () => {
              await runBrowserAgentPage(web, documentId, url, pageDeadline, {
                type: 'focus',
                prefix: randomUUID(),
                target: target as BrowserAgentSelectorTarget,
              })
            }
          }
        }
        await tab.cdp.dispatchKeyChord(pageDeadline, key, beforeKey)
        return { delivery: 'delivered_unverified' }
      })
    }

    if (operation === 'select') {
      const target = input[2] as BrowserAgentSelectorTarget
      const option = input[3] as BrowserSelectOption
      if (isPointTarget(target) || getCrossOriginId(target)) {
        throw new SystemReadError('invalid-input', 'select 请传入主文档或同源帧的原生下拉控件选择器')
      }
      const changed = await runBrowserAgentPage(web, documentId, url, pageDeadline, {
        type: 'select',
        prefix: randomUUID(),
        target,
        option,
      })
      return {
        tabId,
        documentId,
        delivery: changed ? 'delivered_unverified' : 'not_needed',
      } satisfies BrowserActionReceipt
    }

    if (operation === 'scroll') {
      const scrollInput = input[2] as BrowserScrollInput
      const opts = typeof scrollInput === 'number' ? { deltaY: scrollInput } : scrollInput
      const deltaX = opts.deltaX ?? 0
      const deltaY = opts.deltaY ?? 0
      if (isPointTarget(opts.target)) {
        await tab.cdp.dispatchWheel(pageDeadline, opts.target.x, opts.target.y, deltaX, deltaY)
        return { tabId, documentId, delivery: 'delivered_unverified' } satisfies BrowserActionReceipt
      }
      const selectorTarget = opts.target as BrowserAgentSelectorTarget | undefined
      const prep = await runBrowserAgentPage(web, documentId, url, pageDeadline, {
        type: 'scrollPrep',
        prefix: randomUUID(),
        target: selectorTarget,
        to: opts.to,
      })
      if (prep.applied) {
        return { tabId, documentId, delivery: 'delivered_verified', scroll: { x: prep.scrollX, y: prep.scrollY } }
      }
      await tab.cdp.dispatchWheel(pageDeadline, prep.x, prep.y, deltaX, deltaY)
      await new Promise((resolve) => setTimeout(resolve, 40))
      const after = await runBrowserAgentPage(web, documentId, url, pageDeadline, {
        type: 'scrollPrep',
        prefix: randomUUID(),
        target: selectorTarget,
      })
      if ((deltaX !== 0 || deltaY !== 0) && after.scrollX === prep.scrollX && after.scrollY === prep.scrollY) {
        const finalPos = await runBrowserAgentPage(web, documentId, url, pageDeadline, {
          type: 'scrollFallback',
          deltaX,
          deltaY,
          target: selectorTarget,
        })
        return { tabId, documentId, delivery: 'delivered_verified', scroll: finalPos }
      }
      return { tabId, documentId, delivery: 'delivered_verified', scroll: { x: after.scrollX, y: after.scrollY } }
    }

    if (operation === 'upload') {
      const target = input[2] as BrowserAgentTarget
      const prepared = input[3] as BrowserPreparedUploadFile[]
      if (!Array.isArray(prepared) || !prepared.length) throw new SystemReadError('invalid-input', '缺少待上传文件')
      const dir = path.join(tmpdir(), `pi-meme-upload-${randomUUID()}`)
      await mkdir(dir, { recursive: true, mode: 0o700 })
      tab.uploadTempDirs.push(dir)
      const tempPaths: string[] = []
      const usedNames = new Set<string>()
      for (const file of prepared) {
        let base = path.basename(file.name) || 'upload.bin'
        if (usedNames.has(base)) base = `${tempPaths.length}-${base}`
        usedNames.add(base)
        const dest = path.join(dir, base)
        await writeFile(dest, Buffer.from(file.dataBase64, 'base64'), { mode: 0o600 })
        tempPaths.push(dest)
      }
      return withPopupTracking(async () => {
        const resolved = await resolvePoint(target, true)
        if (resolved.meta?.isFileInput && resolved.meta.fileSelector) {
          const marker = resolved.meta.fileSelector
          try {
            const applied = await tab.cdp.setFilesOnMarker(pageDeadline, marker, tempPaths)
            if (!applied) throw new SystemReadError('not-found', '未能定位到文件输入控件')
          } finally {
            await runBrowserAgentPage(web, documentId, url, pageDeadline, {
              type: 'clearFileMarker',
              marker,
            }).catch(() => {})
          }
          return
        }
        await tab.cdp.withInterceptedFileChooser(pageDeadline, tempPaths, () =>
          tab.cdp.dispatchClick(pageDeadline, resolved.x, resolved.y),
        )
      })
    }

    if (operation === 'evaluate' || operation === 'fetch') {
      const config = await refresh()
      if (!config.settings.agentScripts) {
        throw new SystemReadError(
          'disabled',
          '未开启页面脚本权限，请在「设置 → 浏览器」中开启“允许 Agent 执行页面脚本”',
          { reason: 'agent-scripts-disabled' },
        )
      }
      if (operation === 'evaluate') {
        const expression = input[2] as string
        const value = await tab.cdp.evaluateInMainWorld(pageDeadline, expression, input[3])
        return { tabId, documentId, result: value }
      }
      const fetchUrl = input[2] as string
      const opts =
        (input[3] as
          { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } | undefined) ?? {}
      const parsed = URL.parse(fetchUrl, url)
      if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) {
        throw new SystemReadError('invalid-input', 'fetch 仅支持 HTTP(S) 或同源相对路径')
      }
      const timeoutMs = Math.min(20_000, Math.max(100, opts.timeoutMs ?? 10_000))
      const fetchExpr = `async (args) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), args.timeoutMs);
        try {
          const res = await window.fetch(args.url, {
            method: args.method || 'GET',
            headers: args.headers,
            body: args.body,
            signal: controller.signal,
          });
          const headers = {};
          res.headers.forEach((v, k) => {
            if (k.toLowerCase() !== 'set-cookie') headers[k] = v;
          });
          const raw = await res.text();
          const maxChars = 32000;
          return {
            ok: res.ok,
            status: res.status,
            statusText: res.statusText,
            url: res.url,
            headers,
            body: raw.slice(0, maxChars),
            truncated: raw.length > maxChars,
          };
        } finally {
          clearTimeout(timer);
        }
      }`
      const fetchResult = (await tab.cdp.evaluateInMainWorld(
        Math.max(pageDeadline, Date.now() + timeoutMs + 2000),
        fetchExpr,
        {
          url: fetchUrl,
          method: opts.method ?? 'GET',
          headers: opts.headers,
          body: opts.body,
          timeoutMs,
        },
      )) as {
        ok: boolean
        status: number
        statusText: string
        url: string
        headers: Record<string, string>
        body: string
        truncated: boolean
      }
      return {
        ...fetchResult,
        url: systemMetadataUrl(String(fetchResult?.url ?? '')),
      }
    }

    throw new SystemReadError('not-supported', `未知的网页操作：${operation}`)
  }

  ipcMain.handle('browser:call', async (event, method: string, args: unknown[]) => {
    trusted(event)
    if (!Array.isArray(args)) throw new Error('浏览器调用参数无效')
    switch (method) {
      case 'stopAgent': {
        const [owner, tabId] = args as [string, string]
        const tab = tabs.get(tabId)
        if (tab && tab.state.owner === owner) {
          tab.agentAbort?.abort()
          tab.agentActivity = undefined
          emit({ type: 'agent-activity', owner, tabId, active: false })
        }
        return
      }
      case 'resolveHandOff': {
        const [owner, tabId] = args as [string, string]
        const tab = tabs.get(tabId)
        if (tab && tab.state.owner === owner) {
          tab.agentHandoff = undefined
          emit({ type: 'agent-handoff-clear', owner, tabId })
        }
        return
      }
      case 'agentState': {
        const [owner, tabId] = args as [string, string]
        const tab = tabs.get(tabId)
        if (!tab || tab.state.owner !== owner) return { activity: null, handoff: null }
        return {
          activity: tab.agentActivity ?? null,
          handoff: tab.agentHandoff ?? null,
        }
      }
      case 'agent': {
        const [owner, operation, input, requestedDeadline] = args
        if (typeof owner !== 'string' || typeof operation !== 'string' || !Array.isArray(input))
          throw new Error('网页操作参数无效')
        const name = `browser.${operation}`
        const definition = agentDefinitions.get(name)
        const structured =
          Boolean(definition) || browserClientReadNames.includes(name) || ['screenshot'].includes(operation)
        try {
          if (
            requestedDeadline !== undefined &&
            (typeof requestedDeadline !== 'number' || !Number.isFinite(requestedDeadline))
          )
            throw new SystemReadError('invalid-input', '网页操作截止时间无效')
          const deadline = Math.min(
            typeof requestedDeadline === 'number' ? requestedDeadline : Infinity,
            Date.now() + (operation === 'batch' || operation === 'waitFor' ? 55_000 : 30_000),
          )
          const assertDeadline = () => {
            if (Date.now() >= deadline) throw new SystemReadError('timeout', '网页操作已过期')
          }
          assertDeadline()
          if (definition && operation !== 'upload' && operation !== 'downloads.saveToWorkspace') {
            validateReadArguments(definition.inputSchema, input)
          }
          if (
            [
              'settings.get',
              'history.list',
              'downloads.list',
              'downloads.get',
              'permissions.list',
              'data.status',
            ].includes(operation)
          ) {
            const profile = await refresh()
            const scope = { kind: 'client-browser-profile', shared: true }
            if (operation === 'settings.get') {
              const { downloadDirectory, ...settings } = profile.settings
              return { scope, settings, hasDownloadDirectory: Boolean(downloadDirectory) }
            }
            if (operation === 'data.status')
              return {
                scope,
                historyCount: profile.history.length,
                downloadCount: profile.downloads.length,
                permissionCount: profile.permissions.length,
                activeDownloads: activeDownloads.size,
                cacheBytes: await guestSession.getCacheSize(),
                websiteStorage: 'not-inspected',
                cookies: 'not-inspected',
              }
            const download = (item: BrowserSnapshot['downloads'][number]) => ({
              id: item.id,
              url: systemMetadataUrl(item.url),
              name: item.name,
              received: item.received,
              total: item.total,
              state: item.state,
              createdAt: item.createdAt,
            })
            if (operation === 'downloads.get') {
              if (typeof input[0] !== 'string') throw new SystemReadError('invalid-input', '下载标识无效')
              const item = profile.downloads.find((item) => item.id === input[0])
              if (!item) throw new SystemReadError('not-found', '下载记录不存在')
              return { scope, download: download(item) }
            }
            const query = clientReadPage(input[0]).query.toLowerCase()
            const items =
              operation === 'history.list'
                ? profile.history.map((item) => ({ ...item, url: systemMetadataUrl(item.url) }))
                : operation === 'downloads.list'
                  ? profile.downloads.map(download)
                  : profile.permissions.map((item) => ({ ...item, origin: systemMetadataUrl(item.origin) }))
            return {
              scope,
              ...clientReadList(
                items.filter((item) => JSON.stringify(item).toLowerCase().includes(query)),
                input[0],
                operation,
              ),
            }
          }
          if (operation === 'downloads.saveToWorkspace') {
            if (typeof input[0] !== 'string') throw new SystemReadError('invalid-input', '下载标识无效')
            const item = (await refresh()).downloads.find((value) => value.id === input[0])
            if (!item) throw new SystemReadError('not-found', '下载记录不存在')
            if (item.state !== 'completed' || !path.isAbsolute(item.path))
              throw new SystemReadError('not-loaded', '文件尚未下载完成')
            const statInfo = await lstat(item.path).catch(() => undefined)
            if (!statInfo || statInfo.isSymbolicLink() || !statInfo.isFile())
              throw new SystemReadError('not-found', '已下载的文件不存在或不可读取')
            if (statInfo.size > 16 * 1024 * 1024)
              throw new SystemReadError('invalid-input', '下载文件超过 16 MiB 保存上限')
            const handle = await open(item.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
            try {
              const buf = Buffer.alloc(statInfo.size)
              let offset = 0
              while (offset < buf.length) {
                const { bytesRead } = await handle.read(buf, offset, buf.length - offset, offset)
                if (!bytesRead) break
                offset += bytesRead
              }
              return { name: item.name, size: offset, dataBase64: buf.subarray(0, offset).toString('base64') }
            } finally {
              await handle.close()
            }
          }
          if (operation === 'annotations.image') {
            if (typeof input[0] !== 'string') throw new SystemReadError('invalid-input', '批注标识无效')
            return await options.rpc('browser:annotation-image', [owner, input[0]])
          }
          if (['list', 'workspace', 'annotations.list', 'annotations.get'].includes(operation)) {
            const workspace = await options.rpc<BrowserWorkspaceMetadata>('browser:peek-workspace', [owner])
            const tabMetadata = (item: BrowserTab) => {
              const live = tabs.get(item.id)?.state
              return agentTabMetadata(live?.owner === owner ? live : item)
            }
            if (operation === 'list') return workspace.tabs.map(tabMetadata)
            if (operation === 'workspace')
              return {
                tabs: workspace.tabs.map(tabMetadata),
                annotationCount: workspace.annotations.length,
                editor: workspace.editor
                  ? {
                      id: workspace.editor.id,
                      tabId: workspace.editor.tabId,
                      kind: workspace.editor.kind,
                      hasImage: workspace.editor.hasImage,
                      hasComment: Boolean(workspace.editor.comment),
                    }
                  : undefined,
              }
            if (operation === 'annotations.list')
              return clientReadList(
                workspace.annotations.map((item) => ({
                  id: item.id,
                  tabId: item.tabId,
                  documentId: item.documentId,
                  kind: item.kind,
                  title: item.title,
                  url: systemMetadataUrl(item.url),
                  capturedAt: item.capturedAt,
                  comment: item.comment.slice(0, 500),
                  hasImage: item.hasImage,
                })),
                input[0],
                `${operation}:${owner}`,
              )
            if (typeof input[0] !== 'string') throw new SystemReadError('invalid-input', '批注标识无效')
            const item = workspace.annotations.find((item) => item.id === input[0])
            if (!item) throw new SystemReadError('not-found', '当前会话中不存在此批注')
            const record = {
              ...item,
              url: systemMetadataUrl(item.url),
              frameUrl: item.frameUrl ? systemMetadataUrl(item.frameUrl) : undefined,
            }
            const query = readRecord(input[1], ['offset', 'limit', 'revision'])
            return { id: item.id, format: 'application/json', ...readText(JSON.stringify(record), query) }
          }
          if (operation === 'open') {
            if (typeof input[0] !== 'string') throw new Error('网页地址无效')
            const workspace = await options.rpc<BrowserWorkspace>('browser:workspace', [owner])
            assertDeadline()
            const created = await makeTab(owner, randomUUID(), input[0])
            await options.rpc('browser:save-workspace', [owner, { ...workspace, tabs: [...workspace.tabs, created] }])
            const opened = tabs.get(created.id)
            if (opened) touchAgentKeepAlive(opened)
            emit({ type: 'tab', tab: created })
            return agentTabMetadata(created)
          }
          if (typeof input[0] !== 'string') throw new SystemReadError('invalid-input', '网页标签标识无效')
          const tab = tabs.get(input[0])
          const web = tab ? liveWeb(tab.view) : undefined
          if (!tab || tab.state.owner !== owner || !web)
            throw new SystemReadError('not-found', '网页未加载、已关闭或不属于此会话')
          if (operation === 'close') {
            const workspace = await options.rpc<BrowserWorkspace>('browser:workspace', [owner])
            assertDeadline()
            await options.rpc('browser:save-workspace', [
              owner,
              { ...workspace, tabs: workspace.tabs.filter((item) => item.id !== tab.state.id) },
            ])
            if (visible === tab) {
              visible = undefined
              closeOverlays()
            }
            attachedWindow?.contentView.removeChildView(tab.view)
            cleanupTab(tab)
            web.close()
            tabs.delete(tab.state.id)
            emit({ type: 'tab-closed', owner, id: tab.state.id })
            return { closed: true }
          }
          if (operation === 'navigate') {
            if (typeof input[1] !== 'string') throw new Error('网页地址无效')
            touchAgentKeepAlive(tab)
            await command(tab, { type: 'navigate', url: input[1] })
            return agentTabMetadata(tab.state)
          }
          if (operation === 'screenshot') {
            touchAgentKeepAlive(tab)
            if (!tab.capture) {
              tab.capture = tab.cdp
                .withSession(Math.min(deadline, Date.now() + 20_000), async (send) => {
                  const { cssVisualViewport: viewport } = (await send('Page.getLayoutMetrics')) as {
                    cssVisualViewport?: { pageX: number; pageY: number; clientWidth: number; clientHeight: number }
                  }
                  if (!viewport || viewport.clientWidth <= 0 || viewport.clientHeight <= 0)
                    throw new Error('网页尚未完成布局，请加载完成后重试截图')
                  const result = (await send('Page.captureScreenshot', {
                    format: 'png',
                    fromSurface: true,
                    captureBeyondViewport: true,
                    clip: {
                      x: viewport.pageX,
                      y: viewport.pageY,
                      width: viewport.clientWidth,
                      height: viewport.clientHeight,
                      scale: 1,
                    },
                  })) as { data?: unknown }
                  if (typeof result.data !== 'string' || !result.data.startsWith('iVBORw0KGgo'))
                    throw new Error('网页截图未返回有效 PNG')
                  return result.data
                })
                .finally(() => {
                  tab.capture = undefined
                })
            }
            return { type: 'image', mimeType: 'image/png', data: await tab.capture }
          }

          touchAgentKeepAlive(tab)
          const isWrite = Boolean(definition?.write)
          const controller = new AbortController()
          if (isWrite) {
            tab.agentAbort = controller
            const label = operationLabel(operation)
            tab.agentActivity = { active: true, label }
            emit({
              type: 'agent-activity',
              owner,
              tabId: tab.state.id,
              active: true,
              operation,
              label,
            })
          }
          try {
            if (operation === 'batch') {
              const steps = input[1] as BrowserBatchStep[]
              const opts =
                (input[2] as { stopOnError?: boolean; readAfter?: boolean | BrowserReadOptions } | undefined) ?? {}
              const stopOnError = opts.stopOnError !== false
              const results: Array<{ index: number; op: string; ok: boolean; result?: unknown; error?: string }> = []
              let stoppedReason: string | undefined
              let expectedDoc = tab.state.documentId

              for (let index = 0; index < Math.min(steps.length, browserBatchMaxSteps); index++) {
                if (controller.signal.aborted) {
                  stoppedReason = 'user-aborted'
                  break
                }
                const step = steps[index]
                const currentDoc = tab.state.documentId
                if (tab.cdp.getPendingDialog() && step.op !== 'dialog') {
                  stoppedReason = 'pending-dialog'
                  break
                }
                try {
                  let stepResult: unknown
                  if (step.op === 'navigate') {
                    await command(tab, { type: 'navigate', url: step.url })
                    expectedDoc = tab.state.documentId
                    stepResult = agentTabMetadata(tab.state)
                  } else if (step.op === 'back' || step.op === 'forward' || step.op === 'reload') {
                    const prevDoc = tab.state.documentId
                    stepResult = await executeTabOperation(
                      tab,
                      owner,
                      step.op,
                      [tab.state.id],
                      deadline,
                      controller.signal,
                    )
                    const navKickoffEnd = Math.min(deadline, Date.now() + 250)
                    while (
                      !web.isLoadingMainFrame() &&
                      tab.state.documentId === prevDoc &&
                      Date.now() < navKickoffEnd
                    ) {
                      if (controller.signal.aborted) break
                      await new Promise((r) => setTimeout(r, 25))
                    }
                    expectedDoc = tab.state.documentId
                  } else if (step.op === 'dialog') {
                    stepResult = await executeTabOperation(
                      tab,
                      owner,
                      'dialog',
                      [tab.state.id, step.action, step.promptText],
                      deadline,
                      controller.signal,
                    )
                  } else if (step.op === 'waitFor') {
                    const waitLimit = Math.min(deadline, Date.now() + (step.timeoutMs ?? 10_000))
                    let obs: BrowserWaitObservation | undefined
                    let dialogInterrupted = false
                    for (;;) {
                      if (controller.signal.aborted) throw new SystemReadError('cancelled', '用户已接管当前网页操作')
                      if (tab.cdp.getPendingDialog()) {
                        dialogInterrupted = true
                        break
                      }
                      try {
                        obs = (await executeTabOperation(
                          tab,
                          owner,
                          'waitFor',
                          [tab.state.id, step.condition],
                          waitLimit + 500,
                          controller.signal,
                        )) as BrowserWaitObservation
                      } catch (cause) {
                        if (!(cause instanceof SystemReadError) || cause.code !== 'timeout' || Date.now() < waitLimit)
                          throw cause
                        obs = {
                          tabId: tab.state.id,
                          documentId: tab.state.documentId,
                          url: systemMetadataUrl(web.getURL() || tab.state.url),
                          matched: false,
                        }
                      }
                      const rem = waitLimit - Date.now()
                      if (obs.matched || rem <= 0) break
                      await new Promise((r) => setTimeout(r, Math.min(250, rem)))
                    }
                    if (dialogInterrupted) {
                      stoppedReason = 'pending-dialog'
                      break
                    }
                    expectedDoc = tab.state.documentId
                    stepResult = {
                      tabId: obs!.tabId,
                      documentId: obs!.documentId,
                      url: obs!.url,
                      status: obs!.matched ? 'matched' : 'timed-out',
                    }
                    if (!obs!.matched && stopOnError) {
                      results.push({ index, op: step.op, ok: false, result: stepResult, error: '等待条件超时' })
                      stoppedReason = 'wait-timed-out'
                      break
                    }
                  } else {
                    const stepArgs: Record<string, unknown[]> = {
                      click: [
                        tab.state.id,
                        currentDoc,
                        (step as Extract<BrowserBatchStep, { op: 'click' }>).target,
                        (step as Extract<BrowserBatchStep, { op: 'click' }>).options,
                      ],
                      dblclick: [
                        tab.state.id,
                        currentDoc,
                        (step as Extract<BrowserBatchStep, { op: 'dblclick' }>).target,
                      ],
                      hover: [tab.state.id, currentDoc, (step as Extract<BrowserBatchStep, { op: 'hover' }>).target],
                      drag: [
                        tab.state.id,
                        currentDoc,
                        (step as Extract<BrowserBatchStep, { op: 'drag' }>).from,
                        (step as Extract<BrowserBatchStep, { op: 'drag' }>).to,
                      ],
                      input: [
                        tab.state.id,
                        currentDoc,
                        (step as Extract<BrowserBatchStep, { op: 'input' }>).target,
                        (step as Extract<BrowserBatchStep, { op: 'input' }>).text,
                        { mode: (step as Extract<BrowserBatchStep, { op: 'input' }>).mode },
                      ],
                      paste: [
                        tab.state.id,
                        currentDoc,
                        (step as Extract<BrowserBatchStep, { op: 'paste' }>).target ?? null,
                        {
                          text: (step as Extract<BrowserBatchStep, { op: 'paste' }>).text,
                          html: (step as Extract<BrowserBatchStep, { op: 'paste' }>).html,
                        },
                      ],
                      press: [
                        tab.state.id,
                        currentDoc,
                        (step as Extract<BrowserBatchStep, { op: 'press' }>).target ?? null,
                        (step as Extract<BrowserBatchStep, { op: 'press' }>).key,
                      ],
                      select: [
                        tab.state.id,
                        currentDoc,
                        (step as Extract<BrowserBatchStep, { op: 'select' }>).target,
                        (step as Extract<BrowserBatchStep, { op: 'select' }>).selection,
                      ],
                      scroll: [
                        tab.state.id,
                        currentDoc,
                        (step as Extract<BrowserBatchStep, { op: 'scroll' }>).delta !== undefined
                          ? (step as Extract<BrowserBatchStep, { op: 'scroll' }>).delta
                          : {
                              deltaX: (step as Extract<BrowserBatchStep, { op: 'scroll' }>).deltaX,
                              deltaY: (step as Extract<BrowserBatchStep, { op: 'scroll' }>).deltaY,
                              target: (step as Extract<BrowserBatchStep, { op: 'scroll' }>).target,
                              to: (step as Extract<BrowserBatchStep, { op: 'scroll' }>).to,
                            },
                      ],
                    }
                    stepResult = await executeTabOperation(
                      tab,
                      owner,
                      step.op,
                      stepArgs[step.op],
                      deadline,
                      controller.signal,
                    )
                  }
                  results.push({ index, op: step.op, ok: true, result: stepResult })
                  const next = steps[index + 1]
                  if (
                    next &&
                    tab.state.documentId !== expectedDoc &&
                    ['click', 'dblclick', 'hover', 'drag', 'input', 'paste', 'press', 'select', 'scroll'].includes(
                      next.op,
                    )
                  ) {
                    stoppedReason = 'document-changed'
                    break
                  }
                } catch (cause) {
                  const message = cause instanceof Error ? cause.message : String(cause)
                  results.push({ index, op: step.op, ok: false, error: message })
                  if (controller.signal.aborted || (cause instanceof SystemReadError && cause.code === 'cancelled')) {
                    stoppedReason = 'user-aborted'
                    break
                  }
                  if (stopOnError) {
                    stoppedReason = 'step-error'
                    break
                  }
                }
              }

              let readSnapshot: BrowserAgentSnapshot | undefined
              if (opts.readAfter) {
                const readOpts = typeof opts.readAfter === 'object' ? opts.readAfter : undefined
                readSnapshot = (await executeTabOperation(
                  tab,
                  owner,
                  'read',
                  [tab.state.id, readOpts],
                  deadline,
                  controller.signal,
                ).catch(() => undefined)) as BrowserAgentSnapshot | undefined
              }
              return {
                tabId: tab.state.id,
                completedSteps: results.length,
                totalSteps: steps.length,
                results,
                ...(stoppedReason ? { stoppedReason } : {}),
                ...(readSnapshot ? { snapshot: readSnapshot } : {}),
              }
            }
            return await executeTabOperation(tab, owner, operation, input, deadline, controller.signal)
          } finally {
            if (isWrite) {
              if (tab.agentAbort === controller) tab.agentAbort = undefined
              tab.agentActivity = undefined
              emit({ type: 'agent-activity', owner, tabId: tab.state.id, active: false })
            }
          }
        } catch (cause) {
          if (!structured) throw cause
          return {
            type: 'browser-agent-read-error',
            errorCode: cause instanceof SystemReadError ? cause.code : 'internal-error',
            error: cause instanceof SystemReadError ? cause.message : '网页操作失败，请核对目标与浏览器状态',
            errorDetails: cause instanceof SystemReadError ? cause.details : undefined,
          }
        }
      }
      case 'snapshot':
        return refresh()
      case 'settings-page':
        emit({ type: 'settings' })
        return
      case 'settings':
        snapshot = await options.rpc('browser:settings', args)
        changed()
        return snapshot
      case 'permission':
        snapshot = await options.rpc('browser:permission', args)
        changed()
        return snapshot
      case 'workspace': {
        const owner = String(args[0])
        const config = snapshot ?? (await refresh())
        if (!visitedWorkspaces.has(owner) && !config.settings.restore)
          await options.rpc('browser:save-workspace', [owner, { tabs: [], annotations: [] }])
        visitedWorkspaces.add(owner)
        return options.rpc('browser:workspace', [owner])
      }
      case 'saveWorkspace':
        return options.rpc('browser:save-workspace', args)
      case 'rebind': {
        await options.rpc('browser:rebind', args)
        for (const tab of tabs.values()) if (tab.state.owner === args[0]) tab.state.owner = String(args[1])
        return
      }
      case 'create':
        return makeTab(String(args[0]), String(args[1]), args[2] === undefined ? undefined : String(args[2]))
      case 'close': {
        const tab = tabs.get(String(args[0]))
        if (tab) {
          if (visible === tab) {
            visible = undefined
            closeOverlays()
          }
          attachedWindow?.contentView.removeChildView(tab.view)
          cleanupTab(tab)
          liveWeb(tab.view)?.close()
          tabs.delete(tab.state.id)
        }
        return
      }
      case 'present': {
        const tab = tabs.get(String(args[0]))
        if (!tab) return null
        const bounds = args[1] as BrowserRect | null
        if (!bounds) {
          const capturePreview = visible === tab && args[4] !== false
          tab.bounds = undefined
          if (visible === tab) {
            closeOverlays()
            visible = undefined
          }
          if (isKeepAliveEffective(tab)) {
            syncTabHosting(tab)
          } else {
            tab.view.webContents.setBackgroundThrottling(args[4] !== false)
            detachTabView(tab)
          }
          return capturePreview ? preview(tab) : null
        }
        if (
          ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) ||
          bounds.width < 1 ||
          bounds.height < 1
        )
          throw new Error('网页视图边界无效')
        const previousVisible = visible && visible !== tab ? visible : undefined
        if (visible !== tab) {
          closeOverlays()
          visible = tab
        }
        if (previousVisible) syncTabHosting(previousVisible)
        tab.bounds = {
          x: Math.round(bounds.x),
          y: Math.round(bounds.y),
          width: Math.round(bounds.width),
          height: Math.round(bounds.height),
        }
        tab.lastViewport = {
          width: Math.max(320, tab.bounds.width),
          height: Math.max(240, tab.bounds.height),
        }
        tab.theme = args[2] === 'light' ? 'light' : 'dark'
        const colors = args[3] as ThemeColors | undefined
        if (colors !== undefined) {
          if (
            !colors ||
            typeof colors !== 'object' ||
            !(
              [
                'background',
                'surface',
                'elevated',
                'text',
                'muted',
                'border',
                'accent',
                'accentText',
                'success',
                'error',
              ] as const
            ).every((key) => typeof colors[key] === 'string' && colors[key].length <= 256)
          )
            throw new Error('浏览器主题颜色无效')
          tab.colors = colors
        }
        picker(tab, { colors: tab.colors })
        tab.view.setBounds(tab.bounds)
        tab.view.webContents.setBackgroundThrottling(!isKeepAliveEffective(tab))
        if (tab.state.error || tab.state.url === 'about:blank') {
          detachTabView(tab)
          closeOverlays()
          return null
        }
        const parent = attachedWindow?.contentView
        if (parent && !parent.children.includes(tab.view)) parent.addChildView(tab.view)
        tab.view.setVisible(true)
        if (tab.enabled) {
          await showOverlay(tab, 'toolbar')
          if (tab.editor && tab.editorVisible) await showOverlay(tab, 'editor')
        }
        positionOverlays(tab)
        return null
      }
      case 'preview': {
        const tab = tabs.get(String(args[0]))
        if (!tab) return null
        if (visible !== tab)
          await Promise.race([
            tab.view.webContents
              .executeJavaScript('new Promise((resolve) => requestAnimationFrame(resolve))')
              .catch(() => {}),
            new Promise((resolve) => setTimeout(resolve, 200)),
          ])
        return preview(tab)
      }
      case 'command': {
        const tab = tabs.get(String(args[0]))
        if (!tab) throw new Error('网页标签已关闭')
        return command(tab, args[1] as BrowserCommand)
      }
      case 'history':
        snapshot = await options.rpc('browser:history', args)
        changed()
        return snapshot
      case 'searchQuery':
        snapshot = await options.rpc('browser:search-query', args)
        changed()
        return snapshot
      case 'navigationHistory': {
        const tab = tabs.get(String(args[0]))
        if (!tab) return { index: -1, entries: [] }
        return {
          index: tab.view.webContents.navigationHistory.getActiveIndex(),
          entries: tab.view.webContents.navigationHistory
            .getAllEntries()
            .map((entry, index) => ({ index, title: entry.title, url: entry.url })),
        }
      }
      case 'suggest': {
        const config = snapshot ?? (await refresh())
        if (config.settings.searchSuggestions === false) return []
        const query = String(args[0] ?? '').trim()
        if (!query || query.length > 200 || isLikelyUrlInput(query)) return []
        const endpoint = {
          google: `https://suggestqueries.google.com/complete/search?client=chrome&hl=zh-CN&ie=utf-8&oe=utf-8&q=${encodeURIComponent(query)}`,
          bing: `https://api.bing.com/osjson.aspx?query=${encodeURIComponent(query)}`,
          duckduckgo: `https://duckduckgo.com/ac/?q=${encodeURIComponent(query)}&type=list`,
        }[config.settings.search]
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 2000)
        try {
          const response = await guestSession.fetch(endpoint, {
            signal: controller.signal,
            headers: { 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' },
          })
          if (!response.ok) return []
          const payload = (await response.json()) as unknown
          if (!Array.isArray(payload) || !Array.isArray(payload[1])) return []
          const texts = payload[1] as unknown[]
          const descriptions = Array.isArray(payload[2]) ? (payload[2] as unknown[]) : []
          const seen = new Set<string>()
          const items: BrowserSuggestion[] = []
          for (let index = 0; index < texts.length && items.length < 6; index++) {
            const rawText = texts[index]
            const text = typeof rawText === 'string' ? rawText.trim() : ''
            if (!text) continue
            const lower = text.toLocaleLowerCase()
            if (seen.has(lower)) continue
            seen.add(lower)
            const rawDescription = descriptions[index]
            const description =
              typeof rawDescription === 'string' && rawDescription.trim() ? rawDescription.trim() : undefined
            items.push(description ? { text, description } : { text })
          }
          return items
        } catch {
          return []
        } finally {
          clearTimeout(timer)
        }
      }
      case 'download': {
        const id = String(args[0])
        const action = args[1]
        if (action === 'cancel') {
          activeDownloads.get(id)?.cancel()
          return
        }
        const item = (await refresh()).downloads.find((value) => value.id === id)
        if (!item) throw new Error('下载记录不存在')
        if (action === 'remove') {
          if (activeDownloads.has(id)) throw new Error('请先取消下载')
          await options.rpc('browser:download', [id])
          changed()
          return
        }
        if (item.state !== 'completed' || !path.isAbsolute(item.path)) throw new Error('文件尚未下载完成')
        if (action === 'open') {
          const error = await shell.openPath(item.path)
          if (error) throw new Error(error)
        } else if (action === 'reveal') shell.showItemInFolder(item.path)
        else throw new Error('下载操作无效')
        return
      }
      case 'chooseDownloadDirectory': {
        const window = options.getWindow()
        if (!window) throw new Error('窗口已关闭')
        const result = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] })
        return result.canceled ? null : result.filePaths[0]
      }
      case 'clear': {
        const parts = args[0] as string[]
        if (!Array.isArray(parts) || parts.some((part) => !['history', 'storage', 'cache', 'downloads'].includes(part)))
          throw new Error('清理选项无效')
        if (parts.includes('storage')) await guestSession.clearStorageData()
        if (parts.includes('cache')) await guestSession.clearCache()
        if (parts.includes('history')) await options.rpc('browser:history')
        if (parts.includes('downloads')) await options.rpc('browser:clear-downloads')
        await refresh()
        changed()
        return
      }
      case 'openLink': {
        const config = await refresh()
        const url = browserUrl(String(args[0]), config.settings.search)
        const target = isLocalBrowserUrl(url) ? config.settings.localLinks : config.settings.links
        if (target === 'external') {
          await shell.openExternal(url)
          return
        }
        const tab = await makeTab(String(args[1]), randomUUID(), url)
        emit({ type: 'open', tab })
        return
      }
      default:
        throw new Error('未知浏览器操作')
    }
  })
  void refresh().catch(console.error)
}
