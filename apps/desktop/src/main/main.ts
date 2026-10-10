import { app, utilityProcess, type BrowserWindow, type UtilityProcess } from 'electron'
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { HostConnection } from '@pi-meme/contracts/host'
import { syncDockIcon } from './dock-icon'
import { createWindow } from './window/create-window'
import { registerPlatformIpc } from './ipc/register'
import { recoveryUrl } from './window/recovery-page'
import { loadHostPage, retryHostPage } from './window/load-host-page'

if (process.env.PI_MEME_TEST_CREDENTIALS === 'memory') {
  if (!process.env.PI_MEME_DATA_ROOT) throw new Error('Desktop 验收必须指定临时 PI_MEME_DATA_ROOT')
  const cache = path.join(process.env.PI_MEME_DATA_ROOT, 'desktop-cache')
  mkdirSync(cache, { recursive: true })
  app.setPath('userData', cache)
}

let window: BrowserWindow | null = null
let ownedHost: UtilityProcess | undefined
let localConnection: { url: string; hostId: string } | undefined
let remoteConnection: { url: string; token: string } | undefined
let initialConnectionError: Error | undefined
const tickets = new Map<
  string,
  { resolve: (value: string) => void; reject: (cause: Error) => void; timer: NodeJS.Timeout }
>()
async function connection(): Promise<HostConnection> {
  if (remoteConnection) {
    const token = remoteConnection.token
    remoteConnection.token = ''
    return { ...remoteConnection, token, hostId: '', local: false }
  }
  if (!ownedHost || !localConnection) throw new Error('本地 Host 尚未启动')
  const child = ownedHost
  const token = await new Promise<string>((resolve, reject) => {
    const id = randomUUID()
    const timer = setTimeout(() => {
      tickets.delete(id)
      reject(new Error('本地 Host 握手超时'))
    }, 10000)
    tickets.set(id, { resolve, reject, timer })
    child.postMessage({ type: 'ticket', id })
  })
  return { ...localConnection, token, local: true }
}
function startHost() {
  return new Promise<void>((resolve, reject) => {
    const child = utilityProcess.fork(path.join(__dirname, 'host-process.js'), [], {
      serviceName: 'Pi Meme Host',
      env: {
        ...process.env,
        PI_MEME_FRONTEND_URL: MAIN_WINDOW_VITE_DEV_SERVER_URL ?? process.env.PI_DESKTOP_DEV_SERVER_URL ?? '',
      },
      stdio: 'pipe',
    })
    ownedHost = child
    child.stderr?.on('data', (data: Buffer) => console.error(data.toString()))
    child.on(
      'message',
      (value: { type: string; url: string; hostId: string; id: string; token: string; message?: string }) => {
        if (value.type === 'ready') {
          localConnection = { url: value.url, hostId: value.hostId }
          resolve()
        }
        if (value.type === 'failed') {
          child.kill()
          if (ownedHost === child) ownedHost = undefined
          reject(new Error(value.message ?? 'Host 启动失败'))
        }
        if (value.type === 'ticket') {
          const request = tickets.get(value.id)
          tickets.delete(value.id)
          if (request) {
            clearTimeout(request.timer)
            request.resolve(value.token)
          }
        }
      },
    )
    child.once('exit', (code) => {
      if (ownedHost === child) ownedHost = undefined
      for (const request of tickets.values()) {
        clearTimeout(request.timer)
        request.reject(new Error(`本地 Host 已退出（${code}）`))
      }
      tickets.clear()
      reject(new Error(`本地 Host 已退出（${code}）`))
    })
  })
}
function trustedOrigin() {
  const url = remoteConnection?.url ?? localConnection?.url
  return url ? new URL(url).origin : ''
}
async function retryConnection() {
  const target = window
  if (!target) throw new Error('桌面窗口已关闭')
  try {
    await retryHostPage(
      target,
      async () => {
        if (!remoteConnection && (!ownedHost || !localConnection)) await startHost()
        const url = remoteConnection?.url ?? localConnection?.url
        if (!url) throw new Error('Host 地址不可用')
        return url
      },
      initialConnectionError,
    )
  } catch (cause) {
    if (!target.isDestroyed() && target.webContents.getURL() !== recoveryUrl) await target.loadURL(recoveryUrl)
    throw new Error(`Host 连接失败：${String(cause)}`)
  }
}
async function setConnection(value: { url: string; token: string } | null) {
  const target = window
  if (!target) throw new Error('桌面窗口已关闭')
  const previous = remoteConnection
  const previousError = initialConnectionError
  const previousUrl = target.webContents.getURL()
  remoteConnection = value ?? undefined
  initialConnectionError = undefined
  try {
    if (!remoteConnection && (!ownedHost || !localConnection)) await startHost()
    const url = remoteConnection?.url ?? localConnection?.url
    if (!url) throw new Error('Host 地址不可用')
    await loadHostPage(target, url, previousUrl, () => {
      remoteConnection = previous
      initialConnectionError = previousError
    })
  } catch (cause) {
    remoteConnection = previous
    initialConnectionError = previousError
    if (
      !target.isDestroyed() &&
      target.webContents.getURL() !== previousUrl &&
      target.webContents.getURL() !== recoveryUrl
    )
      await loadHostPage(target, previousUrl || recoveryUrl).catch(() => {})
    throw new Error(`无法切换 Host，已恢复原连接：${String(cause)}`)
  }
}
async function open(failed = false) {
  window = createWindow('#171717', trustedOrigin)
  const target = window
  target.on('closed', () => {
    if (window === target) window = null
  })
  if (failed) await target.loadURL(recoveryUrl)
  else await retryConnection().catch((cause: unknown) => console.error(String(cause)))
}
app
  .whenReady()
  .then(async () => {
    syncDockIcon()
    let failed = false
    try {
      if (process.env.PI_MEME_REMOTE_HOST) {
        const url = new URL(process.env.PI_MEME_REMOTE_HOST)
        if (url.protocol !== 'https:' || url.username || url.password)
          throw new Error('远程 Host 必须使用 HTTPS，地址不能包含凭据')
        remoteConnection = { url: url.origin, token: process.env.PI_MEME_TOKEN ?? '' }
      } else await startHost()
    } catch (cause) {
      failed = true
      if (process.env.PI_MEME_REMOTE_HOST && !remoteConnection)
        initialConnectionError = new Error(`远程 Host 配置无效：${String(cause)}`)
      console.error(`Host 初始化失败：${String(cause)}`)
    }
    registerPlatformIpc(() => window, connection, trustedOrigin, setConnection, retryConnection)
    await open(failed)
    app.on('activate', () => {
      if (!window) void open().catch((cause: unknown) => console.error(String(cause)))
    })
  })
  .catch((cause: unknown) => {
    console.error(`桌面初始化失败：${String(cause)}`)
    app.quit()
  })
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
let stopped = false
app.on('before-quit', (event) => {
  if (!ownedHost || stopped) return
  event.preventDefault()
  const child = ownedHost
  const timer = setTimeout(() => {
    child.kill()
    stopped = true
    app.quit()
  }, 10000)
  child.once('exit', () => {
    clearTimeout(timer)
    stopped = true
    app.quit()
  })
  child.postMessage({ type: 'stop' })
})
