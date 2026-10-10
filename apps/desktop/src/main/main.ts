import { app, utilityProcess, type BrowserWindow, type UtilityProcess } from 'electron'
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { HostConnection, HostConnectionError, SavedHostConnection } from '@pi-meme/contracts/host'
import { syncDockIcon } from './dock-icon'
import { createWindow } from './window/create-window'
import { registerPlatformIpc } from './ipc/register'
import { recoveryUrl } from './window/recovery-page'
import { loadHostPage, retryHostPage } from './window/load-host-page'
import { authenticateRemoteHost } from './remote-auth'

if (['memory', 'file'].includes(process.env.PI_MEME_TEST_CREDENTIALS ?? '')) {
  if (!process.env.PI_MEME_DATA_ROOT) throw new Error('Desktop 验收必须指定临时 PI_MEME_DATA_ROOT')
  const cache = path.join(process.env.PI_MEME_DATA_ROOT, 'desktop-cache')
  mkdirSync(cache, { recursive: true })
  app.setPath('userData', cache)
}

let window: BrowserWindow | null = null
let ownedHost: UtilityProcess | undefined
let localConnection: { url: string; hostId: string } | undefined
let remoteConnection: { url: string; hostId: string } | undefined
let lastConnectionError: HostConnectionError | null = null
let switching = false
const connectionRequests = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (cause: Error) => void; timer: NodeJS.Timeout }
>()
function hostRequest<T>(type: string, value: Record<string, string> = {}): Promise<T> {
  const child = ownedHost
  if (!child) return Promise.reject(new Error('本地 Host 尚未启动'))
  return new Promise<T>((resolve, reject) => {
    const id = randomUUID()
    const timer = setTimeout(() => {
      connectionRequests.delete(id)
      reject(new Error('本地 Host 凭据操作超时'))
    }, 10000)
    connectionRequests.set(id, { resolve: (result) => resolve(result as T), reject, timer })
    child.postMessage({ type, id, ...value })
  })
}
let initialConnectionError: Error | undefined
const tickets = new Map<
  string,
  { resolve: (value: string) => void; reject: (cause: Error) => void; timer: NodeJS.Timeout }
>()
async function connection(): Promise<HostConnection> {
  if (remoteConnection) {
    const target = window
    if (!target) throw new Error('桌面窗口已关闭')
    const current = remoteConnection
    try {
      await authenticateRemoteHost(target.webContents.session, current.url, '', current.hostId)
    } catch {
      const saved = await hostRequest<(SavedHostConnection & { token: string }) | undefined>('connection:get', {
        url: current.url,
      })
      if (!saved) throw new Error('远程 Host 登录已失效，请重新输入访问令牌')
      await authenticateRemoteHost(target.webContents.session, current.url, saved.token, saved.hostId)
    }
    if (remoteConnection !== current) throw new Error('Host 连接已切换，请重新连接')
    return { ...current, token: '', local: false }
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
    localConnection = undefined
    child.stderr?.on('data', (data: Buffer) => console.error(data.toString()))
    child.on(
      'message',
      (value: {
        type: string
        url: string
        hostId: string
        id: string
        token: string
        message?: string
        result?: unknown
        error?: string
      }) => {
        if (value.type === 'connection:result') {
          const request = connectionRequests.get(value.id)
          connectionRequests.delete(value.id)
          if (request) {
            clearTimeout(request.timer)
            if (value.error) request.reject(new Error(value.error))
            else request.resolve(value.result)
          }
        }
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
      if (ownedHost === child) {
        ownedHost = undefined
        localConnection = undefined
      }
      for (const request of connectionRequests.values()) {
        clearTimeout(request.timer)
        request.reject(new Error(`本地 Host 已退出（${code}）`))
      }
      connectionRequests.clear()
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
  const local = lastConnectionError?.local ?? !remoteConnection
  const target = window
  if (!target) throw new Error('桌面窗口已关闭')
  try {
    if (lastConnectionError?.local === false && !remoteConnection && process.env.PI_MEME_REMOTE_HOST) {
      await setConnection({ url: process.env.PI_MEME_REMOTE_HOST, token: process.env.PI_MEME_TOKEN ?? '' })
      initialConnectionError = undefined
      return
    }
    await retryHostPage(
      target,
      async () => {
        if (!remoteConnection && (!ownedHost || !localConnection)) await startHost()
        const url = remoteConnection?.url ?? localConnection?.url
        if (!url) throw new Error('Host 地址不可用')
        return url
      },
      local ? undefined : initialConnectionError,
    )
    lastConnectionError = null
  } catch (cause) {
    lastConnectionError = { local, message: String(cause instanceof Error ? cause.message : cause) }
    if (!target.isDestroyed() && target.webContents.getURL() !== recoveryUrl) await target.loadURL(recoveryUrl)
    throw new Error(`Host 连接失败：${String(cause)}`)
  }
}
async function setConnection(value: { url: string; token: string } | null) {
  const target = window
  if (!target) throw new Error('桌面窗口已关闭')
  if (switching) throw new Error('正在切换 Host，请等待完成')
  switching = true
  const previous = remoteConnection
  const previousError = initialConnectionError
  const previousUrl = target.webContents.getURL()
  initialConnectionError = undefined
  try {
    if (!ownedHost || !localConnection) await startHost()
    if (value) {
      const url = new URL(value.url)
      if (url.protocol !== 'https:' || url.username || url.password)
        throw new Error('远程 Host 必须使用 HTTPS，地址不能包含凭据')
      const saved = value.token
        ? undefined
        : await hostRequest<(SavedHostConnection & { token: string }) | undefined>('connection:get', {
            url: url.origin,
          })
      const token = value.token || saved?.token
      if (!token) throw new Error('请输入远程 Host 访问令牌')
      const hostId = await authenticateRemoteHost(target.webContents.session, url.origin, token, saved?.hostId)
      remoteConnection = { url: url.origin, hostId }
      await loadHostPage(target, url.origin)
      await hostRequest('connection:set', { url: url.origin, token, hostId })
    } else {
      remoteConnection = undefined
      await loadHostPage(target, localConnection!.url)
    }
    lastConnectionError = null
  } catch (cause) {
    remoteConnection = previous
    initialConnectionError = previousError
    lastConnectionError = { local: value === null, message: cause instanceof Error ? cause.message : String(cause) }
    if (!target.isDestroyed() && target.webContents.getURL() !== previousUrl)
      await loadHostPage(target, previousUrl || recoveryUrl).catch(() => {})
    throw new Error(`无法切换 Host，已恢复原连接：${String(cause)}`)
  } finally {
    switching = false
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
      await startHost()
    } catch (cause) {
      failed = true
      lastConnectionError = { local: true, message: cause instanceof Error ? cause.message : String(cause) }
      console.error(`Host 初始化失败：${String(cause)}`)
    }
    registerPlatformIpc(() => window, connection, trustedOrigin, setConnection, retryConnection, {
      list: () => hostRequest<SavedHostConnection[]>('connection:list'),
      remove: (url) => hostRequest<void>('connection:remove', { url }),
      error: () => lastConnectionError,
    })
    await open(failed)
    if (!failed && process.env.PI_MEME_REMOTE_HOST) {
      try {
        await setConnection({ url: process.env.PI_MEME_REMOTE_HOST, token: process.env.PI_MEME_TOKEN ?? '' })
      } catch (cause) {
        initialConnectionError = cause instanceof Error ? cause : new Error(String(cause))
        lastConnectionError = { local: false, message: initialConnectionError.message }
        await window?.loadURL(recoveryUrl)
      }
    }
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
