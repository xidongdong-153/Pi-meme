import { app, dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import { readFile, writeFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { HostConnection, HostConnectionError, SavedHostConnection } from '@pi-meme/contracts/host'
import { isTrustedPlatformSource } from './platform-source'
import type { DesktopStorageAdapter } from '@pi-meme/contracts/storage'
import { getProjectApps, openProjectInApp } from '../project-apps'
import { readShortcutPreferences, writeShortcutPreferences } from '../shortcut-preferences'

export function registerPlatformIpc(
  getWindow: () => BrowserWindow | null,
  getConnection: () => Promise<HostConnection>,
  getTrustedOrigin: () => string,
  setConnection: (value: { url: string; token: string } | null) => Promise<void>,
  retryConnection: () => Promise<void>,
  savedConnections: {
    list: () => Promise<SavedHostConnection[]>
    remove: (url: string) => Promise<void>
    error: () => HostConnectionError | null
  },
  storage?: DesktopStorageAdapter,
  userDataDir?: string,
) {
  const handle = (channel: string, action: (...args: unknown[]) => unknown) =>
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      const window = getWindow()
      if (
        !window ||
        event.sender !== window.webContents ||
        event.senderFrame !== event.sender.mainFrame ||
        !isTrustedPlatformSource(event.senderFrame.url, getTrustedOrigin(), channel, args)
      )
        throw new Error('不允许此页面调用本机平台接口')
      return action(...args)
    })
  const local = async () => {
    if (!(await getConnection()).local) throw new Error('远程服务不能调用本机文件操作')
    const window = getWindow()
    if (!window) throw new Error('桌面窗口已关闭')
    return window
  }
  const openPath = async (value: unknown) => {
    await local()
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('本机路径必须是绝对路径')
    const target = await realpath(value)
    const error = await shell.openPath(target)
    if (error) throw new Error(`无法打开本机路径：${error}`)
  }
  if (storage) {
    handle('platform:storage-info', (id) => storage.getInfo(id as string))
    handle('platform:storage-choose', (id) => storage.chooseTarget(id as string))
    handle('platform:storage-migrate', (input) => {
      if (
        !input ||
        typeof input !== 'object' ||
        !('expectedHostId' in input) ||
        !('selectionId' in input) ||
        typeof input.expectedHostId !== 'string' ||
        typeof input.selectionId !== 'string'
      )
        throw new Error('存储迁移参数无效')
      return storage.migrate({ expectedHostId: input.expectedHostId, selectionId: input.selectionId })
    })
    handle('platform:storage-cache', (id) => storage.clearCache(id as string))
    handle('platform:storage-open', (input) => {
      if (
        !input ||
        typeof input !== 'object' ||
        !('expectedHostId' in input) ||
        !('path' in input) ||
        typeof input.expectedHostId !== 'string' ||
        typeof input.path !== 'string'
      )
        throw new Error('存储目录参数无效')
      return storage.openDirectory({ expectedHostId: input.expectedHostId, path: input.path })
    })
  }
  handle('platform:connection', getConnection)
  handle('platform:saved-connections', savedConnections.list)
  handle('platform:connection-error', savedConnections.error)
  handle('platform:shortcuts-read', async () => {
    return readShortcutPreferences(userDataDir ?? app.getPath('userData'))
  })
  handle('platform:shortcuts-save', async (value) => {
    return writeShortcutPreferences(userDataDir ?? app.getPath('userData'), value)
  })
  handle('platform:remove-connection', async (url) => {
    if (typeof url !== 'string') throw new Error('服务地址无效')
    await savedConnections.remove(url)
  })
  handle('platform:retry-connection', retryConnection)
  handle('platform:set-connection', async (input) => {
    if (input === null) return setConnection(null)
    if (
      !input ||
      typeof input !== 'object' ||
      !('url' in input) ||
      typeof input.url !== 'string' ||
      !('token' in input) ||
      typeof input.token !== 'string'
    )
      throw new Error('服务连接参数无效')
    const url = new URL(input.url)
    if (url.protocol !== 'https:' || url.username || url.password)
      throw new Error('远程服务必须使用 HTTPS，地址不能包含凭据')
    return setConnection({ url: url.origin, token: input.token })
  })
  handle('platform:directory', async () => {
    const result = await dialog.showOpenDialog(await local(), { properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })
  handle('platform:project-apps', async () => {
    await local()
    return getProjectApps()
  })
  handle('platform:open-path', openPath)
  handle('platform:open-project', async (id, input) => {
    await local()
    if (typeof input !== 'string' || !path.isAbsolute(input)) throw new Error('本机项目路径无效')
    const cwd = await realpath(input)
    const info = await stat(cwd)
    if (!info.isDirectory() && !info.isFile()) throw new Error('所选路径不是普通文件或文件夹')
    if (id === 'finder') return openPath(cwd)
    await openProjectInApp(id, cwd)
  })
  handle('platform:import-theme', async () => {
    const result = await dialog.showOpenDialog(await local(), {
      properties: ['openFile'],
      filters: [{ name: 'JSON 主题', extensions: ['json'] }],
    })
    return result.canceled ? null : (JSON.parse(await readFile(result.filePaths[0], 'utf8')) as unknown)
  })
  handle('platform:export-theme', async (value) => {
    if (!value || typeof value !== 'object') throw new Error('主题文件内容无效')
    const theme = value
    const result = await dialog.showSaveDialog(await local(), {
      defaultPath: 'theme.json',
      filters: [{ name: 'JSON 主题', extensions: ['json'] }],
    })
    if (!result.canceled && result.filePath) await writeFile(result.filePath, `${JSON.stringify(theme, null, 2)}\n`)
  })
  app.on('will-quit', () => {
    for (const channel of [
      'connection',
      'retry-connection',
      'saved-connections',
      'connection-error',
      'remove-connection',
      'set-connection',
      'directory',
      'project-apps',
      'open-path',
      'open-project',
      'import-theme',
      'export-theme',
      'shortcuts-read',
      'shortcuts-save',
      'storage-info',
      'storage-choose',
      'storage-migrate',
      'storage-cache',
      'storage-open',
    ])
      ipcMain.removeHandler(`platform:${channel}`)
  })
}
