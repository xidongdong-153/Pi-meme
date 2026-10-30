import { existsSync } from 'node:fs'
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
  BrowserCommand,
  BrowserDownload,
  BrowserEvent,
  BrowserOverlayAction,
  BrowserOverlayState,
  BrowserPermission,
  BrowserRect,
  BrowserSnapshot,
  BrowserTab,
  BrowserWorkspace,
} from '@pi-meme/contracts/browser'
import type { ThemeColors } from '@pi-meme/contracts/settings'
import { browserUrl, isLocalBrowserUrl } from '@pi-meme/browser/shared/navigation'
import { validAnnotation } from '@pi-meme/browser/shared/annotations'

type Rpc = <T>(method: string, args?: unknown[]) => Promise<T>
type Tab = {
  state: BrowserTab
  view: WebContentsView
  bounds?: BrowserRect
  enabled: boolean
  theme: 'dark' | 'light'
  colors?: ThemeColors
  annotations: BrowserAnnotation[]
  editorVisible: boolean
  editor?: BrowserAnnotation
  editorPosition?: BrowserRect
  editorOriginal?: BrowserAnnotation
  editorHeight?: number
  expanded: boolean
  hidden: boolean
  toolbarOffset: { x: number; y: number }
  toolbarMenuOpen: boolean
  screenshot: BrowserSnapshot['settings']['screenshots']
  find?: { requestId: number; text: string }
  capture?: Promise<string>
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
  const tabFor = (sender: WebContents) => [...tabs.values()].find((tab) => tab.view.webContents === sender)
  const overlayFor = (sender: WebContents) => [...overlays].find((item) => item.view.webContents === sender)
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
        if (!item.view.webContents.isDestroyed()) item.view.webContents.close()
      }
  }
  const picker = (tab: Tab, value: object) => {
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.send('browser:picker', value)
  }
  const visibleMarkers = (tab: Tab) =>
    tab.annotations.flatMap((annotation, index) =>
      annotation.tabId === tab.state.id && annotation.documentId === tab.state.documentId
        ? [{ ...annotation, markerNumber: index + 1 }]
        : [],
    )
  const overlayState = (item: Overlay): BrowserOverlayState => ({
    kind: item.kind,
    tabId: item.tab.state.id,
    owner: item.tab.state.owner,
    annotation: item.tab.editor ? { ...item.tab.editor, image: undefined } : undefined,
    screenshot: item.tab.screenshot,
    count: item.tab.annotations.length,
    enabled: item.tab.enabled,
    hidden: item.tab.hidden,
    editing: !!item.tab.editorOriginal,
    expanded: item.tab.expanded,
    toolbarOffset: item.tab.toolbarOffset,
    theme: item.tab.theme,
    colors: item.tab.colors,
  })
  const positionOverlays = (tab: Tab) => {
    const bounds = tab.bounds
    if (!bounds) return
    for (const item of overlays)
      if (item.tab === tab) {
        if (item.kind === 'toolbar') {
          const width = Math.min(392, bounds.width)
          const height = tab.toolbarMenuOpen ? 210 : 52
          const originX = Math.round((bounds.width - width) / 2)
          const x = Math.max(0, Math.min(bounds.width - width, originX + tab.toolbarOffset.x))
          const y = Math.max(0, Math.min(bounds.height - height, bounds.height - height - 8 + tab.toolbarOffset.y))
          item.view.setBounds({
            x: bounds.x + Math.round(x),
            y: bounds.y + Math.round(y),
            width,
            height,
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
          const width = Math.min(tab.expanded ? 356 : 336, bounds.width)
          const height = Math.min(
            tab.expanded ? Math.max(356, tab.editorHeight ?? 64) : (tab.editorHeight ?? 64),
            bounds.height,
          )
          const top = box.y + box.height + 8
          const y = top + height <= bounds.height - 60 ? top : Math.max(0, box.y - height - 8)
          item.view.setBounds({
            x: bounds.x + Math.round(Math.max(0, Math.min(box.x, bounds.width - width))),
            y: bounds.y + Math.round(Math.min(y, bounds.height - height)),
            width,
            height,
          })
        }
        item.view.webContents.send('browser:overlay-update', overlayState(item))
      }
  }
  const showOverlay = async (tab: Tab, kind: Overlay['kind']) => {
    const window = options.getWindow()
    if (!window || visible !== tab || !tab.bounds || !tab.enabled || (kind === 'editor' && !tab.editorVisible)) return
    const found = [...overlays].find((item) => item.kind === kind && item.tab === tab)
    if (found) {
      positionOverlays(tab)
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
  const setEnabled = async (tab: Tab, enabled: boolean, region = false) => {
    tab.enabled = enabled
    picker(tab, { enabled, region, hidden: tab.hidden, editing: enabled && tab.editorVisible, reset: !enabled })
    emit({ type: 'annotation-mode', tabId: tab.state.id, enabled })
    if (enabled) {
      await showOverlay(tab, 'toolbar')
      if (tab.editor && tab.editorVisible) await showOverlay(tab, 'editor')
    } else closeOverlays()
  }
  const command = async (tab: Tab, value: BrowserCommand) => {
    const web = tab.view.webContents
    switch (value.type) {
      case 'navigate':
        tab.state.error = undefined
        await web.loadURL(browserUrl(value.url, (snapshot ?? (await refresh())).settings.search)).catch(() => {})
        break
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
      case 'stop':
        web.stop()
        break
      case 'focus':
        if (visible === tab) web.focus()
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
        await setEnabled(tab, value.enabled, Boolean(value.region))
        break
      case 'markers':
        if (!Array.isArray(value.annotations)) throw new Error('批注标记无效')
        tab.annotations = value.annotations.filter(validAnnotation)
        picker(tab, { annotations: visibleMarkers(tab) })
        positionOverlays(tab)
        break
      case 'annotation-state':
        emit({ type: 'annotation-mode', tabId: tab.state.id, enabled: tab.enabled })
        break
      case 'restore-editor':
        if (!validAnnotation(value.annotation) || value.annotation.tabId !== tab.state.id)
          throw new Error('待恢复批注无效')
        tab.editor = value.annotation
        tab.editorPosition = value.annotation.rect
        tab.editorOriginal = tab.annotations.find((item) => item.id === value.annotation.id)
        tab.editorHeight = undefined
        tab.editorVisible = true
        picker(tab, { highlightId: tab.editorOriginal?.id ?? null })
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
        await options.rpc('browser:save-workspace', [
          tab.state.owner,
          { ...workspace, annotations: [...workspace.annotations, captured] },
        ])
        emit({ type: 'annotation', owner: tab.state.owner, annotation: captured })
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
      window.once('closed', () => {
        closeOverlays()
        for (const tab of tabs.values()) if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
        tabs.clear()
        visible = undefined
        attachedWindow = undefined
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
      theme: 'dark',
      annotations: [],
      editorVisible: false,
      expanded: false,
      hidden: false,
      toolbarOffset: { x: 0, y: 0 },
      toolbarMenuOpen: false,
      screenshot: config.settings.screenshots,
    }
    tabs.set(id, tab)
    window.contentView.addChildView(view)
    view.setVisible(false)
    const web = view.webContents
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
    web.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => {
      if (isMainFrame && !inPlace) {
        tab.find = undefined
        tab.state.documentId++
        tab.state.error = undefined
        tab.state.favicon = undefined
        tab.editorVisible = false
        if (visible === tab) closeOverlays('editor')
      }
    })
    web.on('did-start-loading', sync)
    web.on('did-stop-loading', sync)
    web.on('page-title-updated', sync)
    web.on('page-favicon-updated', (_event, favicons) => {
      const candidate = favicons.find((value) => /^https?:|^data:image\//.test(value))
      const documentId = tab.state.documentId
      if (!candidate) return
      if (candidate.startsWith('data:image/')) {
        if (candidate.length <= 700_000) {
          tab.state.favicon = candidate
          publish(tab)
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
        })
        .catch(() => {})
    })
    web.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
      if (!isMainFrame) return
      tab.state.documentId++
      tab.editorVisible = false
      tab.state.favicon = undefined
      if (visible === tab) closeOverlays('editor')
      sync()
      picker(tab, { enabled: tab.enabled, documentId: tab.state.documentId, annotations: [], reset: true })
    })
    web.on('dom-ready', () => {
      picker(tab, {
        enabled: tab.enabled,
        hidden: tab.hidden,
        documentId: tab.state.documentId,
        annotations: visibleMarkers(tab),
      })
      if (tab.enabled && visible === tab) void showOverlay(tab, 'toolbar').catch(console.error)
    })
    web.on('did-finish-load', () => {
      sync()
      if (/^https?:/.test(tab.state.url))
        void options
          .rpc('browser:history', [
            { id: randomUUID(), url: tab.state.url, title: tab.state.title, visitedAt: new Date().toISOString() },
          ])
          .then(changed)
          .catch(console.error)
    })
    web.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) {
        tab.state.error = `网页加载失败：${description}（${code}）`
        sync()
        if (visible === tab) {
          view.setVisible(false)
          closeOverlays()
        }
      }
    })
    web.on('render-process-gone', (_event, details) => {
      tab.state.error = `网页进程已退出：${details.reason}`
      tab.state.loading = false
      view.setVisible(false)
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
      if (details.features || details.postBody)
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
      void makeTab(tab.state.owner, newId, details.url)
        .then((value) => emit({ type: 'open', tab: value }))
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
    tab.editor = annotation
    tab.editorPosition = annotation.rect
    tab.editorOriginal = undefined
    tab.editorHeight = undefined
    tab.expanded = false
    picker(tab, { highlightId: null, editing: true })
    tab.editorVisible = true
    void capture(tab, tab.screenshot, annotation)
      .then((saved) => {
        if (tab.editor?.id !== annotation.id || tab.state.documentId !== annotation.documentId) return
        tab.editor = saved
        emit({ type: 'editor', owner: tab.state.owner, annotation: saved })
        return showOverlay(tab, 'editor')
      })
      .catch((cause) => {
        if (tab.editor?.id !== annotation.id || tab.state.documentId !== annotation.documentId) return
        tab.editor = annotation
        emit({ type: 'editor', owner: tab.state.owner, annotation })
        void showOverlay(tab, 'editor').catch(console.error)
        console.error(String(cause))
      })
  })
  ipcMain.on('browser:selection-position', (event, box: BrowserRect) => {
    const tab = guestHandler(event)
    if (tab?.editor && tab.editorVisible && box && [box.x, box.y, box.width, box.height].every(Number.isFinite)) {
      tab.editorPosition = box
      positionOverlays(tab)
    }
  })
  ipcMain.on('browser:selection-cancel', (event) => {
    const tab = guestHandler(event)
    if (!tab || tab !== visible || !tab.enabled || !tab.editorVisible) return
    tab.editor = undefined
    tab.editorPosition = undefined
    tab.editorOriginal = undefined
    tab.editorHeight = undefined
    tab.editorVisible = false
    tab.expanded = false
    picker(tab, { reset: true })
    emit({ type: 'editor', owner: tab.state.owner })
    closeOverlays('editor')
  })
  ipcMain.on('browser:marker-click', (event, id: unknown) => {
    const tab = guestHandler(event)
    if (!tab || !tab.enabled || typeof id !== 'string') return
    const annotation = tab.annotations.find(
      (item) => item.id === id && item.tabId === tab.state.id && item.documentId === tab.state.documentId,
    )
    if (!annotation) return
    tab.editorOriginal = annotation
    tab.editorHeight = undefined
    tab.editor = structuredClone(annotation)
    tab.editorPosition = annotation.rect
    tab.editorVisible = true
    tab.expanded = false
    picker(tab, { highlightId: id, editing: true })
    emit({ type: 'editor', owner: tab.state.owner, annotation: tab.editor })
    void showOverlay(tab, 'editor').catch(console.error)
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
  const saveEditor = async (tab: Tab) => {
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
      tab.editor = undefined
      tab.editorPosition = undefined
      tab.editorOriginal = undefined
      picker(tab, { annotations: visibleMarkers(tab), reset: true })
      emit({ type: 'annotation', owner: tab.state.owner, annotation })
      emit({ type: 'editor', owner: tab.state.owner })
      closeOverlays('editor')
      positionOverlays(tab)
    } finally {
      overlayBusy = false
    }
  }
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
    if (action.type === 'comment') {
      if (item.kind !== 'editor' || !tab.editor || typeof action.text !== 'string' || action.text.length > 16000)
        throw new Error('批注评论无效')
      tab.editor.comment = action.text
      emit({ type: 'editor', owner: tab.state.owner, annotation: tab.editor })
      return
    }
    if (action.type === 'include') {
      if (!['element', 'viewport', 'none'].includes(action.screenshot)) throw new Error('截图方式无效')
      tab.screenshot = action.screenshot
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
    if (action.type === 'move-toolbar') {
      if (item.kind !== 'toolbar' || !tab.bounds || !Number.isFinite(action.x) || !Number.isFinite(action.y))
        throw new Error('工具条位置无效')
      const width = Math.min(392, tab.bounds.width)
      const originX = Math.round((tab.bounds.width - width) / 2)
      tab.toolbarOffset = {
        x: Math.max(-originX, Math.min(tab.bounds.width - width - originX, action.x)),
        y: Math.max(-(tab.bounds.height - 60), Math.min(8, action.y)),
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
      picker(tab, { original: action.pressed })
      return
    }
    if (action.type === 'cancel') {
      if (tab.editorOriginal) {
        tab.editor = undefined
        tab.editorPosition = undefined
        tab.editorOriginal = undefined
        emit({ type: 'editor', owner: tab.state.owner })
      }
      tab.editorVisible = false
      picker(tab, { reset: true })
      closeOverlays('editor')
      return
    }
    if (action.type === 'remove') {
      if (item.kind !== 'editor' || !tab.editorOriginal) throw new Error('批注目标无效')
      const id = tab.editorOriginal.id
      const workspace = await options.rpc<BrowserWorkspace>('browser:workspace', [tab.state.owner])
      await options.rpc('browser:save-workspace', [
        tab.state.owner,
        { ...workspace, annotations: workspace.annotations.filter((value) => value.id !== id), editor: undefined },
      ])
      tab.annotations = tab.annotations.filter((value) => value.id !== id)
      tab.editor = undefined
      tab.editorPosition = undefined
      tab.editorOriginal = undefined
      picker(tab, { annotations: visibleMarkers(tab), reset: true })
      emit({ type: 'annotation-remove', owner: tab.state.owner, id })
      emit({ type: 'editor', owner: tab.state.owner })
      closeOverlays('editor')
      positionOverlays(tab)
      return
    }
    if (action.type === 'exit') {
      await setEnabled(tab, false)
      return
    }
    if (action.type === 'discard') {
      tab.annotations = []
      tab.editor = undefined
      tab.editorPosition = undefined
      tab.editorOriginal = undefined
      picker(tab, { annotations: [], reset: true })
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
        if (tab.editor) await saveEditor(tab)
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
  ipcMain.handle('browser:call', async (event, method: string, args: unknown[]) => {
    trusted(event)
    if (!Array.isArray(args)) throw new Error('浏览器调用参数无效')
    switch (method) {
      case 'agent': {
        const [owner, operation, input] = args as [string, string, unknown[]]
        if (typeof owner !== 'string' || !Array.isArray(input)) throw new Error('网页操作参数无效')
        const workspace = await options.rpc<BrowserWorkspace>('browser:workspace', [owner])
        if (operation === 'list') return workspace.tabs.map((item) => tabs.get(item.id)?.state ?? item)
        if (operation === 'open') {
          if (typeof input[0] !== 'string') throw new Error('网页地址无效')
          const created = await makeTab(owner, randomUUID(), input[0])
          await options.rpc('browser:save-workspace', [owner, { ...workspace, tabs: [...workspace.tabs, created] }])
          emit({ type: 'tab', tab: created })
          return created
        }
        const tab = tabs.get(String(input[0]))
        if (!tab || tab.state.owner !== owner) throw new Error('网页未加载、已关闭或不属于此会话')
        const web = tab.view.webContents
        if (operation === 'close') {
          await options.rpc('browser:save-workspace', [
            owner,
            { ...workspace, tabs: workspace.tabs.filter((item) => item.id !== tab.state.id) },
          ])
          if (visible === tab) {
            visible = undefined
            closeOverlays()
          }
          attachedWindow?.contentView.removeChildView(tab.view)
          web.close()
          tabs.delete(tab.state.id)
          emit({ type: 'tab-closed', owner, id: tab.state.id })
          return { closed: true }
        }
        if (operation === 'navigate') {
          if (typeof input[1] !== 'string') throw new Error('网页地址无效')
          await command(tab, { type: 'navigate', url: input[1] })
          return tab.state
        }
        if (operation === 'screenshot') {
          if (!tab.capture) {
            tab.capture = (async () => {
              if (web.debugger.isAttached()) throw new Error('网页调试器正在使用，请关闭该网页的开发者工具后重试截图')
              web.debugger.attach('1.3')
              let timer: ReturnType<typeof setTimeout> | undefined
              try {
                const capture = async () => {
                  const metrics = await web.debugger.sendCommand('Page.getLayoutMetrics')
                  const viewport = metrics.cssVisualViewport
                  if (!viewport || viewport.clientWidth <= 0 || viewport.clientHeight <= 0)
                    throw new Error('网页尚未完成布局，请加载完成后重试截图')
                  const result = await web.debugger.sendCommand('Page.captureScreenshot', {
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
                  })
                  if (typeof result.data !== 'string' || !result.data.startsWith('iVBORw0KGgo'))
                    throw new Error('网页截图未返回有效 PNG')
                  return result.data as string
                }
                return await Promise.race([
                  capture(),
                  new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new Error('网页截图超时，请检查页面状态')), 20_000)
                  }),
                ])
              } finally {
                clearTimeout(timer)
                if (!web.isDestroyed() && web.debugger.isAttached()) web.debugger.detach()
              }
            })().finally(() => {
              tab.capture = undefined
            })
          }
          return { type: 'image', mimeType: 'image/png', data: await tab.capture }
        }
        const documentId = tab.state.documentId
        if (operation === 'read') {
          const prefix = randomUUID()
          const result = await web.executeJavaScriptInIsolatedWorld(998, [
            {
              code: `(() => {
            const elements = new Map();
            const items = [];
            for (const element of document.querySelectorAll('a,button,input,textarea,select,[role="button"],[contenteditable="true"]')) {
              if (!element.getClientRects().length || getComputedStyle(element).visibility === 'hidden') continue;
              const id = ${JSON.stringify(prefix)} + ':' + items.length;
              elements.set(id, element);
              items.push({ id, tag: element.tagName.toLowerCase(), role: element.getAttribute('role'), name: (element.getAttribute('aria-label') || element.innerText || element.getAttribute('placeholder') || '').slice(0,300), type: element.getAttribute('type'), value: element.type === 'password' ? undefined : element.value });
              if (items.length >= 150) break;
            }
            globalThis.__piWorkbenchElements = elements;
            return { title: document.title, text: document.body?.innerText.slice(0,40000) ?? '', elements: items };
          })()`,
            },
          ])
          if (tab.state.documentId !== documentId) throw new Error('网页已导航，请重新读取')
          return { tab: tab.state, documentId, ...result }
        }
        if (!['click', 'input', 'scroll'].includes(operation) || input[1] !== documentId)
          throw new Error('网页操作或文档版本无效，请重新读取页面')
        if (operation === 'scroll') {
          const delta = input[2]
          if (typeof delta !== 'number' || !Number.isFinite(delta) || Math.abs(delta) > 10000)
            throw new Error('滚动距离无效')
          await web.executeJavaScriptInIsolatedWorld(998, [{ code: `window.scrollBy(0, ${delta})` }])
        } else {
          if (typeof input[2] !== 'string' || (operation === 'input' && typeof input[3] !== 'string'))
            throw new Error('网页元素参数无效')
          await web.executeJavaScriptInIsolatedWorld(998, [
            {
              code: `(() => {
            const element = globalThis.__piWorkbenchElements?.get(${JSON.stringify(input[2])});
            if (!element?.isConnected || !element.getClientRects().length || getComputedStyle(element).visibility === 'hidden' || element.closest('[inert]') || element.disabled) throw new Error('元素已变化，请重新读取');
            if (${JSON.stringify(operation)} === 'click') element.click();
            else {
              const text = ${JSON.stringify(input[3] ?? '')};
              if (element.isContentEditable) element.textContent = text;
              else {
                const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
                const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
                if (!setter) throw new Error('元素不可输入');
                setter.call(element, text);
              }
              element.dispatchEvent(new Event('input', {bubbles:true}));
              element.dispatchEvent(new Event('change', {bubbles:true}));
            }
          })()`,
            },
          ])
        }
        return { tabId: tab.state.id, documentId: tab.state.documentId, applied: true }
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
          tab.view.webContents.close()
          tabs.delete(tab.state.id)
        }
        return
      }
      case 'present': {
        const tab = tabs.get(String(args[0]))
        if (!tab) return null
        const bounds = args[1] as BrowserRect | null
        if (!bounds) {
          const image = visible === tab && args[4] !== false ? await preview(tab) : null
          tab.view.webContents.setBackgroundThrottling(args[4] !== false)
          tab.view.setVisible(false)
          tab.bounds = undefined
          if (visible === tab) {
            closeOverlays()
            visible = undefined
          }
          return image
        }
        if (
          ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) ||
          bounds.width < 1 ||
          bounds.height < 1
        )
          throw new Error('网页视图边界无效')
        if (visible !== tab) {
          if (visible) visible.view.setVisible(false)
          closeOverlays()
          visible = tab
        }
        tab.bounds = {
          x: Math.round(bounds.x),
          y: Math.round(bounds.y),
          width: Math.round(bounds.width),
          height: Math.round(bounds.height),
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
        tab.view.setBounds(tab.bounds)
        tab.view.webContents.setBackgroundThrottling(true)
        tab.view.setVisible(!tab.state.error && tab.state.url !== 'about:blank')
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
        return snapshot
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
