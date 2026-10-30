import { registerBrowserRuntime } from './browser/browser-runtime'
import { app, type BrowserWindow } from 'electron'
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import type { HostConnection, HostConnectionError, SavedHostConnection } from '@pi-meme/contracts/host'
import { defaultDevelopmentFrontendPort, defaultFrontendPort } from '@pi-meme/contracts/host-runtime'
import { createNodeHostClient, type NodeHostClient } from '@pi-meme/client/node-host-client'
import { readLocalHostStatus } from '@pi-meme/host/host-status'
import { startFrontendServer } from '@pi-meme/host/frontend-server'
import { syncDockIcon } from './dock-icon'
import { createWindow } from './window/create-window'
import { registerPlatformIpc } from './ipc/register'
import { recoveryUrl } from './window/recovery-page'
import { retryHostPage } from './window/load-host-page'
import { createStorageController } from './storage/controller'
import { pendingStorageJob } from './storage/preferences'
import { acquireDesktopHost } from './local-host'

const isolatedTest = ['memory', 'file'].includes(process.env.PI_MEME_TEST_CREDENTIALS ?? '')
if (isolatedTest) {
  if (!process.env.PI_MEME_DATA_ROOT) throw new Error('Desktop 验收必须指定临时 PI_MEME_DATA_ROOT')
  const cache = path.join(process.env.PI_MEME_DATA_ROOT, 'desktop-cache')
  mkdirSync(cache, { recursive: true })
  app.setPath('userData', cache)
} else if (!app.isPackaged || !app.commandLine.hasSwitch('user-data-dir')) {
  const cache = path.join(app.getPath('appData'), app.isPackaged ? 'pi-meme' : 'pi-meme-dev')
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
let localHost: Awaited<ReturnType<typeof acquireDesktopHost>> | undefined
let hostClient: NodeHostClient | undefined
let frontend: Awaited<ReturnType<typeof startFrontendServer>> | undefined
let uiUrl = ''
let starting: Promise<void> | undefined
let lastConnectionError: HostConnectionError | null = null
let switching = false
let stopping = false
const instanceLocked = app.requestSingleInstanceLock()
if (!instanceLocked) app.exit(0)
app.on('second-instance', () => {
  window?.show()
  window?.focus()
})
const storage = createStorageController({
  anchor: app.getPath('userData'),
  override: process.env.PI_MEME_DATA_ROOT,
  defaultRoot: app.isPackaged ? undefined : path.join(homedir(), '.pi-meme-dev'),
  getWindow: () => window,
  getHostId: () => localHost?.status.hostId,
  ownsHost: () => localHost?.ownership === 'owned',
  recoverHost: retryConnection,
  stopHost: async () => {
    const lease = localHost
    if (lease?.ownership !== 'owned') throw new Error('当前服务由其他入口管理，不能从 Desktop 维护')
    await lease.resource.prepareMaintenance()
    await lease.resource.stopForMaintenance()
  },
})
async function connection(): Promise<HostConnection> {
  if (!localHost || !uiUrl) throw new Error('本机服务尚未连接')
  return { url: uiUrl, hostId: localHost.status.hostId, token: '', local: true }
}
function rpc<T>(method: string, args: unknown[] = []): Promise<T> {
  if (!hostClient) return Promise.reject(new Error('本机服务尚未连接'))
  return hostClient.rpc<T>(method, args)
}
async function initializeHost() {
  if (localHost) {
    const status = await readLocalHostStatus(localHost.url)
    if (status && status.hostId !== localHost.status.hostId) throw new Error('本机服务身份已变化，请重新连接')
    if (!status) {
      if (localHost.ownership === 'owned') await localHost.resource.dispose()
      localHost = undefined
      hostClient?.dispose()
      hostClient = undefined
    }
  }
  if (!localHost) {
    await storage.initialize()
    const lease = await acquireDesktopHost({
      entry: path.join(__dirname, 'host-process.js'),
      dataRoot: storage.root,
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
      },
    })
    localHost = lease
    if (lease.ownership === 'owned')
      lease.resource.child.once('exit', () => {
        if (localHost !== lease) return
        localHost = undefined
        hostClient?.dispose()
        hostClient = undefined
      })
    await frontend?.dispose()
    frontend = undefined
    uiUrl = ''
  }
  const lease = localHost
  if (!lease) throw new Error('本机服务已退出')
  hostClient ??= await createNodeHostClient({
    url: lease.url,
    token: '',
    hostId: lease.status.hostId,
    clientId: 'desktop-platform',
  })
  if (!uiUrl) {
    const devUrl = MAIN_WINDOW_VITE_DEV_SERVER_URL ?? process.env.PI_DESKTOP_DEV_SERVER_URL
    if (devUrl) uiUrl = new URL(devUrl).origin
    else {
      frontend = await startFrontendServer({
        upstreamUrl: lease.url,
        hostId: lease.status.hostId,
        staticDirectory: path.join(__dirname, '../renderer/main_window'),
        port: isolatedTest ? 0 : app.isPackaged ? defaultFrontendPort : defaultDevelopmentFrontendPort,
      })
      uiUrl = frontend.url
    }
  }
}
function startHost() {
  starting ??= initializeHost().finally(() => {
    starting = undefined
  })
  return starting
}
function trustedOrigin() {
  return uiUrl ? new URL(uiUrl).origin : ''
}
async function retryConnection() {
  const target = window
  if (!target) throw new Error('桌面窗口已关闭')
  try {
    await retryHostPage(target, async () => {
      await startHost()
      return uiUrl
    })
    if (lastConnectionError?.local !== false) lastConnectionError = null
  } catch (cause) {
    lastConnectionError = { local: true, message: cause instanceof Error ? cause.message : String(cause) }
    if (!target.isDestroyed() && target.webContents.getURL() !== recoveryUrl) await target.loadURL(recoveryUrl)
    throw new Error(`本机服务连接失败：${String(cause)}`)
  }
}
async function setConnection(value: { url: string; token: string } | null) {
  if (switching) throw new Error('正在登记远程服务，请等待完成')
  switching = true
  try {
    await startHost()
    if (value) await rpc('host:services:register', [value])
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
      console.error(`服务初始化失败：${String(cause)}`)
    }
    registerBrowserRuntime({ getWindow: () => window, origin: trustedOrigin, rpc })
    registerPlatformIpc(
      () => window,
      connection,
      trustedOrigin,
      setConnection,
      retryConnection,
      {
        list: () => rpc<SavedHostConnection[]>('host:connections:list'),
        remove: (url) => rpc<void>('host:connections:remove', [url]),
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
      if (!window && !stopping) void open().catch((cause: unknown) => console.error(String(cause)))
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
  if (stopped) return
  event.preventDefault()
  if (stopping) return
  stopping = true
  const target = window
  const contents = target?.webContents
  function cancelQuit() {
    target?.removeListener('closed', dispose)
    stopping = false
  }
  function dispose() {
    contents?.removeListener('will-prevent-unload', cancelQuit)
    const lease = localHost
    hostClient?.dispose()
    void (async () => {
      try {
        await frontend?.dispose()
      } finally {
        if (lease?.ownership === 'owned') await lease.resource.dispose()
      }
    })()
      .catch((cause: unknown) => console.error(`桌面退出清理失败：${String(cause)}`))
      .finally(() => {
        stopped = true
        app.quit()
      })
  }
  if (target) {
    target.once('closed', dispose)
    contents?.once('will-prevent-unload', cancelQuit)
    target.close()
  } else dispose()
})
