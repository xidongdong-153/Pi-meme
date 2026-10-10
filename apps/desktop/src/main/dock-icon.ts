import { app, nativeImage, nativeTheme } from 'electron'
import path from 'node:path'

const files = {
  dark: 'pi-dev-dark-512x512.png',
  light: 'pi-dev-light-512x512.png',
} as const

/** 按当前主题的明暗切换 Dock 图标。打包后图标由 extraResource 放在 Resources/dock 下 */
export function syncDockIcon() {
  if (process.platform !== 'darwin' || !app.dock) return
  const directory = app.isPackaged
    ? path.join(process.resourcesPath, 'dock')
    : path.join(app.getAppPath(), 'assets/dock')
  const appearance = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  app.dock.setIcon(nativeImage.createFromPath(path.join(directory, files[appearance])))
}
