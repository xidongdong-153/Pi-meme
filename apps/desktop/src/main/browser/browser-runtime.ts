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
import { browserUrl, isLocalBrowserUrl } from '@pi-meme/browser/shared/navigation'
import { validAnnotation } from '@pi-meme/browser/shared/annotations'

type Rpc = <T>(method: string, args?: unknown[]) => Promise<T>
type Tab = {
  state: BrowserTab
  view: WebContentsView
  bounds?: BrowserRect
  enabled: boolean
  theme: 'dark' | 'light'
  annotations: BrowserAnnotation[]
  editorVisible: boolean
  editor?: BrowserAnnotation
  screenshot: BrowserSnapshot['settings']['screenshots']
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
  const closeOverlays = (kind?: Overlay['kind']) => {
    for (const item of overlays)
      if (!kind || item.kind === kind) {
        if (attachedWindow && !attachedWindow.isDestroyed()) attachedWindow.contentView.removeChildView(item.view)
        if (!item.view.webContents.isDestroyed()) item.view.webContents.close()
        overlays.delete(item)
      }
  }
  const picker = (tab: Tab, value: object) => {
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.send('browser:picker', value)
  }
  const overlayState = (item: Overlay): BrowserOverlayState => ({
    kind: item.kind,
    tabId: item.tab.state.id,
    owner: item.tab.state.owner,
    annotation: item.tab.editor ? { ...item.tab.editor, image: undefined } : undefined,
    screenshot: item.tab.screenshot,
    count: item.tab.annotations.length,
    theme: item.tab.theme,
  })
  const positionOverlays = (tab: Tab) => {
    const bounds = tab.bounds
    if (!bounds) return
    for (const item of overlays)
      if (item.tab === tab) {
        if (item.kind === 'toolbar') {
          const width = Math.min(450, bounds.width)
          item.view.setBounds({
            x: bounds.x + Math.round((bounds.width - width) / 2),
            y: bounds.y + Math.max(0, bounds.height - 60),
            width,
            height: 60,
          })
        } else {
          const sourceBox = tab.editor?.rect
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
          const width = Math.min(336, bounds.width)
          const height = Math.min(240, bounds.height)
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
    if (!window || visible !== tab || !tab.bounds) return
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
    const item: Overlay = { view, kind, tab }
    overlays.add(item)
    window.contentView.addChildView(view)
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    view.webContents.on('will-navigate', (event) => event.preventDefault())
    positionOverlays(tab)
    await view.webContents.loadURL(`${options.origin()}/?browser-overlay=${kind}`)
    if (!view.webContents.isDestroyed() && visible === tab && kind === 'editor') view.webContents.focus()
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
    picker(tab, { enabled, region, reset: !enabled })
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
        if (value.text) web.findInPage(value.text)
        else web.stopFindInPage('clearSelection')
        break
      case 'annotate':
        await setEnabled(tab, value.enabled, Boolean(value.region))
        break
      case 'markers':
        if (!Array.isArray(value.annotations)) throw new Error('批注标记无效')
        tab.annotations = value.annotations.filter(validAnnotation)
        picker(tab, {
          annotations: tab.annotations.filter(
            (item) => item.tabId === tab.state.id && item.documentId === tab.state.documentId,
          ),
        })
        positionOverlays(tab)
        break
      case 'restore-editor':
        if (!validAnnotation(value.annotation) || value.annotation.tabId !== tab.state.id)
          throw new Error('待恢复批注无效')
        tab.editor = value.annotation
        tab.editorVisible = true
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
      screenshot: config.settings.screenshots,
    }
    tabs.set(id, tab)
    window.contentView.addChildView(view)
    view.setVisible(false)
    const web = view.webContents
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
        tab.state.documentId++
        tab.state.error = undefined
        tab.editorVisible = false
        if (visible === tab) closeOverlays('editor')
      }
    })
    web.on('did-start-loading', sync)
    web.on('did-stop-loading', sync)
    web.on('page-title-updated', sync)
    web.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
      if (!isMainFrame) return
      tab.state.documentId++
      tab.editorVisible = false
      if (visible === tab) closeOverlays('editor')
      sync()
      picker(tab, { enabled: tab.enabled, documentId: tab.state.documentId, annotations: [], reset: true })
    })
    web.on('dom-ready', () => {
      picker(tab, {
        enabled: tab.enabled,
        documentId: tab.state.documentId,
        annotations: tab.annotations.filter(
          (item) => item.tabId === tab.state.id && item.documentId === tab.state.documentId,
        ),
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
    tab.editorVisible = true
    void capture(tab, tab.screenshot, annotation)
      .then((saved) => {
        if (tab.editor?.id !== annotation.id || tab.state.documentId !== annotation.documentId) return
        tab.editor = saved
        emit({ type: 'editor', owner: tab.state.owner, annotation: saved })
        return showOverlay(tab, 'editor')
      })
      .catch((cause) => {
        tab.editor = annotation
        emit({ type: 'editor', owner: tab.state.owner, annotation })
        void showOverlay(tab, 'editor').catch(console.error)
        console.error(String(cause))
      })
  })
  ipcMain.on('browser:selection-position', (event, box: BrowserRect) => {
    const tab = guestHandler(event)
    if (tab?.editor && box && [box.x, box.y, box.width, box.height].every(Number.isFinite)) {
      tab.editor.rect = box
      positionOverlays(tab)
    }
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
      picker(tab, { hidden: action.hidden })
      return
    }
    if (action.type === 'original') {
      picker(tab, { original: action.pressed })
      return
    }
    if (action.type === 'cancel') {
      tab.editorVisible = false
      closeOverlays('editor')
      return
    }
    if (action.type === 'exit') {
      await setEnabled(tab, false)
      return
    }
    if (action.type === 'discard') {
      tab.annotations = []
      tab.editor = undefined
      picker(tab, { annotations: [], reset: true })
      emit({ type: 'editor', owner: tab.state.owner })
      emit({ type: 'discard', owner: tab.state.owner })
      closeOverlays('editor')
      positionOverlays(tab)
      return
    }
    if (action.type === 'submit') {
      emit({ type: 'submit', owner: tab.state.owner })
      return
    }
    if (action.type === 'screenshot') {
      await command(tab, { type: 'screenshot' })
      return
    }
    if (action.type === 'add') {
      if (overlayBusy || !tab.editor) throw new Error('正在处理批注，请稍后重试')
      overlayBusy = true
      const selected = tab.editor
      try {
        const annotation =
          selected.documentId === tab.state.documentId
            ? await capture(tab, tab.screenshot, structuredClone(selected))
            : tab.screenshot === 'none'
              ? { ...selected, image: undefined }
              : selected.image
                ? structuredClone(selected)
                : undefined
        if (!annotation) throw new Error('旧页面没有保存截图，请关闭截图后加入，或重新选择元素')
        const workspace = await options.rpc<BrowserWorkspace>('browser:workspace', [tab.state.owner])
        await options.rpc('browser:save-workspace', [
          tab.state.owner,
          {
            ...workspace,
            annotations: [...workspace.annotations.filter((value) => value.id !== annotation.id), annotation],
            editor: undefined,
          },
        ])
        tab.annotations = [...tab.annotations.filter((value) => value.id !== annotation.id), annotation]
        tab.editor = undefined
        picker(tab, { annotations: tab.annotations, reset: true })
        emit({ type: 'annotation', owner: tab.state.owner, annotation })
        emit({ type: 'editor', owner: tab.state.owner })
        closeOverlays('editor')
        positionOverlays(tab)
      } finally {
        overlayBusy = false
      }
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
          const preview =
            visible === tab && !tab.state.error && tab.state.url !== 'about:blank'
              ? await tab.view.webContents
                  .capturePage()
                  .then((image) => image.resize({ width: Math.min(1200, image.getSize().width) }).toDataURL())
                  .catch(() => null)
              : null
          tab.view.setVisible(false)
          tab.bounds = undefined
          if (visible === tab) {
            closeOverlays()
            visible = undefined
          }
          return preview
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
        tab.view.setBounds(tab.bounds)
        tab.view.setVisible(!tab.state.error && tab.state.url !== 'about:blank')
        if (tab.enabled) {
          await showOverlay(tab, 'toolbar')
          if (tab.editor && tab.editorVisible) await showOverlay(tab, 'editor')
        }
        positionOverlays(tab)
        return null
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
