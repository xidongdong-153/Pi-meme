import type { Connection, DesktopError, DesktopEvent, ProjectApp } from './desktop'
import type { Theme } from './settings'
import type { DesktopStorageAdapter } from './storage'
import type { DesktopProject, PiSessionsSnapshot } from './sessions'

export type ServiceRef = { id: string; hostId: string; local: boolean; address: string }
export type ProjectRef = { serviceId: string; cwd: string }
export type SessionRef = { serviceId: string; sessionPath: string; sessionId: string }
export type HostService = ServiceRef & {
  status: 'connected' | 'disconnected' | 'connecting'
  error?: string
  projects: DesktopProject[]
  sessions?: PiSessionsSnapshot
}
export type HostServiceRegistration = { url: string; token?: string }

export type HostConnection = { url: string; token: string; hostId: string; local: boolean }
export type SavedHostConnection = { url: string; hostId: string }
export type HostConnectionError = { local: boolean; message: string }
export type CredentialImportResult = { imported: number; skipped: number; reconnectError?: string }
export type HostRpcRequest = {
  requestId: string
  clientId: string
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
export type HostEvent = { hostId: string } & (
  | { type: 'event'; value: DesktopEvent }
  | { type: 'connection'; value: Connection }
  | { type: 'error'; value: DesktopError }
  | { type: 'sessions-changed'; value?: undefined }
  | { type: 'plugins-changed'; value?: undefined }
  | { type: 'resources-changed'; value: { generation: number; cwd?: string } }
)
export type HostDirectory = { path: string; parent: string | null; entries: Array<{ name: string; path: string }> }

/** Electron 仅提供本机窗口与文件操作；业务通信由 client 使用 HTTP/WebSocket。 */
export interface PlatformAdapter {
  storage?: DesktopStorageAdapter
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
}
