import { registerBrowserRuntime } from './browser/browser-runtime'
import { app, session, type BrowserWindow, type Session } from 'electron'
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import type { HostConnection, HostConnectionError, SavedHostConnection } from '@pi-meme/contracts/host'
import { defaultDevelopmentFrontendPort, defaultFrontendPort } from '@pi-meme/contracts/host-runtime'
import { createNodeHostClient, type NodeHostClient } from '@pi-meme/client/node-host-client'
import { readLocalHostStatus } from '@pi-meme/host/host-status'
import { startFrontendServer } from '@pi-meme/host/frontend-server'
import { runtimeSnapshotPaths } from '@pi-meme/host/runtime-snapshot'
import { syncDockIcon } from './dock-icon'
import { createWindow } from './window/create-window'
import { registerPlatformIpc } from './ipc/register'
import { recoveryUrl } from './window/recovery-page'
import { retryHostPage } from './window/load-host-page'
import { createStorageController } from './storage/controller'
import { pendingStorageJob } from './storage/preferences'
import { acquireDesktopHost } from './local-host'
import { createLocalPairingStore } from './local-pairing'
import {
  authenticateLocalHost,
  bindOwnerCookieScope,
  clearOwnerCookieScope,
  HostIdentityChangedError,
  protectOwnerSessionCookies,
} from './remote-auth'
import { cancelWindowPreparation, closePreparedWindow, prepareWindowMaintenance } from './window/prepare-window'

const developmentSnapshot =
  !app.isPackaged && process.env.PI_MEME_RUNTIME_SNAPSHOT
    ? runtimeSnapshotPaths(process.env.PI_MEME_RUNTIME_SNAPSHOT)
    : undefined
if (!app.isPackaged && !developmentSnapshot)
  throw new Error('runtime-snapshot-required: 请通过 pnpm start 或 Desktop start 启动固定开发运行时')
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

const pairings = createLocalPairingStore(app.getPath('userData'))
let installationId: Promise<string> | undefined
let window: BrowserWindow | null = null
let localHost: Awaited<ReturnType<typeof acquireDesktopHost>> | undefined
let hostClient: NodeHostClient | undefined
let frontend: Awaited<ReturnType<typeof startFrontendServer>> | undefined
let ownerBrowserSession: Session | undefined
const invalidatedHostLeases = new WeakSet<NonNullable<typeof localHost>>()
let uiUrl = ''
let starting: Promise<void> | undefined
let lastConnectionError: HostConnectionError | null = null
let switching = false
let stopping = false
let disposing = false
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
function assertHostLease(lease: NonNullable<typeof localHost>) {
  if (disposing || lease !== localHost || invalidatedHostLeases.has(lease))
    throw new HostIdentityChangedError('本机服务连接已失效，请重新连接')
}
function invalidateHostLease(lease: NonNullable<typeof localHost>) {
  invalidatedHostLeases.add(lease)
  if (localHost !== lease) return
  if (ownerBrowserSession) clearOwnerCookieScope(ownerBrowserSession)
  hostClient?.dispose()
  hostClient = undefined
}
async function authenticationToken(lease: NonNullable<typeof localHost>) {
  assertHostLease(lease)
  let token: string | undefined
  if (lease.ownership === 'owned') {
    installationId ??= pairings.installationId()
    const id = await installationId
    assertHostLease(lease)
    token = await lease.resource.createBootstrapTicket(id)
  } else token = await pairings.token(lease.url, lease.status.hostId)
  assertHostLease(lease)
  if (!token) throw new Error('已有本机服务，请输入访问令牌建立配对')
  return token
}
async function authenticateWindow() {
  const lease = localHost
  const frontendUrl = uiUrl
  if (!lease || !frontendUrl) throw new Error('本机服务尚未连接')
  const assertCurrent = () => {
    assertHostLease(lease)
    if (frontendUrl !== uiUrl) throw new Error('本机前端连接已变化，请重试')
  }
  assertCurrent()
  const browserSession = (ownerBrowserSession ??= session.fromPartition('pi-meme-app'))
  protectOwnerSessionCookies(browserSession)
  try {
    await authenticateLocalHost(browserSession, lease.url, '', lease.status.hostId, frontendUrl)
  } catch (cause) {
    if (cause instanceof HostIdentityChangedError) {
      invalidateHostLease(lease)
      throw cause
    }
    try {
      await authenticateLocalHost(
        browserSession,
        lease.url,
        await authenticationToken(lease),
        lease.status.hostId,
        frontendUrl,
      )
    } catch (error) {
      if (error instanceof HostIdentityChangedError) invalidateHostLease(lease)
      throw error
    }
  }
  assertCurrent()
  bindOwnerCookieScope(browserSession, lease.status.hostId, lease.url, frontendUrl)
}
async function connection(): Promise<HostConnection> {
  await authenticateWindow()
  return { url: uiUrl, hostId: localHost!.status.hostId, token: '', local: true }
}
function rpc<T>(method: string, args: unknown[] = []): Promise<T> {
  if (!hostClient) return Promise.reject(new Error('本机服务尚未连接'))
  return hostClient.rpc<T>(method, args)
}
async function initializeHost() {
  if (disposing) throw new Error('应用正在退出')
  if (localHost) {
    const previous = localHost
    const status = await readLocalHostStatus(previous.url)
    if (previous !== localHost) throw new Error('本机服务连接已变化，请重试')
    const identityChanged = status && status.hostId !== previous.status.hostId
    if (!status || identityChanged || invalidatedHostLeases.has(previous)) {
      invalidateHostLease(previous)
      if (previous.ownership === 'owned') await previous.resource.dispose()
      if (localHost === previous) localHost = undefined
      if (identityChanged) throw new HostIdentityChangedError('本机服务身份已变化，请重新连接并配对')
    }
  }
  if (!localHost) {
    await storage.initialize()
    if (disposing) throw new Error('应用正在退出')
    const lease = await acquireDesktopHost({
      entry: developmentSnapshot?.hostPath ?? path.join(__dirname, 'host-process.js'),
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
        PI_MEME_FRONTEND_URL: '',
      },
    })
    if (disposing) {
      if (lease.ownership === 'owned') await lease.resource.dispose()
      throw new Error('应用正在退出')
    }
    localHost = lease
    if (lease.ownership === 'owned')
      lease.resource.child.once('exit', () => {
        if (localHost !== lease) return
        if (ownerBrowserSession) clearOwnerCookieScope(ownerBrowserSession)
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
  if (!hostClient) {
    const candidate = await createNodeHostClient({
      url: lease.url,
      getAuthenticationToken: () => authenticationToken(lease),
      hostId: lease.status.hostId,
      clientId: 'desktop-platform',
    })
    try {
      assertHostLease(lease)
      if (hostClient) candidate.dispose()
      else hostClient = candidate
    } catch (cause) {
      candidate.dispose()
      throw cause
    }
  }
  if (!uiUrl) {
    const candidate = await startFrontendServer({
      upstreamUrl: lease.url,
      hostId: lease.status.hostId,
      staticDirectory: developmentSnapshot?.staticDirectory ?? path.join(__dirname, '../renderer/main_window'),
      runtimeSnapshotRoot: developmentSnapshot?.root,
      port: isolatedTest ? 0 : app.isPackaged ? defaultFrontendPort : defaultDevelopmentFrontendPort,
    })
    try {
      assertHostLease(lease)
      if (uiUrl) await candidate.dispose()
      else {
        frontend = candidate
        uiUrl = candidate.url
      }
    } catch (cause) {
      await candidate.dispose()
      throw cause
    }
  }
  await authenticateWindow()
}
function startHost() {
  starting ??= initializeHost().finally(() => {
    starting = undefined
  })
  return starting
}
function trustedOrigin() {
  return !disposing && uiUrl && localHost && !invalidatedHostLeases.has(localHost) ? new URL(uiUrl).origin : ''
}
async function controlOrigins() {
  const { origins } = await rpc<{ origins: string[] }>('host:control-origins')
  if (!Array.isArray(origins)) throw new Error('Host 控制面地址清单无效')
  return [
    ...new Set(
      [uiUrl, localHost?.url]
        .filter((value): value is string => !!value)
        .map((value) => new URL(value).origin)
        .concat(origins),
    ),
  ]
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
    lastConnectionError = {
      local: true,
      message: cause instanceof Error ? cause.message : String(cause),
      pairingUrl: localHost?.ownership === 'attached' ? localHost.url : undefined,
    }
    if (!target.isDestroyed() && target.webContents.getURL() !== recoveryUrl) await target.loadURL(recoveryUrl)
    throw new Error(`本机服务连接失败：${String(cause)}`)
  }
}
async function setConnection(value: { url: string; token: string; save?: boolean } | null) {
  if (switching) throw new Error('正在登记远程服务，请等待完成')
  switching = true
  try {
    const lease = localHost
    if (value && lease?.ownership === 'attached' && new URL(value.url).origin === lease.url) {
      if (!value.token.trim() || value.token.length > 4096) throw new Error('请输入有效访问令牌')
      assertHostLease(lease)
      const candidate = await createNodeHostClient({
        url: lease.url,
        token: value.token,
        hostId: lease.status.hostId,
        clientId: 'desktop-platform',
      })
      try {
        assertHostLease(lease)
        await pairings.save(lease.url, lease.status.hostId, value.token, value.save !== false)
        assertHostLease(lease)
        const previous = hostClient
        hostClient = candidate
        previous?.dispose()
      } catch (cause) {
        candidate.dispose()
        throw cause
      }
      await startHost()
      lastConnectionError = null
      await retryConnection()
      return
    }
    await startHost()
    if (value) await rpc('host:services:register', [value])
    lastConnectionError = null
  } catch (cause) {
    const local = Boolean(value && localHost?.ownership === 'attached' && new URL(value.url).origin === localHost.url)
    lastConnectionError = {
      local,
      message: cause instanceof Error ? cause.message : String(cause),
      pairingUrl: local ? localHost?.url : undefined,
    }
    throw new Error(`${local ? '本机服务配对失败' : '远程服务登记失败'}：${String(cause)}`)
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
      lastConnectionError = {
        local: true,
        message: cause instanceof Error ? cause.message : String(cause),
        pairingUrl: localHost?.ownership === 'attached' ? localHost.url : undefined,
      }
      console.error(`服务初始化失败：${String(cause)}`)
    }
    registerBrowserRuntime({ getWindow: () => window, origin: trustedOrigin, controlOrigins, rpc })
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
    contents?.removeListener('will-prevent-unload', cancelQuit)
    cancelWindowPreparation(target)
    stopping = false
  }
  function dispose() {
    disposing = true
    contents?.removeListener('will-prevent-unload', cancelQuit)
    const lease = localHost
    if (lease) invalidateHostLease(lease)
    else if (ownerBrowserSession) clearOwnerCookieScope(ownerBrowserSession)
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
    void closePreparedWindow(target, 'quit').then(
      (allowed) => {
        if (!allowed) cancelQuit()
      },
      (cause: unknown) => {
        console.error(`退出准备失败：${String(cause)}`)
        cancelQuit()
      },
    )
  } else dispose()
})
