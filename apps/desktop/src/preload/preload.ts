import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { PlatformAdapter } from '@pi-meme/contracts/host'

const platform: PlatformAdapter = {
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
}
contextBridge.exposeInMainWorld('piPlatform', platform)
