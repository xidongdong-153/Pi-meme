import { app, Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import type { DesktopWindowCommand } from '@pi-meme/contracts/host'

export function updateTitleBar(window: BrowserWindow, value: unknown) {
  const color = /^#[\da-f]{6}$/i
  if (
    !value ||
    typeof value !== 'object' ||
    !('background' in value) ||
    !('foreground' in value) ||
    typeof value.background !== 'string' ||
    typeof value.foreground !== 'string' ||
    !color.test(value.background) ||
    !color.test(value.foreground)
  )
    throw new Error('标题栏主题参数无效')
  window.setTitleBarOverlay({ color: value.background, symbolColor: value.foreground, height: 36 })
}

export function executeWindowCommand(window: BrowserWindow, command: unknown) {
  const contents = window.webContents
  switch (command) {
    case 'close':
      return window.close()
    case 'quit':
      return app.quit()
    case 'undo':
    case 'redo':
    case 'cut':
    case 'copy':
    case 'paste':
    case 'selectAll':
      return contents[command]()
    case 'reload':
      return contents.reload()
    case 'forceReload':
      return contents.reloadIgnoringCache()
    case 'toggleDevTools':
      return contents.toggleDevTools()
    case 'resetZoom':
      return contents.setZoomLevel(0)
    case 'zoomIn':
      return contents.setZoomLevel(contents.getZoomLevel() + 0.5)
    case 'zoomOut':
      return contents.setZoomLevel(contents.getZoomLevel() - 0.5)
    case 'toggleFullscreen':
      return window.setFullScreen(!window.isFullScreen())
    case 'about':
      return app.showAboutPanel()
    default:
      throw new Error('窗口操作无效')
  }
}

export function configureWindowsMenu(window: BrowserWindow) {
  const item = (label: string, command: DesktopWindowCommand, accelerator?: string): MenuItemConstructorOptions => {
    switch (command) {
      case 'undo':
      case 'redo':
      case 'cut':
      case 'copy':
      case 'paste':
      case 'selectAll':
        return { label, role: command, accelerator }
      default:
        return { label, accelerator, click: () => executeWindowCommand(window, command) }
    }
  }
  window.setMenu(
    Menu.buildFromTemplate([
      {
        label: '文件',
        submenu: [item('关闭窗口', 'close', 'Ctrl+W'), item('退出', 'quit', 'Alt+F4')],
      },
      {
        label: '编辑',
        submenu: [
          item('撤销', 'undo', 'Ctrl+Z'),
          item('重做', 'redo', 'Ctrl+Y'),
          { type: 'separator' },
          item('剪切', 'cut', 'Ctrl+X'),
          item('复制', 'copy', 'Ctrl+C'),
          item('粘贴', 'paste', 'Ctrl+V'),
          item('全选', 'selectAll', 'Ctrl+A'),
        ],
      },
      {
        label: '视图',
        submenu: [
          item('重新加载', 'reload', 'Ctrl+R'),
          item('强制重新加载', 'forceReload', 'Ctrl+Shift+R'),
          item('开发者工具', 'toggleDevTools', 'Ctrl+Shift+I'),
          { type: 'separator' },
          item('重置缩放', 'resetZoom', 'Ctrl+0'),
          item('放大', 'zoomIn', 'Ctrl+Plus'),
          item('缩小', 'zoomOut', 'Ctrl+-'),
          { type: 'separator' },
          item('切换全屏', 'toggleFullscreen', 'F11'),
        ],
      },
      { label: '帮助', submenu: [item('关于 Pi meme', 'about')] },
    ]),
  )
  window.setAutoHideMenuBar(false)
  window.setMenuBarVisibility(false)
}
