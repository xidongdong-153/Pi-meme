import type { WebContents, WebContentsView } from 'electron'
import type { BrowserAgentElement, BrowserAgentFrameSummary, BrowserDialogInfo } from '@pi-meme/contracts/browser-agent'
import { systemMetadataUrl } from '@pi-meme/contracts/system-client-reads'
import { SystemReadError } from '@pi-meme/contracts/system-read'

export type BrowserConsoleEntry = {
  id: string
  level: 'log' | 'info' | 'warn' | 'error' | 'debug'
  text: string
  timestamp: string
}

export type BrowserNetworkEntry = {
  id: string
  url: string
  method: string
  resourceType: string
  status?: number
  failed: boolean
  errorText?: string
  durationMs: number
  timestamp: string
}

export type CrossOriginElementRef = {
  id: string
  frameId: string
  backendDOMNodeId: number
  role: string | null
  name: string
}

export type CdpSend = (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>

const maxBufferEntries = 200
const idleDetachMs = 60_000

const namedKeyMap: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ' ': { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
}

for (let index = 1; index <= 12; index++) {
  namedKeyMap[`f${index}`] = { key: `F${index}`, code: `F${index}`, keyCode: 111 + index }
}

function parseModifierBit(token: string): number {
  const lower = token.trim().toLowerCase()
  if (lower === 'alt' || lower === 'option') return 1
  if (lower === 'control' || lower === 'ctrl') return 2
  if (lower === 'meta' || lower === 'cmd' || lower === 'command' || lower === 'super') return 4
  if (lower === 'controlormeta') return process.platform === 'darwin' ? 4 : 2
  if (lower === 'shift') return 8
  return 0
}

export function parseModifiers(modifiers?: string[]): number {
  if (!modifiers?.length) return 0
  let mask = 0
  for (const token of modifiers) {
    const bit = parseModifierBit(token)
    if (!bit) throw new SystemReadError('invalid-input', `不支持的修饰键：${token}`)
    mask |= bit
  }
  return mask
}

const punctuationKeyMap: Record<string, { code: string; keyCode: number }> = {
  '-': { code: 'Minus', keyCode: 189 },
  '=': { code: 'Equal', keyCode: 187 },
  '[': { code: 'BracketLeft', keyCode: 219 },
  ']': { code: 'BracketRight', keyCode: 221 },
  '\\': { code: 'Backslash', keyCode: 220 },
  ';': { code: 'Semicolon', keyCode: 186 },
  "'": { code: 'Quote', keyCode: 222 },
  ',': { code: 'Comma', keyCode: 188 },
  '.': { code: 'Period', keyCode: 190 },
  '/': { code: 'Slash', keyCode: 191 },
  '`': { code: 'Backquote', keyCode: 192 },
  '+': { code: 'Equal', keyCode: 187 },
}

function parseKeyChord(chord: string) {
  const trimmed = chord.trim()
  if (!trimmed) throw new SystemReadError('invalid-input', '按键名称不能为空')
  const parts =
    trimmed === '+'
      ? ['+']
      : trimmed.endsWith('++')
        ? [...trimmed.slice(0, -2).split('+').filter(Boolean), '+']
        : trimmed.split('+').filter(Boolean)
  if (!parts.length) throw new SystemReadError('invalid-input', '按键名称无效')
  let modifiers = 0
  for (let index = 0; index < parts.length - 1; index++) {
    const bit = parseModifierBit(parts[index])
    if (!bit) throw new SystemReadError('invalid-input', `不支持的组合修饰键：${parts[index]}`)
    modifiers |= bit
  }
  const rawKey = parts[parts.length - 1]
  const named = namedKeyMap[rawKey.toLowerCase()]
  if (named) return { ...named, modifiers }
  if (rawKey.length === 1) {
    const upper = rawKey.toUpperCase()
    const punct = punctuationKeyMap[rawKey]
    const code = punct
      ? punct.code
      : upper >= 'A' && upper <= 'Z'
        ? `Key${upper}`
        : upper >= '0' && upper <= '9'
          ? `Digit${upper}`
          : rawKey
    const keyCode = punct ? punct.keyCode : upper.charCodeAt(0)
    const hasShortcutMod = (modifiers & (1 | 2 | 4)) !== 0
    return {
      key: rawKey,
      code,
      keyCode,
      modifiers,
      text: hasShortcutMod ? undefined : rawKey,
    }
  }
  throw new SystemReadError('invalid-input', `不支持的按键：${chord}`)
}

const interactiveAxRoles = new Set([
  'button',
  'checkbox',
  'combobox',
  'gridcell',
  'link',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'scrollbar',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
  'treeitem',
])

export class BrowserCdpController {
  private attached = false
  private ownDetach = false
  private domainsEnabled = false
  private queue: Promise<unknown> = Promise.resolve()
  private idleTimer?: ReturnType<typeof setTimeout>
  private pendingDialog?: BrowserDialogInfo
  private consoleLogs: BrowserConsoleEntry[] = []
  private networkLogs: BrowserNetworkEntry[] = []
  private inflight = new Map<
    string,
    { url: string; method: string; resourceType: string; startedAt: number; status?: number }
  >()
  private lastNetworkQuietAt = Date.now()
  private logSeq = 0
  private crossOriginRefs = new Map<string, CrossOriginElementRef>()
  private fileChooserEnabled = false

  private readonly onMessage = (_event: Electron.Event, method: string, params: Record<string, unknown>) => {
    if (method === 'Page.javascriptDialogOpening') {
      const dialogType = String(params.type ?? 'alert')
      this.pendingDialog = {
        type: (['alert', 'confirm', 'prompt', 'beforeunload'].includes(dialogType)
          ? dialogType
          : 'alert') as BrowserDialogInfo['type'],
        message: String(params.message ?? '').slice(0, 4000),
        ...(params.defaultPrompt !== undefined ? { defaultPrompt: String(params.defaultPrompt).slice(0, 2000) } : {}),
        ...(params.url ? { url: systemMetadataUrl(String(params.url)) } : {}),
      }
      return
    }
    if (method === 'Page.javascriptDialogClosed') {
      this.pendingDialog = undefined
      return
    }
    if (method === 'Runtime.consoleAPICalled') {
      const rawType = String(params.type ?? 'log')
      const level: BrowserConsoleEntry['level'] =
        rawType === 'warning'
          ? 'warn'
          : ((['log', 'info', 'warn', 'error', 'debug'].includes(rawType)
              ? rawType
              : 'log') as BrowserConsoleEntry['level'])
      const args = Array.isArray(params.args) ? (params.args as Array<Record<string, unknown>>) : []
      const text = args
        .map((arg) => {
          if (arg.value !== undefined) return typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value)
          if (typeof arg.description === 'string') return arg.description
          return String(arg.type ?? '')
        })
        .join(' ')
        .slice(0, 2000)
      this.pushConsole({
        id: `c-${++this.logSeq}`,
        level,
        text,
        timestamp: new Date().toISOString(),
      })
      return
    }
    if (method === 'Runtime.exceptionThrown') {
      const details = params.exceptionDetails as Record<string, unknown> | undefined
      const exception = details?.exception as Record<string, unknown> | undefined
      const text = String(exception?.description ?? details?.text ?? 'Uncaught exception').slice(0, 2000)
      this.pushConsole({
        id: `c-${++this.logSeq}`,
        level: 'error',
        text,
        timestamp: new Date().toISOString(),
      })
      return
    }
    if (method === 'Network.requestWillBeSent') {
      const requestId = String(params.requestId ?? '')
      const request = params.request as Record<string, unknown> | undefined
      const rawUrl = String(request?.url ?? '')
      const safeUrl = rawUrl.startsWith('data:') ? 'data:...' : systemMetadataUrl(rawUrl)
      if (!requestId || !safeUrl) return
      this.inflight.set(requestId, {
        url: safeUrl,
        method: String(request?.method ?? 'GET').slice(0, 16),
        resourceType: String(params.type ?? 'Other').slice(0, 64),
        startedAt: Date.now(),
      })
      return
    }
    if (method === 'Network.responseReceived') {
      const requestId = String(params.requestId ?? '')
      const entry = this.inflight.get(requestId)
      const response = params.response as Record<string, unknown> | undefined
      if (entry && typeof response?.status === 'number') entry.status = response.status
      return
    }
    if (method === 'Network.loadingFinished') {
      const requestId = String(params.requestId ?? '')
      const entry = this.inflight.get(requestId)
      if (!entry) return
      this.inflight.delete(requestId)
      if (this.inflight.size === 0) this.lastNetworkQuietAt = Date.now()
      this.pushNetwork({
        id: requestId,
        url: entry.url,
        method: entry.method,
        resourceType: entry.resourceType,
        status: entry.status ?? 200,
        failed: (entry.status ?? 200) >= 400,
        durationMs: Math.max(0, Date.now() - entry.startedAt),
        timestamp: new Date().toISOString(),
      })
      return
    }
    if (method === 'Network.loadingFailed') {
      const requestId = String(params.requestId ?? '')
      const entry = this.inflight.get(requestId)
      if (!entry) return
      this.inflight.delete(requestId)
      if (this.inflight.size === 0) this.lastNetworkQuietAt = Date.now()
      this.pushNetwork({
        id: requestId,
        url: entry.url,
        method: entry.method,
        resourceType: entry.resourceType,
        status: entry.status,
        failed: true,
        errorText: String(params.errorText ?? (params.canceled ? 'canceled' : 'failed')).slice(0, 256),
        durationMs: Math.max(0, Date.now() - entry.startedAt),
        timestamp: new Date().toISOString(),
      })
    }
  }

  private getWeb(): WebContents | undefined {
    try {
      const web = this.view.webContents as WebContents | undefined
      return web && !web.isDestroyed() ? web : undefined
    } catch {
      return undefined
    }
  }

  private readonly onDetach = () => {
    const web = this.getWeb()
    if (web) {
      web.debugger.removeListener('message', this.onMessage)
      web.debugger.removeListener('detach', this.onDetach)
    }
    this.attached = false
    this.domainsEnabled = false
    this.fileChooserEnabled = false
    this.inflight.clear()
    this.lastNetworkQuietAt = Date.now()
    if (!this.ownDetach) this.pendingDialog = undefined
    this.ownDetach = false
  }

  constructor(private readonly view: WebContentsView) {
    view.webContents.once('destroyed', () => this.dispose())
  }

  private pushConsole(entry: BrowserConsoleEntry) {
    this.consoleLogs.push(entry)
    if (this.consoleLogs.length > maxBufferEntries) this.consoleLogs.shift()
  }

  private pushNetwork(entry: BrowserNetworkEntry) {
    this.networkLogs.push(entry)
    if (this.networkLogs.length > maxBufferEntries) this.networkLogs.shift()
  }

  getPendingDialog(): BrowserDialogInfo | undefined {
    return this.pendingDialog ? { ...this.pendingDialog } : undefined
  }

  getConsoleLogs(): BrowserConsoleEntry[] {
    return [...this.consoleLogs]
  }

  getNetworkLogs(): BrowserNetworkEntry[] {
    return [...this.networkLogs]
  }

  getCrossOriginRef(id: string): CrossOriginElementRef | undefined {
    return this.crossOriginRefs.get(id)
  }

  isNetworkIdle(idleMs: number): boolean {
    if (!this.attached) return false
    return this.inflight.size === 0 && Date.now() - this.lastNetworkQuietAt >= idleMs
  }

  resetNavigationState() {
    this.crossOriginRefs.clear()
    this.pendingDialog = undefined
    this.inflight.clear()
    this.lastNetworkQuietAt = Date.now()
  }

  private scheduleIdleDetach() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      if (!this.attached || this.pendingDialog || this.fileChooserEnabled) return
      this.detach()
    }, idleDetachMs)
  }

  private detach() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = undefined
    }
    const web = this.getWeb()
    if (web) {
      web.debugger.removeListener('message', this.onMessage)
      web.debugger.removeListener('detach', this.onDetach)
      if (this.attached && web.debugger.isAttached()) {
        this.ownDetach = true
        try {
          web.debugger.detach()
        } catch {
          this.ownDetach = false
        }
      }
    }
    this.attached = false
    this.domainsEnabled = false
    this.fileChooserEnabled = false
  }

  dispose() {
    this.detach()
    this.consoleLogs = []
    this.networkLogs = []
    this.crossOriginRefs.clear()
    this.inflight.clear()
    this.pendingDialog = undefined
  }

  private async ensureAttached() {
    const web = this.getWeb()
    if (!web) throw new SystemReadError('not-found', '网页已关闭')
    if (this.attached && web.debugger.isAttached()) return
    if (!this.attached && web.debugger.isAttached()) {
      throw new SystemReadError('disabled', '网页调试器正被开发者工具使用，请关闭开发者工具后重试', {
        reason: 'debugger-busy',
      })
    }
    try {
      web.debugger.attach('1.3')
    } catch {
      throw new SystemReadError('disabled', '网页调试器无法连接，请关闭开发者工具后重试', {
        reason: 'debugger-busy',
      })
    }
    this.attached = true
    web.debugger.on('message', this.onMessage)
    web.debugger.on('detach', this.onDetach)
    if (!this.domainsEnabled) {
      this.domainsEnabled = true
      await Promise.all([
        web.debugger.sendCommand('Page.enable'),
        web.debugger.sendCommand('Runtime.enable'),
        web.debugger.sendCommand('Network.enable'),
      ]).catch(() => {
        this.domainsEnabled = false
      })
    }
  }

  async withSession<T>(deadline: number, run: (send: CdpSend) => Promise<T>): Promise<T> {
    const task = this.queue.then(async () => {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new SystemReadError('timeout', '网页操作已过期')
      if (this.idleTimer) {
        clearTimeout(this.idleTimer)
        this.idleTimer = undefined
      }
      await this.ensureAttached()
      let timer: ReturnType<typeof setTimeout> | undefined
      const send: CdpSend = async (method, params) => {
        if (Date.now() >= deadline) throw new SystemReadError('timeout', '网页操作已过期')
        const web = this.getWeb()
        if (!this.attached || !web || !web.debugger.isAttached())
          throw new SystemReadError('disconnected', '网页调试连接已断开')
        return (await web.debugger.sendCommand(method, params)) as Record<string, unknown>
      }
      try {
        return await Promise.race([
          run(send),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new SystemReadError('timeout', '网页调试操作超时')), remaining)
          }),
        ])
      } finally {
        clearTimeout(timer)
        this.scheduleIdleDetach()
      }
    })
    this.queue = task.catch(() => {})
    return task
  }

  async ensureObserving(deadline: number) {
    await this.withSession(deadline, async () => undefined)
  }

  async withEmulatedFocus<T>(deadline: number, run: (send: CdpSend) => Promise<T>): Promise<T> {
    return this.withSession(deadline, async (send) => {
      const web = this.getWeb()
      const emulate = !web || !this.view.getVisible() || !web.isFocused()
      if (emulate) await send('Emulation.setFocusEmulationEnabled', { enabled: true })
      try {
        return await run(send)
      } finally {
        if (emulate) {
          await send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {})
        }
      }
    })
  }

  async dispatchClick(
    deadline: number,
    x: number,
    y: number,
    options?: { button?: 'left' | 'middle' | 'right'; clickCount?: number; modifiers?: string[] },
  ) {
    const button = options?.button ?? 'left'
    const clickCount = options?.clickCount ?? 1
    const modifiers = parseModifiers(options?.modifiers)
    await this.withEmulatedFocus(deadline, async (send) => {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers })
      for (let count = 1; count <= clickCount; count++) {
        await send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x,
          y,
          button,
          clickCount: count,
          modifiers,
        })
        await send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x,
          y,
          button,
          clickCount: count,
          modifiers,
        })
      }
    })
  }

  async dispatchHover(deadline: number, x: number, y: number) {
    await this.withEmulatedFocus(deadline, async (send) => {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    })
  }

  async dispatchDrag(deadline: number, fromX: number, fromY: number, toX: number, toY: number) {
    await this.withEmulatedFocus(deadline, async (send) => {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fromX, y: fromY })
      await send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: fromX,
        y: fromY,
        button: 'left',
        clickCount: 1,
      })
      const steps = 8
      for (let step = 1; step <= steps; step++) {
        const ratio = step / steps
        await send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: fromX + (toX - fromX) * ratio,
          y: fromY + (toY - fromY) * ratio,
          button: 'left',
        })
      }
      await send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: toX,
        y: toY,
        button: 'left',
        clickCount: 1,
      })
    })
  }

  async dispatchWheel(deadline: number, x: number, y: number, deltaX: number, deltaY: number) {
    await this.withSession(deadline, async (send) => {
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY })
    })
  }

  async dispatchKeyChord(deadline: number, chord: string, beforeKey?: (send: CdpSend) => Promise<void>) {
    const parsed = parseKeyChord(chord)
    await this.withEmulatedFocus(deadline, async (send) => {
      if (beforeKey) await beforeKey(send)
      const base = {
        key: parsed.key,
        code: parsed.code,
        modifiers: parsed.modifiers,
        windowsVirtualKeyCode: parsed.keyCode,
      }
      const down =
        parsed.text !== undefined
          ? { type: 'keyDown', text: parsed.text, unmodifiedText: parsed.text }
          : { type: 'rawKeyDown' }
      await send('Input.dispatchKeyEvent', { ...base, ...down })
      await send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' })
    })
  }

  async clickWithSend(send: CdpSend, x: number, y: number) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers: 0 })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, modifiers: 0 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, modifiers: 0 })
  }

  async focusBackendNodeWithSend(send: CdpSend, backendDOMNodeId: number) {
    await send('DOM.enable')
    await send('DOM.focus', { backendNodeId: backendDOMNodeId })
  }

  async insertText(deadline: number, text: string, mode: 'replace' | 'append' | 'type' = 'replace') {
    await this.withEmulatedFocus(deadline, async (send) => {
      if (text === '') {
        if (mode === 'replace') {
          await send('Input.dispatchKeyEvent', {
            type: 'rawKeyDown',
            key: 'Backspace',
            code: 'Backspace',
            windowsVirtualKeyCode: 8,
          })
          await send('Input.dispatchKeyEvent', {
            type: 'keyUp',
            key: 'Backspace',
            code: 'Backspace',
            windowsVirtualKeyCode: 8,
          })
        }
        return
      }
      if (mode === 'type') {
        for (const char of text) {
          await send('Input.insertText', { text: char })
        }
        return
      }
      await send('Input.insertText', { text })
    })
  }

  async handleDialog(deadline: number, accept: boolean, promptText?: string) {
    const current = this.pendingDialog
    if (!current) throw new SystemReadError('not-found', '当前网页没有挂起的原生弹窗')
    await this.withSession(deadline, async (send) => {
      await send('Page.handleJavaScriptDialog', {
        accept,
        ...(promptText !== undefined ? { promptText } : {}),
      })
      this.pendingDialog = undefined
    })
    return current
  }

  async setFilesOnMarker(deadline: number, marker: string, files: string[]) {
    return this.withSession(deadline, async (send) => {
      await send('DOM.enable')
      const expr = `((m) => {
        const find = (root) => {
          const hit = root.querySelector('[data-pi-file-target="' + CSS.escape(m) + '"]');
          if (hit) return hit;
          const doc = root instanceof Document ? root : root.ownerDocument || document;
          const w = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
          let cur = w.nextNode();
          while (cur) {
            if (cur.shadowRoot) { const r = find(cur.shadowRoot); if (r) return r; }
            if (cur.localName === 'iframe') { try { if (cur.contentDocument) { const r = find(cur.contentDocument); if (r) return r; } } catch {} }
            cur = w.nextNode();
          }
          return null;
        };
        return find(document);
      })(${JSON.stringify(marker)})`
      const evaluated = (await send('Runtime.evaluate', { expression: expr, returnByValue: false })) as {
        result?: { objectId?: string }
      }
      const objectId = evaluated.result?.objectId
      if (!objectId) return false
      try {
        await send('DOM.setFileInputFiles', { objectId, files })
        return true
      } finally {
        await send('Runtime.releaseObject', { objectId }).catch(() => {})
      }
    })
  }

  async withInterceptedFileChooser(deadline: number, files: string[], trigger: () => Promise<void>) {
    await this.withSession(deadline, async (send) => {
      const web = this.getWeb()
      if (!web) throw new SystemReadError('not-found', '网页已关闭')
      this.fileChooserEnabled = true
      await send('Page.setInterceptFileChooserDialog', { enabled: true })
      let resolveChooser!: (backendNodeId: number) => void
      const chooserPromise = new Promise<number>((resolve) => {
        resolveChooser = resolve
      })
      const listener = (_event: Electron.Event, method: string, params: Record<string, unknown>) => {
        if (method === 'Page.fileChooserOpened' && typeof params.backendNodeId === 'number') {
          resolveChooser(params.backendNodeId)
        }
      }
      web.debugger.on('message', listener)
      try {
        await trigger()
        const backendNodeId = await Promise.race([
          chooserPromise,
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new SystemReadError('not-found', '点击目标后未触发文件选择器')),
              Math.min(3000, Math.max(500, deadline - Date.now())),
            ),
          ),
        ])
        await send('DOM.setFileInputFiles', { backendNodeId, files })
      } finally {
        this.getWeb()?.debugger.removeListener('message', listener)
        this.fileChooserEnabled = false
        await send('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {})
      }
    })
  }

  async listFrames(deadline: number, mainOrigin: string): Promise<BrowserAgentFrameSummary[]> {
    return this.withSession(deadline, async (send) => {
      const { frameTree } = (await send('Page.getFrameTree')) as {
        frameTree?: {
          frame: { id: string; url: string; name?: string }
          childFrames?: Array<{ frame: { id: string; url: string; name?: string }; childFrames?: unknown[] }>
        }
      }
      const frames: BrowserAgentFrameSummary[] = []
      const walk = (node?: { frame: { id: string; url: string; name?: string }; childFrames?: unknown[] }) => {
        if (!node) return
        const url = systemMetadataUrl(node.frame.url)
        let sameOrigin = false
        try {
          sameOrigin = Boolean(mainOrigin) && new URL(node.frame.url).origin === mainOrigin
        } catch {
          sameOrigin = false
        }
        frames.push({
          id: node.frame.id,
          url: url || node.frame.url.slice(0, 64),
          ...(node.frame.name ? { title: node.frame.name.slice(0, 128) } : {}),
          sameOrigin,
        })
        if (Array.isArray(node.childFrames)) {
          for (const child of node.childFrames) {
            walk(child as typeof node)
          }
        }
      }
      if (frameTree?.childFrames) {
        for (const child of frameTree.childFrames) walk(child)
      }
      return frames
    })
  }

  async readCrossOriginFrame(deadline: number, frameId: string): Promise<BrowserAgentElement[]> {
    return this.withSession(deadline, async (send) => {
      await send('DOM.enable')
      await send('Accessibility.enable')
      let frameOffsetX = 0
      let frameOffsetY = 0
      try {
        const owner = (await send('DOM.getFrameOwner', { frameId })) as { backendNodeId?: number }
        if (owner.backendNodeId) {
          const { model } = (await send('DOM.getBoxModel', { backendNodeId: owner.backendNodeId })) as {
            model?: { content?: number[] }
          }
          if (model?.content && model.content.length >= 2) {
            frameOffsetX = model.content[0]
            frameOffsetY = model.content[1]
          }
        }
      } catch {
        // Cross-origin frame owner box may be unavailable; continue with local coordinates.
      }
      const { nodes } = (await send('Accessibility.getFullAXTree', { frameId })) as {
        nodes?: Array<{
          ignored?: boolean
          role?: { value?: string }
          name?: { value?: string }
          value?: { value?: unknown }
          properties?: Array<{ name: string; value?: { value?: unknown } }>
          backendDOMNodeId?: number
        }>
      }
      const elements: BrowserAgentElement[] = []
      for (const node of nodes ?? []) {
        if (node.ignored || !node.backendDOMNodeId) continue
        const role = node.role?.value?.toLowerCase() ?? null
        if (!role || !interactiveAxRoles.has(role)) continue
        const name = String(node.name?.value ?? '')
          .trim()
          .slice(0, 300)
        const id = `ax:${frameId}:${node.backendDOMNodeId}`
        let rect: BrowserAgentElement['rect']
        try {
          const { model } = (await send('DOM.getBoxModel', { backendNodeId: node.backendDOMNodeId })) as {
            model?: { border?: number[] }
          }
          const b = model?.border
          if (b && b.length >= 6) {
            const width = Math.round(b[2] - b[0])
            const height = Math.round(b[5] - b[1])
            if (width <= 0 || height <= 0) continue
            rect = {
              x: Math.round(frameOffsetX + b[0]),
              y: Math.round(frameOffsetY + b[1]),
              width,
              height,
            }
          }
        } catch {
          continue
        }
        const propMap = new Map((node.properties ?? []).map((p) => [p.name, p.value?.value]))
        const disabled = propMap.get('disabled') === true
        const readOnly = propMap.get('readonly') === true
        const checkedRaw = propMap.get('checked')
        const checked = checkedRaw === 'mixed' ? 'mixed' : typeof checkedRaw === 'boolean' ? checkedRaw : undefined
        this.crossOriginRefs.set(id, { id, frameId, backendDOMNodeId: node.backendDOMNodeId, role, name })
        elements.push({
          id,
          tag: role,
          role,
          name,
          type: null,
          ...(typeof node.value?.value === 'string' ? { value: node.value.value.slice(0, 1024) } : {}),
          ...(rect ? { rect, inViewport: true } : {}),
          frameId,
          disabled,
          readOnly,
          ...(checked !== undefined ? { checked } : {}),
        })
        if (elements.length >= 150) break
      }
      return elements
    })
  }

  async resolveCrossOriginBox(deadline: number, id: string) {
    const ref = this.crossOriginRefs.get(id)
    if (!ref) return undefined
    return this.withSession(deadline, async (send) => {
      await send('DOM.enable')
      let frameOffsetX = 0
      let frameOffsetY = 0
      try {
        const owner = (await send('DOM.getFrameOwner', { frameId: ref.frameId })) as { backendNodeId?: number }
        if (owner.backendNodeId) {
          const { model } = (await send('DOM.getBoxModel', { backendNodeId: owner.backendNodeId })) as {
            model?: { content?: number[] }
          }
          if (model?.content && model.content.length >= 2) {
            frameOffsetX = model.content[0]
            frameOffsetY = model.content[1]
          }
        }
      } catch {
        // Ignore if frame owner lookup fails.
      }
      const { model } = (await send('DOM.getBoxModel', { backendNodeId: ref.backendDOMNodeId })) as {
        model?: { border?: number[] }
      }
      const b = model?.border
      if (!b || b.length < 6) throw new SystemReadError('stale-cursor', '跨域帧控件已不可见，请重新读取')
      const x = frameOffsetX + (b[0] + b[2]) / 2
      const y = frameOffsetY + (b[1] + b[5]) / 2
      return { x, y, backendDOMNodeId: ref.backendDOMNodeId }
    })
  }

  async focusBackendNode(deadline: number, backendDOMNodeId: number) {
    await this.withSession(deadline, async (send) => {
      await send('DOM.enable')
      await send('DOM.focus', { backendNodeId: backendDOMNodeId })
    })
  }

  async evaluateInMainWorld(deadline: number, expression: string, arg?: unknown) {
    const timeout = Math.min(5_000, Math.max(500, deadline - Date.now()))
    return this.withSession(deadline, async (send) => {
      const serializedArg = arg === undefined ? 'undefined' : JSON.stringify(arg)
      const wrapped = `((arg) => { const value = (${expression}\n); return typeof value === 'function' ? value(arg) : value; })(${serializedArg})`
      const response = (await send('Runtime.evaluate', {
        expression: wrapped,
        awaitPromise: true,
        returnByValue: true,
        timeout,
      })) as {
        result?: { value?: unknown; type?: string; subtype?: string; description?: string }
        exceptionDetails?: { text?: string; exception?: { description?: string } }
      }
      if (response.exceptionDetails) {
        const msg = String(
          response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? '脚本执行异常',
        )
          .split('\n')[0]
          .slice(0, 300)
        throw new SystemReadError('invalid-input', `页面脚本执行失败：${msg}`)
      }
      const value = response.result?.value ?? null
      let json: string
      try {
        json = JSON.stringify(value) ?? 'null'
      } catch {
        throw new SystemReadError('invalid-input', '页面脚本返回值必须可序列化为 JSON')
      }
      if (Buffer.byteLength(json, 'utf8') > 32 * 1024)
        throw new SystemReadError('invalid-input', '页面脚本返回值超过 32 KiB 上限，请缩小提取范围')
      return value
    })
  }
}
