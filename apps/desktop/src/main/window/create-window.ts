import { BrowserWindow, shell } from 'electron'
import path from 'node:path'
import { recoveryUrl } from './recovery-page'

export function createWindow(backgroundColor: string, trustedOrigin: () => string) {
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 500,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (url === recoveryUrl) return
    try {
      if (!['https:', 'http:'].includes(new URL(url).protocol) || new URL(url).origin !== trustedOrigin())
        event.preventDefault()
    } catch {
      event.preventDefault()
    }
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    const value = new URL(url)
    if (['https:', 'http:'].includes(value.protocol)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  return window
}
