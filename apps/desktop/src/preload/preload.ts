import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { BrowserPlatform } from '@pi-meme/contracts/browser'
import type { DesktopWindowCommand, PlatformAdapter } from '@pi-meme/contracts/host'

function browserCall<T>(method: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke('browser:call', method, args)
}
const browser: BrowserPlatform = {
  snapshot: () => browserCall('snapshot'),
  settings: (value) => browserCall('settings', value),
  permission: (value) => browserCall('permission', value),
  agent: (owner, operation, args) => browserCall('agent', owner, operation, args),
  workspace: (owner) => browserCall('workspace', owner),
  saveWorkspace: (owner, value) => browserCall('saveWorkspace', owner, value),
  rebind: (from, to) => browserCall('rebind', from, to),
  create: (owner, id, url) => browserCall('create', owner, id, url),
  close: (id) => browserCall('close', id),
  present: (id, bounds, theme, colors, capturePreview) =>
    browserCall('present', id, bounds, theme, colors, capturePreview),
  preview: (id) => browserCall('preview', id),
  command: (id, command) => browserCall('command', id, command),
  history: (id) => browserCall('history', id),
  download: (id, action) => browserCall('download', id, action),
  chooseDownloadDirectory: () => browserCall('chooseDownloadDirectory'),
  clear: (parts) => browserCall('clear', parts),
  openLink: (url, owner) => browserCall('openLink', url, owner),
  onEvent: (listener) => {
    const callback = (_event: Electron.IpcRendererEvent, value: Parameters<typeof listener>[0]) => listener(value)
    ipcRenderer.on('browser:event', callback)
    return () => ipcRenderer.removeListener('browser:event', callback)
  },
}
const platform: PlatformAdapter = {
  browser,
  ...(process.platform === 'win32'
    ? {
        titleBar: {
          update: (value: { background: string; foreground: string }) =>
            ipcRenderer.invoke('platform:title-bar-update', value),
          execute: (command: DesktopWindowCommand) => ipcRenderer.invoke('platform:window-command', command),
        },
      }
    : {}),
  storage: {
    getInfo: (hostId) => ipcRenderer.invoke('platform:storage-info', hostId),
    chooseTarget: (hostId) => ipcRenderer.invoke('platform:storage-choose', hostId),
    migrate: (input) => ipcRenderer.invoke('platform:storage-migrate', input),
    clearCache: (hostId) => ipcRenderer.invoke('platform:storage-cache', hostId),
    openDirectory: (input) => ipcRenderer.invoke('platform:storage-open', input),
  },
  listSavedHostConnections: () => ipcRenderer.invoke('platform:saved-connections'),
  removeSavedHostConnection: (url) => ipcRenderer.invoke('platform:remove-connection', url),
  getHostConnectionError: () => ipcRenderer.invoke('platform:connection-error'),
  getHostConnection: () => ipcRenderer.invoke('platform:connection'),
  retryHostConnection: () => ipcRenderer.invoke('platform:retry-connection'),
  setHostConnection: (value) => ipcRenderer.invoke('platform:set-connection', value),
  chooseDirectory: () => ipcRenderer.invoke('platform:directory'),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  getProjectApps: () => ipcRenderer.invoke('platform:project-apps'),
  openProject: (app, cwd) => ipcRenderer.invoke('platform:open-project', app, cwd),
  importTheme: () => ipcRenderer.invoke('platform:import-theme'),
  exportTheme: (theme) => ipcRenderer.invoke('platform:export-theme', theme),
  openPath: (path) => ipcRenderer.invoke('platform:open-path', path),
  shortcuts: {
    read: () => ipcRenderer.invoke('platform:shortcuts-read'),
    save: (value) => ipcRenderer.invoke('platform:shortcuts-save', value),
  },
}
contextBridge.exposeInMainWorld('piPlatform', platform)
