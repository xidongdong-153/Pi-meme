import { randomUUID } from 'node:crypto'
import type {
  ExtensionUIContext,
  ExtensionUIDialogOptions,
  RpcExtensionUIRequest,
  Theme,
} from '@earendil-works/pi-coding-agent'
import type { PiExtensionEvent, PiExtensionUIResponse } from '@pi-meme/contracts/pi'
import { ExtensionDialogs } from '../extension-dialogs'

/** 桌面端不渲染终端样式：返回纯文本，避免扩展往正文里塞 ANSI 转义序列。 */
const plainTheme = {
  style: (text: string) => text,
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  inverse: (text: string) => text,
  strikethrough: (text: string) => text,
  getFgAnsi: () => '',
  getBgAnsi: () => '',
  getColorMode: () => 'ansi',
  getThinkingBorderColor: () => (text: string) => text,
  getBashModeBorderColor: () => (text: string) => text,
  appearance: 'dark',
  colors: {},
} as unknown as Theme

/**
 * 会话级扩展 UI 桥，等价于 pi 的 RPC 模式实现：
 * 弹窗方法挂起等待宿主响应，其余方法只发事件。
 */
export class ExtensionUiBridge {
  private readonly dialogs = new ExtensionDialogs((id) => this.timeout(id))
  /** 挂起的弹窗：id 到"用宿主响应完成 Promise"的回调。 */
  private readonly pending = new Map<string, (response: PiExtensionUIResponse) => void>()

  constructor(private readonly emit: (event: PiExtensionEvent) => void) {}

  private dialog<T>(
    method: 'select' | 'confirm' | 'input' | 'editor',
    request: Record<string, unknown>,
    fallback: T,
    parse: (response: PiExtensionUIResponse) => T,
    options?: ExtensionUIDialogOptions,
  ): Promise<T> {
    if (options?.signal?.aborted) return Promise.resolve(fallback)
    const id = randomUUID()
    const signal = options?.signal
    return new Promise<T>((resolve) => {
      const finish = (value: T) => {
        this.pending.delete(id)
        this.dialogs.remove(id)
        resolve(value)
      }
      const onAbort = () => {
        if (!this.pending.has(id)) return
        finish(fallback)
        this.emit({ type: 'extension_ui_closed', id, reason: 'cancelled' })
      }
      this.pending.set(id, (response) => {
        signal?.removeEventListener('abort', onAbort)
        finish(parse(response))
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      const message = {
        type: 'extension_ui_request',
        id,
        method,
        ...request,
        timeout: options?.timeout,
      } as RpcExtensionUIRequest
      this.dialogs.add(message)
      this.emit(message)
    })
  }

  /** 宿主对弹窗的响应；无效或已结束时抛错。 */
  respond(id: string, response: PiExtensionUIResponse) {
    const message = this.dialogs.response(id, response)
    const finish = this.pending.get(id)
    if (!finish) throw new Error('扩展交互已取消或超时')
    this.pending.delete(id)
    this.dialogs.remove(id)
    finish(message)
  }

  private timeout(id: string) {
    const finish = this.pending.get(id)
    this.pending.delete(id)
    this.emit({ type: 'extension_ui_timeout', id })
    finish?.({ cancelled: true })
  }

  /** 会话结束时清理所有挂起弹窗。 */
  clear() {
    const pending = [...this.pending.keys()]
    this.dialogs.clear()
    for (const id of pending) this.pending.get(id)?.({ cancelled: true })
    this.pending.clear()
  }

  private dialogValue(fallback: string | undefined) {
    return (response: PiExtensionUIResponse) =>
      'cancelled' in response && response.cancelled ? fallback : 'value' in response ? response.value : fallback
  }

  private setEditorText = (text: string) => {
    this.emit({ type: 'extension_ui_request', id: randomUUID(), method: 'set_editor_text', text })
  }

  readonly ui: ExtensionUIContext = {
    select: (title, options, opts) =>
      this.dialog('select', { title, options }, undefined, this.dialogValue(undefined), opts),
    confirm: (title, message, opts) =>
      this.dialog(
        'confirm',
        { title, message },
        false,
        (response) =>
          'cancelled' in response && response.cancelled ? false : 'confirmed' in response ? response.confirmed : false,
        opts,
      ),
    input: (title, placeholder, opts) =>
      this.dialog('input', { title, placeholder }, undefined, this.dialogValue(undefined), opts),
    notify: (message, type) => {
      this.emit({ type: 'extension_ui_request', id: randomUUID(), method: 'notify', message, notifyType: type })
    },
    onTerminalInput: () => () => {},
    setStatus: (key, text) => {
      this.emit({
        type: 'extension_ui_request',
        id: randomUUID(),
        method: 'setStatus',
        statusKey: key,
        statusText: text,
      })
    },
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: (key, content, options) => {
      if (content !== undefined && !Array.isArray(content)) return
      this.emit({
        type: 'extension_ui_request',
        id: randomUUID(),
        method: 'setWidget',
        widgetKey: key,
        widgetLines: content,
        widgetPlacement: options?.placement,
      })
    },
    setFooter: () => {},
    setHeader: () => {},
    setTitle: (title) => {
      this.emit({ type: 'extension_ui_request', id: randomUUID(), method: 'setTitle', title })
    },
    custom: (async () => undefined) as ExtensionUIContext['custom'],
    pasteToEditor: (text) => this.setEditorText(text),
    setEditorText: (text) => this.setEditorText(text),
    getEditorText: () => '',
    editor: (title, prefill) => this.dialog('editor', { title, prefill }, undefined, this.dialogValue(undefined)),
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    theme: plainTheme,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: '桌面端不支持终端主题切换' }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  }
}
