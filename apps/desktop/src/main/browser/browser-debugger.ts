import type { WebContents, WebContentsView } from 'electron'
import type { BrowserAgentKey } from '@pi-meme/contracts/browser-agent'
import { SystemReadError } from '@pi-meme/contracts/system-read'

type BrowserDebuggerMethod =
  'Page.getLayoutMetrics' | 'Page.captureScreenshot' | 'Input.dispatchKeyEvent' | 'Emulation.setFocusEmulationEnabled'
type Send = (
  method: BrowserDebuggerMethod,
  params?: Record<string, unknown>,
) => ReturnType<WebContents['debugger']['sendCommand']>

export async function withBrowserDebugger<T>(web: WebContents, deadline: number, run: (send: Send) => Promise<T>) {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new SystemReadError('timeout', '网页操作已过期')
  if (web.isDestroyed()) throw new SystemReadError('not-found', '网页已关闭')
  if (web.debugger.isAttached())
    throw new SystemReadError('disabled', '网页调试器正被截图、键盘操作或开发者工具使用，请稍后重试', {
      reason: 'debugger-busy',
    })
  web.debugger.attach('1.3')
  let attached = true
  const detached = () => {
    attached = false
  }
  web.debugger.once('detach', detached)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const send: Send = (method, params) => {
      if (Date.now() >= deadline) throw new SystemReadError('timeout', '网页操作已过期')
      if (!attached || web.isDestroyed() || !web.debugger.isAttached())
        throw new SystemReadError('disconnected', '网页调试连接已断开')
      return web.debugger.sendCommand(method, params)
    }
    return await Promise.race([
      run(send),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SystemReadError('timeout', '网页调试操作超时')), remaining)
      }),
    ])
  } finally {
    clearTimeout(timer)
    web.debugger.removeListener('detach', detached)
    if (attached && !web.isDestroyed() && web.debugger.isAttached()) web.debugger.detach()
  }
}

const virtualKeys: Record<BrowserAgentKey, number> = {
  Enter: 13,
  Tab: 9,
  'Shift+Tab': 9,
  Escape: 27,
  Space: 32,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
}

export async function pressBrowserKey(
  view: WebContentsView,
  deadline: number,
  key: BrowserAgentKey,
  focusElement: () => Promise<void>,
  assertTarget: () => void,
  sameDocument: () => boolean,
) {
  const web = view.webContents
  const code = key === 'Shift+Tab' ? 'Tab' : key
  const params = {
    code,
    key: key === 'Space' ? ' ' : code,
    modifiers: key === 'Shift+Tab' ? 8 : 0,
    windowsVirtualKeyCode: virtualKeys[key],
  }
  const text = key === 'Enter' ? '\r' : key === 'Space' ? ' ' : undefined
  const down = text === undefined ? { type: 'rawKeyDown' } : { type: 'keyDown', text, unmodifiedText: text }
  let dispatched = false
  try {
    await withBrowserDebugger(web, deadline, async (send) => {
      assertTarget()
      // Hiding a view can leave its WebContents focused even though Chromium won't route keys to it.
      const emulateFocus = !view.getVisible() || !web.isFocused()
      if (emulateFocus) await send('Emulation.setFocusEmulationEnabled', { enabled: true })
      try {
        assertTarget()
        await focusElement()
        assertTarget()
        const keyDown = send('Input.dispatchKeyEvent', { ...params, ...down })
        dispatched = true
        await keyDown
        if (sameDocument()) await send('Input.dispatchKeyEvent', { ...params, type: 'keyUp' })
      } finally {
        if (emulateFocus) {
          try {
            await send('Emulation.setFocusEmulationEnabled', { enabled: false })
          } catch {
            // The owning debugger session is detached even when the view closes or times out.
          }
        }
      }
    })
  } catch (cause) {
    if (dispatched)
      throw new SystemReadError(
        cause instanceof SystemReadError ? cause.code : 'internal-error',
        '无法确认按键是否完整送达，请先读取当前网页',
        { delivery: 'delivery_uncertain', retry: 'unsafe' },
      )
    if (cause instanceof SystemReadError)
      throw new SystemReadError(cause.code, cause.message, { ...cause.details, delivery: 'not_delivered' })
    throw new SystemReadError('internal-error', '网页键盘连接失败', { delivery: 'not_delivered' })
  }
}
