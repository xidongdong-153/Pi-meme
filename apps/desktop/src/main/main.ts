import { app, utilityProcess, type BrowserWindow, type UtilityProcess } from 'electron'
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { HostConnection, HostConnectionError, SavedHostConnection } from '@pi-meme/contracts/host'
import { syncDockIcon } from './dock-icon'
import { createWindow } from './window/create-window'
import { registerPlatformIpc } from './ipc/register'
import { recoveryUrl } from './window/recovery-page'
import { retryHostPage } from './window/load-host-page'
import { createStorageController } from './storage/controller'
import { pendingStorageJob } from './storage/preferences'

if (['memory', 'file'].includes(process.env.PI_MEME_TEST_CREDENTIALS ?? '')) {
  if (!process.env.PI_MEME_DATA_ROOT) throw new Error('Desktop 验收必须指定临时 PI_MEME_DATA_ROOT')
  const cache = path.join(process.env.PI_MEME_DATA_ROOT, 'desktop-cache')
  mkdirSync(cache, { recursive: true })
  app.setPath('userData', cache)
}

if (
  process.env.PI_MEME_DATA_ROOT === undefined &&
  pendingStorageJob(path.join(app.getPath('userData'), 'storage-location.json'))
) {
  const maintenanceSession = path.join(app.getPath('userData'), 'storage-maintenance-session')
  mkdirSync(maintenanceSession, { recursive: true, mode: 0o700 })
  app.setPath('sessionData', maintenanceSession)
}

let window: BrowserWindow | null = null
let ownedHost: UtilityProcess | undefined
let localConnection: { url: string; hostId: string } | undefined
let lastConnectionError: HostConnectionError | null = null
let switching = false
const instanceLocked = app.requestSingleInstanceLock()
if (!instanceLocked) app.exit(0)
app.on('second-instance', () => {
  window?.show()
  window?.focus()
})
const storage = createStorageController({
  anchor: app.getPath('userData'),
  override: process.env.PI_MEME_DATA_ROOT,
  getWindow: () => window,
  getHostId: () => localConnection?.hostId,
  recoverHost: retryConnection,
  stopHost: async () => {
    await hostRequest('maintenance:prepare', { hostId: localConnection?.hostId ?? '' })
    const child = ownedHost
    if (!child) throw new Error('本机 Host 已退出')
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Host 正常停机超时，维护已取消；不会强制终止后迁移')), 60000)
      child.once('exit', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve()
        else reject(new Error(`Host 未正常退出（${code}），维护已取消`))
      })
      child.postMessage({ type: 'stop' })
    })
  },
})
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
const tickets = new Map<
  string,
  { resolve: (value: string) => void; reject: (cause: Error) => void; timer: NodeJS.Timeout }
>()
async function connection(): Promise<HostConnection> {
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
async function startHost() {
  await storage.initialize()
  return new Promise<void>((resolve, reject) => {
    const child = utilityProcess.fork(path.join(__dirname, 'host-process.js'), [], {
      serviceName: 'Pi Meme Host',
      env: {
        ...process.env,
        ...(app.isPackaged
          ? {
              ESBUILD_BINARY_PATH: path.join(
                process.resourcesPath,
                'app.asar.unpacked/node_modules/@esbuild',
                `${process.platform}-${process.arch}`,
                process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild',
              ),
            }
          : {}),
        PI_MEME_FRONTEND_URL: MAIN_WINDOW_VITE_DEV_SERVER_URL ?? process.env.PI_DESKTOP_DEV_SERVER_URL ?? '',
        PI_MEME_DATA_ROOT: storage.root,
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
  const url = localConnection?.url
  return url ? new URL(url).origin : ''
}
async function retryConnection() {
  const target = window
  if (!target) throw new Error('桌面窗口已关闭')
  try {
    await retryHostPage(target, async () => {
      if (!ownedHost || !localConnection) await startHost()
      if (!localConnection) throw new Error('本机 Host 地址不可用')
      return localConnection.url
    })
    if (lastConnectionError?.local !== false) lastConnectionError = null
  } catch (cause) {
    lastConnectionError = { local: true, message: cause instanceof Error ? cause.message : String(cause) }
    if (!target.isDestroyed() && target.webContents.getURL() !== recoveryUrl) await target.loadURL(recoveryUrl)
    throw new Error(`本机 Host 连接失败：${String(cause)}`)
  }
}
async function setConnection(value: { url: string; token: string } | null) {
  if (switching) throw new Error('正在登记远程服务，请等待完成')
  switching = true
  try {
    if (!ownedHost || !localConnection) await startHost()
    if (value) await hostRequest('service:register', { url: value.url, token: value.token })
    lastConnectionError = null
  } catch (cause) {
    lastConnectionError = { local: false, message: cause instanceof Error ? cause.message : String(cause) }
    throw new Error(`远程服务登记失败：${String(cause)}`)
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
    registerPlatformIpc(
      () => window,
      connection,
      trustedOrigin,
      setConnection,
      retryConnection,
      {
        list: () => hostRequest<SavedHostConnection[]>('connection:list'),
        remove: (url) => hostRequest<void>('connection:remove', { url }),
        error: () => lastConnectionError,
      },
      storage.adapter,
    )
    if (!failed && process.env.PI_MEME_REMOTE_HOST) {
      try {
        await setConnection({ url: process.env.PI_MEME_REMOTE_HOST, token: process.env.PI_MEME_TOKEN ?? '' })
      } catch (cause) {
        lastConnectionError = { local: false, message: cause instanceof Error ? cause.message : String(cause) }
        console.error(`启动远程服务登记失败：${lastConnectionError.message}`)
      }
    }
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
  if (storage.busy) {
    event.preventDefault()
    return
  }
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
