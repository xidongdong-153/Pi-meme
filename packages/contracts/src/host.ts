import type { BrowserPlatform } from './browser'
import type { Connection, DesktopError, DesktopEvent, ProjectApp } from './desktop'
import type { Theme } from './settings'
import type { DesktopStorageAdapter } from './storage'
import type { DesktopProject, PiSessionsSnapshot } from './sessions'
import type { ShortcutPreferences } from './keyboard-shortcuts'
import type { SshConnectionPhase, SshConnectionStep } from './ssh-connections'

export type ServiceRef = { id: string; hostId: string; local: boolean; address: string }
export type ProjectRef = { serviceId: string; cwd: string }
export type SessionRef = { serviceId: string; sessionPath: string; sessionId: string }
export type ServiceConnectionStatus = 'connected' | 'disconnected' | 'connecting'
export type HostService = ServiceRef & {
  /** 本机 Host 观察到的远端状态；SSH 取自隧道状态机。 */
  status: ServiceConnectionStatus
  error?: string
  transport?: 'https' | 'ssh'
  name?: string
  enabled?: boolean
  phase?: SshConnectionPhase
  step?: SshConnectionStep
  errorCode?: string
  nextRetryAt?: string
  projects: DesktopProject[]
  sessions?: PiSessionsSnapshot
}
/** 客户端对服务的投影。本机服务没有上游 Host 状态，WebSocket 可达性仅对当前客户端有效。 */
export type ClientService = Omit<HostService, 'status'> & {
  status?: ServiceConnectionStatus
  clientStatus: ServiceConnectionStatus
  clientError?: string
}
export type HostServiceRegistration = { url: string; token?: string }

export type HostConnection = { url: string; token: string; hostId: string; local: boolean }
export type SavedHostConnection = { url: string; hostId: string }
export type HostConnectionError = { local: boolean; message: string }
export type CredentialImportResult = { imported: number; skipped: number; reconnectError?: string }
export type HostRpcRequest = {
  requestId: string
  clientId: string
  connectionId?: string
  hostId?: string
  sessionId?: string
  method: string
  args: unknown[]
}
export type HostRpcResponse = {
  requestId: string
  hostId: string
  result?: unknown
  error?: { message: string; code: string }
}
function rpcIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
}

export function isHostRpcRequest(value: unknown): value is HostRpcRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const input = value as Partial<HostRpcRequest>
  return (
    rpcIdentifier(input.requestId) &&
    rpcIdentifier(input.clientId) &&
    typeof input.method === 'string' &&
    input.method.length > 0 &&
    Array.isArray(input.args) &&
    (input.connectionId === undefined || rpcIdentifier(input.connectionId)) &&
    (input.hostId === undefined || rpcIdentifier(input.hostId)) &&
    (input.sessionId === undefined || typeof input.sessionId === 'string')
  )
}

export function isHostRpcResponse(value: unknown): value is HostRpcResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const reply = value as Partial<HostRpcResponse>
  return (
    rpcIdentifier(reply.requestId) &&
    rpcIdentifier(reply.hostId) &&
    (reply.error === undefined ||
      (!('result' in reply) &&
        reply.error !== null &&
        typeof reply.error === 'object' &&
        typeof reply.error.code === 'string' &&
        typeof reply.error.message === 'string'))
  )
}

export type HostEvent = { hostId: string } & (
  | { type: 'system-request'; value: import('./system-tools').SystemClientRequest }
  | { type: 'system-changed'; value?: undefined }
  | { type: 'appearance-changed'; value: { revision: string } }
  | { type: 'sessions-deleted'; value: { sessionIds: string[] } }
  | { type: 'event'; value: DesktopEvent }
  | { type: 'connection'; value: Connection }
  | { type: 'error'; value: DesktopError }
  | { type: 'sessions-changed'; value?: undefined }
  | { type: 'services-changed'; value?: undefined }
  | { type: 'plugins-changed'; value?: undefined }
  | { type: 'resources-changed'; value: { generation: number; cwd?: string } }
)
export type HostDirectory = { path: string; parent: string | null; entries: Array<{ name: string; path: string }> }

export type DesktopWindowCommand =
  | 'close'
  | 'quit'
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'selectAll'
  | 'reload'
  | 'forceReload'
  | 'toggleDevTools'
  | 'resetZoom'
  | 'zoomIn'
  | 'zoomOut'
  | 'toggleFullscreen'
  | 'about'

export type PlatformPrepareRequest = {
  requestId: string
  documentGeneration: number
  reason: 'close' | 'quit' | 'reload' | 'forceReload' | 'maintenance'
}

/** Electron 仅提供本机窗口与文件操作；业务通信由 client 使用 HTTP/WebSocket。 */
export interface PlatformAdapter {
  desktopUpdates?: import('./app-update').AppUpdateReader
  computer?: import('./computer-use').ComputerPlatform
  browser?: BrowserPlatform
  lifecycle?: {
    onPrepare: (handler: (request: PlatformPrepareRequest) => Promise<void>) => () => void
    onCancel: (listener: (request: PlatformPrepareRequest) => void) => () => void
  }
  storage?: DesktopStorageAdapter
  piMigration?: import('./pi-migration').DesktopPiMigration
  titleBar?: {
    update: (value: { background: string; foreground: string }) => Promise<void>
    execute: (command: DesktopWindowCommand) => Promise<void>
  }
  listSavedHostConnections?: () => Promise<SavedHostConnection[]>
  removeSavedHostConnection?: (url: string) => Promise<void>
  getHostConnectionError?: () => Promise<HostConnectionError | null>
  retryHostConnection?: () => Promise<void>
  setHostConnection: (value: { url: string; token: string } | null) => Promise<void>
  getHostConnection: () => Promise<HostConnection>
  chooseDirectory: () => Promise<string | null>
  getPathForFile?: (file: File) => string
  getProjectApps: () => Promise<ProjectApp[]>
  openProject: (app: ProjectApp['id'], cwd: string) => Promise<void>
  importTheme: () => Promise<unknown | null>
  exportTheme: (theme: Theme) => Promise<void>
  openPath: (path: string) => Promise<void>
  workspaceView?: {
    read: () => Promise<boolean | null>
    save: (unified: boolean) => Promise<void>
  }
  shortcuts?: {
    read: () => Promise<ShortcutPreferences>
    save: (value: ShortcutPreferences) => Promise<void>
  }
}
