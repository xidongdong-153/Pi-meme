import { registerBrowserRuntime } from './browser/browser-runtime'
import { app, dialog, nativeTheme, type BrowserWindow } from 'electron'
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import type { HostConnection, HostConnectionError, SavedHostConnection } from '@pi-meme/contracts/host'
import type { ShortcutPreferences } from '@pi-meme/contracts/keyboard-shortcuts'
import type { PiMigrationResult, PiMigrationScan } from '@pi-meme/contracts/pi-migration'
import { defaultDevelopmentFrontendPort, defaultFrontendPort } from '@pi-meme/contracts/host-runtime'
import { createNodeHostClient, type NodeHostClient } from '@pi-meme/client/node-host-client'
import { createAppUpdateService } from '@pi-meme/host/app-update'
import { readLocalHostStatus } from '@pi-meme/host/host-status'
import { startFrontendServer } from '@pi-meme/host/frontend-server'
import { syncDockIcon } from './dock-icon'
import { createWindow } from './window/create-window'
import { registerPlatformIpc } from './ipc/register'
import { recoveryUrl } from './window/recovery-page'
import { retryHostPage } from './window/load-host-page'
import { createStorageController } from './storage/controller'
import { pendingStorageJob } from './storage/preferences'
import { acquireDesktopHost, type DesktopHostOperation } from './local-host'
import { createShortcutPreferencesStore } from './shortcut-preferences'
import { findHostLoginItem } from './host-login-item'
import { confirmSessionQuit } from './quit-confirmation'
import { cancelWindowPreparation, closePreparedWindow, prepareWindowMaintenance } from './window/prepare-window'

const isolatedTest = ['memory', 'file'].includes(process.env.PI_MEME_TEST_CREDENTIALS ?? '')
if (isolatedTest) {
  if (!process.env.PI_MEME_DATA_ROOT) throw new Error('Desktop 验收必须指定临时 PI_MEME_DATA_ROOT')
  const resolvedRoot = path.resolve(process.env.PI_MEME_DATA_ROOT)
  const cache = path.join(path.dirname(resolvedRoot), `${path.basename(resolvedRoot)}-desktop-cache`)
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
const desktopShortcuts = createShortcutPreferencesStore(app.getPath('userData'))
const desktopUpdates = createAppUpdateService({
  kind: 'desktop',
  version: app.getVersion(),
  packaged: app.isPackaged,
  developmentFeed: app.isPackaged ? undefined : process.env.PI_MEME_UPDATE_FEED,
})
const storage = createStorageController({
  anchor: app.getPath('userData'),
  override: process.env.PI_MEME_DATA_ROOT,
  defaultRoot: app.isPackaged ? undefined : path.join(homedir(), '.pi-meme-dev'),
  getWindow: () => window,
  getHostId: () => localHost?.status.hostId,
  ownsHost: () => localHost?.ownership === 'owned',
  prepareWindow: () => prepareWindowMaintenance(window),
  cancelPreparation: () => cancelWindowPreparation(window),
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
        PI_MEME_DESKTOP_PREFERENCES: app.getPath('userData'),
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
  if (stopping) return Promise.reject(new Error('桌面正在退出'))
  starting ??= initializeHost().finally(() => {
    starting = undefined
  })
  return starting
}
async function migratePi<T>(
  hostId: string,
  operation: Extract<DesktopHostOperation, `migration:${string}`>,
  input?: unknown,
) {
  const lease = localHost
  if (!lease || lease.status.hostId !== hostId) throw new Error('本机服务已切换，请重新打开设置')
  if (lease.ownership !== 'owned') throw new Error('当前使用独立 Host。请用 Desktop 自带的本机服务迁移 Pi 配置')
  return lease.resource.request<T>(operation, input)
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
  if (stopping || window) return
  window = createWindow(nativeTheme.shouldUseDarkColors ? '#0e0f11' : '#faf9f5', trustedOrigin)
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
      {
        getInfo: () => {
          const info = desktopUpdates.getInfo()
          return localHost?.ownership === 'owned' ? { ...info, bundledHostId: localHost.status.hostId } : info
        },
        check: (force) =>
          localHost?.ownership === 'owned' && hostClient
            ? hostClient.checkAppUpdate(force)
            : desktopUpdates.check(force),
      },
      storage.adapter,
      {
        migration: {
          scan: (hostId) => migratePi<PiMigrationScan>(hostId, 'migration:scan'),
          apply: (hostId, input) => migratePi<PiMigrationResult>(hostId, 'migration:apply', input),
        },
        shortcuts: {
          read: () =>
            localHost?.ownership === 'owned'
              ? localHost.resource.request<ShortcutPreferences>('shortcuts:read')
              : desktopShortcuts.read(),
          save: async (value) => {
            if (localHost?.ownership === 'owned') await localHost.resource.request('shortcuts:save', value)
            else await desktopShortcuts.save(value)
          },
        },
      },
    )
    if (!failed && !stopping && process.env.PI_MEME_REMOTE_HOST) {
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
let pendingLoginItem: Awaited<ReturnType<typeof findHostLoginItem>>
async function quitDesktop() {
  // 启动中的 Host 和界面代理可能已经创建，但尚未赋给主进程的变量。
  await starting?.catch(() => {})
  const lease = localHost
  const loginItem = pendingLoginItem ?? (app.isPackaged && lease ? await findHostLoginItem(lease) : undefined)
  let confirmation: Promise<boolean> | undefined
  const confirm = () => {
    if (!lease || lease !== localHost || (lease.ownership === 'attached' && !loginItem)) return Promise.resolve(true)
    return (confirmation ??= confirmSessionQuit(hostClient, () => window, loginItem?.legacyRunningSessionCount))
  }
  const target = window
  if (target && !(await closePreparedWindow(target, 'quit', confirm))) {
    cancelWindowPreparation(target)
    return
  }
  // macOS 可以在窗口已关闭时退出，也可以在关闭窗口的同时按 ⌘Q。
  if (!(await confirm())) return
  // 先卸载登录项，避免它在自管 Host 释放端口后立即补启 Server。
  pendingLoginItem = loginItem
  await loginItem?.stop()
  pendingLoginItem = undefined
  hostClient?.dispose()
  hostClient = undefined
  uiUrl = ''
  try {
    await frontend?.dispose()
    frontend = undefined
  } finally {
    if (lease?.ownership === 'owned') await lease.resource.dispose()
  }
  stopped = true
  app.quit()
}
app.on('before-quit', (event) => {
  if (storage.busy) {
    event.preventDefault()
    return
  }
  if (stopped) return
  event.preventDefault()
  if (stopping) return
  stopping = true
  let showRecovery = false
  void quitDesktop()
    .catch((cause: unknown) => {
      showRecovery = true
      cancelWindowPreparation(window)
      dialog.showErrorBox('Pi meme 退出未完成', cause instanceof Error ? cause.message : String(cause))
    })
    .finally(() => {
      if (stopped) return
      stopping = false
      if (showRecovery && !window && app.isReady())
        void open(true).catch((cause: unknown) => console.error(String(cause)))
    })
})
