import { BrowserWindow, shell } from 'electron'
import path from 'node:path'
import { recoveryUrl } from './recovery-page'
import { configureWindowsMenu } from './desktop-window'

export function createWindow(backgroundColor: string, trustedOrigin: () => string) {
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 500,
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 14 } }
      : process.platform === 'win32'
        ? {
            titleBarStyle: 'hidden' as const,
            titleBarOverlay: { color: backgroundColor, symbolColor: '#e9e9eb', height: 36 },
          }
        : {}),
    backgroundColor,
    webPreferences: {
      // Cookie 仅在本次运行中保留，避免磁盘 Cookie 加密触发系统钥匙串。
      partition: 'pi-meme-app',
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  if (process.platform === 'win32') configureWindowsMenu(window)
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
