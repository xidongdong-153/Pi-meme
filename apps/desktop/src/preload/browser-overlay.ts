import { contextBridge, ipcRenderer } from 'electron'
import type { BrowserOverlayPlatform } from '@pi-meme/contracts/browser'

const overlay: BrowserOverlayPlatform = {
  state: () => ipcRenderer.invoke('browser:overlay-state'),
  action: (action) => ipcRenderer.invoke('browser:overlay-action', action),
  onState: (listener) => {
    const callback = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]) => listener(state)
    ipcRenderer.on('browser:overlay-update', callback)
    return () => ipcRenderer.removeListener('browser:overlay-update', callback)
  },
}
contextBridge.exposeInMainWorld('piBrowserOverlay', overlay)
