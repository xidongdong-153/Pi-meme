import { BaseWindow, dialog, Menu, type BrowserWindow, type MessageBoxOptions } from 'electron'
import type { NodeHostClient } from '@pi-meme/client/node-host-client'

type LegacyCount = (client: NodeHostClient, signal: AbortSignal) => Promise<number | undefined>

async function runningSessionCount(client: NodeHostClient, legacyCount?: LegacyCount) {
  const signal = AbortSignal.timeout(5000)
  try {
    const count = await client.rpc<number>('host:running-session-count', [], { signal })
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('会话数量无效')
    return count
  } catch (cause) {
    if (
      !legacyCount ||
      !(cause instanceof Error) ||
      !cause.message.includes('服务方法不存在：host:running-session-count')
    )
      throw cause
    return legacyCount(client, signal)
  }
}

export async function confirmSessionQuit(
  client: NodeHostClient | undefined,
  getWindow: () => BrowserWindow | null,
  legacyCount?: LegacyCount,
) {
  let count: number | undefined
  try {
    if (client) count = await runningSessionCount(client, legacyCount)
  } catch (cause) {
    console.error('退出时读取运行中会话失败', cause)
  }
  if (count === 0) return true
  const options: MessageBoxOptions = {
    type: 'question',
    message: count === undefined ? '无法确认是否还有会话正在运行' : `还有 ${count} 个会话正在运行`,
    buttons: ['取消', '停止并退出'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  }
  const window = getWindow()
  if (process.platform !== 'darwin') {
    const result = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options)
    return result.response === 1
  }

  // 无主窗口的 AppKit alert 会同步阻塞，也无法接收取消信号。用透明原生窗口承载同一张 sheet。
  const parent =
    window ??
    new BaseWindow({
      width: 1,
      height: 1,
      center: true,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
    })
  const menu = Menu.getApplicationMenu() ?? Menu.buildFromTemplate([{ role: 'appMenu' }])
  const [application, ...otherMenus] = menu.items
  const cancel = new AbortController()
  try {
    // Electron 给取消按钮绑定 Esc 时会覆盖 Return。临时应用菜单只在弹窗打开时补上回车。
    const submenu = Menu.buildFromTemplate([
      ...(application?.submenu?.items ?? []),
      { label: '取消', accelerator: 'Return', visible: false, click: () => cancel.abort() },
    ])
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([{ label: application?.label, role: 'appMenu', submenu }, ...otherMenus]),
    )
    if (!window) parent.show()
    const { response } = await dialog.showMessageBox(parent, { ...options, signal: cancel.signal })
    return response === 1
  } finally {
    Menu.setApplicationMenu(menu)
    if (!window) parent.destroy()
  }
}
