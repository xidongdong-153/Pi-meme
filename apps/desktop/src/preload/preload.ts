import { contextBridge, ipcRenderer } from 'electron'
import type { PlatformAdapter } from '@pi-meme/contracts/host'

const platform: PlatformAdapter = {
  getHostConnection: () => ipcRenderer.invoke('platform:connection'),
  retryHostConnection: () => ipcRenderer.invoke('platform:retry-connection'),
  setHostConnection: (value) => ipcRenderer.invoke('platform:set-connection', value),
  chooseDirectory: () => ipcRenderer.invoke('platform:directory'),
  getProjectApps: () => ipcRenderer.invoke('platform:project-apps'),
  openProject: (app, cwd) => ipcRenderer.invoke('platform:open-project', app, cwd),
  importTheme: () => ipcRenderer.invoke('platform:import-theme'),
  exportTheme: (theme) => ipcRenderer.invoke('platform:export-theme', theme),
  openPath: (path) => ipcRenderer.invoke('platform:open-path', path),
}
contextBridge.exposeInMainWorld('piPlatform', platform)
