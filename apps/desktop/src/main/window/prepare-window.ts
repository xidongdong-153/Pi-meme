import { dialog, type BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import type { PlatformPrepareRequest } from '@pi-meme/contracts/host'
import { recoveryUrl } from './recovery-page'

type Reason = PlatformPrepareRequest['reason']
type Reply = Pick<PlatformPrepareRequest, 'requestId' | 'documentGeneration'> & {
  ok: boolean
  error?: string
}
type Pending = {
  request: PlatformPrepareRequest
  resolve: () => void
  reject: (cause: Error) => void
  timer: ReturnType<typeof setTimeout>
  acknowledged: boolean
}

const preparationTimeout = 5_000
const coordinators = new WeakMap<BrowserWindow, WindowPreparation>()

/** Coordinates only renderer preparation; all business writes stay on HTTP. */
class WindowPreparation {
  private documentGeneration = 0
  private pending?: Pending
  private running?: Promise<boolean>
  private runningReason?: Reason
  private allowingClose = false

  constructor(
    private window: BrowserWindow,
    private trustedOrigin: () => string,
  ) {
    window.on('close', (event) => {
      if (this.allowingClose) {
        this.allowingClose = false
        return
      }
      event.preventDefault()
      void this.run('close', () => this.close()).catch((cause: unknown) => console.error(String(cause)))
    })
    window.webContents.on('will-prevent-unload', () => this.cancel())
    window.webContents.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument) return
      this.cancel()
      this.documentGeneration += 1
    })
    window.webContents.on('render-process-gone', () => this.cancel('界面进程已退出，保存尚未确认'))
    window.on('closed', () => this.cancel('窗口已关闭'))
  }

  private close() {
    this.allowingClose = true
    try {
      this.window.close()
    } catch (cause) {
      this.allowingClose = false
      throw cause
    }
  }

  cancel(message = '已取消界面关闭准备') {
    const pending = this.pending
    if (!pending) return
    this.pending = undefined
    clearTimeout(pending.timer)
    if (!this.window.isDestroyed() && !this.window.webContents.isDestroyed())
      this.window.webContents.send('platform:lifecycle-cancel', pending.request)
    if (!pending.acknowledged) pending.reject(new Error(message))
  }

  reply(value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('界面准备回执无效')
    const reply = value as Reply
    if (
      typeof reply.requestId !== 'string' ||
      !Number.isSafeInteger(reply.documentGeneration) ||
      typeof reply.ok !== 'boolean' ||
      (reply.error !== undefined && (typeof reply.error !== 'string' || reply.error.length > 2_048))
    )
      throw new Error('界面准备回执无效')
    const pending = this.pending
    if (
      !pending ||
      pending.acknowledged ||
      reply.requestId !== pending.request.requestId ||
      reply.documentGeneration !== this.documentGeneration ||
      reply.documentGeneration !== pending.request.documentGeneration
    )
      return false
    clearTimeout(pending.timer)
    if (reply.ok) {
      pending.acknowledged = true
      pending.resolve()
    } else {
      this.pending = undefined
      this.window.webContents.send('platform:lifecycle-cancel', pending.request)
      pending.reject(new Error(reply.error || '外观保存尚未确认'))
    }
    return true
  }

  private prepare(reason: Reason): Promise<void> {
    const url = this.window.webContents.getURL()
    if (!url || url === 'about:blank' || url === recoveryUrl) return Promise.resolve()
    try {
      if (new URL(url).origin !== this.trustedOrigin()) throw new Error('当前界面来源不可信，保存尚未确认')
    } catch (cause) {
      return Promise.reject(cause)
    }
    return new Promise<void>((resolve, reject) => {
      const request: PlatformPrepareRequest = {
        requestId: randomUUID(),
        documentGeneration: this.documentGeneration,
        reason,
      }
      const timer = setTimeout(() => this.cancel('等待外观保存确认超时，保存尚未确认'), preparationTimeout)
      this.pending = { request, resolve, reject, timer, acknowledged: false }
      this.window.webContents.send('platform:lifecycle-prepare', request)
    })
  }

  run(reason: Reason, action: () => void): Promise<boolean> {
    // Repeated close/quit gestures share one barrier, but must not join a reload or maintenance action.
    if (this.running) {
      const closing = (value: Reason | undefined) => value === 'close' || value === 'quit'
      return reason === this.runningReason || (closing(reason) && closing(this.runningReason))
        ? this.running
        : Promise.resolve(false)
    }
    if (this.pending) return Promise.resolve(false)
    this.runningReason = reason
    const task = (async () => {
      for (;;) {
        try {
          await this.prepare(reason)
          if (this.window.isDestroyed()) return false
          action()
          return true
        } catch (cause) {
          this.cancel()
          if (reason === 'maintenance' || this.window.isDestroyed()) throw cause
          const result = await dialog.showMessageBox(this.window, {
            type: 'warning',
            message: '外观保存尚未确认',
            detail: `${cause instanceof Error ? cause.message : String(cause)}\n仍然继续可能丢失本次尚未确认的外观修改。`,
            buttons: ['重试保存', '取消', '仍然继续'],
            defaultId: 1,
            cancelId: 1,
            noLink: true,
          })
          if (result.response === 0) continue
          if (result.response !== 2 || this.window.isDestroyed()) return false
          action()
          return true
        }
      }
    })()
    const settled: Promise<boolean> = task.finally(() => {
      if (this.running === settled) {
        this.running = undefined
        this.runningReason = undefined
      }
    })
    this.running = settled
    return settled
  }

  closePrepared(reason: 'close' | 'quit') {
    return this.run(reason, () => this.close())
  }
}

export function attachWindowPreparation(window: BrowserWindow, trustedOrigin: () => string) {
  coordinators.set(window, new WindowPreparation(window, trustedOrigin))
}

export function replyWindowPreparation(window: BrowserWindow, value: unknown) {
  return coordinators.get(window)?.reply(value) ?? false
}

export function cancelWindowPreparation(window: BrowserWindow | null) {
  if (window) coordinators.get(window)?.cancel()
}

export function closePreparedWindow(window: BrowserWindow, reason: 'close' | 'quit') {
  const coordinator = coordinators.get(window)
  if (!coordinator) throw new Error('窗口关闭准备尚未初始化')
  return coordinator.closePrepared(reason)
}

export function reloadPreparedWindow(window: BrowserWindow, ignoreCache = false) {
  const coordinator = coordinators.get(window)
  if (!coordinator) throw new Error('窗口关闭准备尚未初始化')
  return coordinator.run(ignoreCache ? 'forceReload' : 'reload', () => {
    if (ignoreCache) window.webContents.reloadIgnoringCache()
    else window.webContents.reload()
  })
}

export async function prepareWindowMaintenance(window: BrowserWindow | null) {
  if (!window || window.isDestroyed()) throw new Error('界面不可用，不能确认保存并维护存储')
  const coordinator = coordinators.get(window)
  if (!coordinator || !(await coordinator.run('maintenance', () => {})))
    throw new Error('已有界面关闭准备正在进行，不能维护存储')
}
