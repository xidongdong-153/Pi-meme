import type { Connection, DesktopError, DesktopEvent, ProjectApp } from './desktop'
import type { Theme } from './settings'

export type HostConnection = { url: string; token: string; hostId: string; local: boolean }
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
)
export type HostDirectory = { path: string; parent: string | null; entries: Array<{ name: string; path: string }> }

/** Electron 仅提供本机窗口与文件操作；业务通信由 client 使用 HTTP/WebSocket。 */
export interface PlatformAdapter {
  retryHostConnection?: () => Promise<void>
  setHostConnection: (value: { url: string; token: string } | null) => Promise<void>
  getHostConnection: () => Promise<HostConnection>
  chooseDirectory: () => Promise<string | null>
  getProjectApps: () => Promise<ProjectApp[]>
  openProject: (app: ProjectApp['id'], cwd: string) => Promise<void>
  importTheme: () => Promise<unknown | null>
  exportTheme: (theme: Theme) => Promise<void>
  openPath: (path: string) => Promise<void>
}
