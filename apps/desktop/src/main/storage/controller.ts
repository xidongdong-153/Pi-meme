import { app, BrowserWindow, dialog, shell } from 'electron'
import { mkdir, realpath, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  DesktopStorageAdapter,
  DesktopStorageInfo,
  StorageProgress,
  StorageTarget,
} from '@pi-meme/contracts/storage'
import {
  readStoragePreferences,
  writeStoragePreferences,
  type StoragePreferences,
  type StorageJob,
} from './preferences'
import { runStorageProcess } from './process'

export function createStorageController(options: {
  anchor: string
  override?: string
  defaultRoot?: string
  getWindow: () => BrowserWindow | null
  getHostId: () => string | undefined
  ownsHost: () => boolean
  stopHost: () => Promise<void>
  recoverHost?: () => Promise<void>
}) {
  const file = path.join(options.anchor, 'storage-location.json')
  const defaultRoot = options.defaultRoot ?? path.join(homedir(), '.pi-meme')
  let preferences: StoragePreferences = { version: 1, backupPaths: [] }
  let root = path.resolve(options.override ?? defaultRoot)
  let busy = false
  let chosen: StorageTarget | null = null
  const assertHost = (hostId: string) => {
    if (typeof hostId !== 'string' || hostId !== options.getHostId())
      throw new Error('存储操作必须指向 Desktop 当前连接的本机服务')
  }
  const assertManaged = (hostId: string) => {
    assertHost(hostId)
    if (!options.ownsHost()) throw new Error('当前服务由其他入口管理，不能从 Desktop 维护')
    if (options.override !== undefined) throw new Error('数据目录由 PI_MEME_DATA_ROOT 管理，不能从界面维护')
    if (busy || preferences.pending) throw new Error('已有存储维护任务，请等待完成')
  }
  async function schedule(job: StorageJob) {
    busy = true
    try {
      await options.stopHost()
      preferences = { ...preferences, dataRoot: preferences.dataRoot ?? root, pending: job, lastError: undefined }
      await writeStoragePreferences(file, preferences)
      app.relaunch()
      app.exit(0)
    } catch (cause) {
      preferences = {
        ...preferences,
        pending: undefined,
        lastError: cause instanceof Error ? cause.message : String(cause),
      }
      await writeStoragePreferences(file, preferences)
      await options.recoverHost?.().catch(() => {})
      throw cause
    } finally {
      busy = false
    }
  }
  const adapter: DesktopStorageAdapter = {
    async getInfo(hostId): Promise<DesktopStorageInfo> {
      assertHost(hostId)
      let cacheBytes: number | null = null
      let cacheError: string | undefined
      try {
        cacheBytes = await runStorageProcess<number>({ type: 'info', root, anchor: options.anchor })
      } catch (cause) {
        cacheError = cause instanceof Error ? cause.message : String(cause)
      }
      return {
        hostId,
        dataRoot: root,
        source:
          options.override !== undefined
            ? 'environment'
            : preferences.dataRoot && preferences.dataRoot !== defaultRoot
              ? 'custom'
              : 'default',
        canMaintain: options.ownsHost() && options.override === undefined && !busy && !preferences.pending,
        maintenanceDisabledReason: !options.ownsHost()
          ? '当前服务由其他入口管理，不能从 Desktop 维护。'
          : options.override !== undefined
            ? '由 PI_MEME_DATA_ROOT 管理，不能从界面维护。'
            : busy || preferences.pending
              ? '已有存储维护任务，请等待完成。'
              : undefined,
        cacheBytes,
        cacheError,
        backupPaths: preferences.backupPaths,
        lastError: preferences.lastError,
      }
    },
    async chooseTarget(hostId) {
      assertManaged(hostId)
      const window = options.getWindow()
      if (!window) throw new Error('桌面窗口已关闭')
      busy = true
      chosen = null
      try {
        const result = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] })
        if (result.canceled || !result.filePaths[0]) return null
        const target = result.filePaths[0]
        const failed = preferences.failedJob
        const preview = await runStorageProcess<Omit<StorageTarget, 'selectionId'>>({
          type: 'preview',
          root,
          target,
          anchor: options.anchor,
          retryId:
            failed?.kind === 'migrate' && failed.target === target && failed.source === root ? failed.id : undefined,
        })
        assertHost(hostId)
        chosen = { ...preview, selectionId: randomUUID() }
        return chosen
      } finally {
        busy = false
      }
    },
    async migrate(input) {
      assertManaged(input?.expectedHostId)
      if (!chosen || chosen.selectionId !== input.selectionId) throw new Error('请先通过目录选择器选择迁移目标')
      const failed = preferences.failedJob
      const target = chosen.path
      chosen = null
      await schedule({
        id: failed?.kind === 'migrate' && failed.target === target && failed.source === root ? failed.id : randomUUID(),
        kind: 'migrate',
        source: root,
        hostId: input.expectedHostId,
        target,
      })
    },
    async clearCache(hostId) {
      assertManaged(hostId)
      await schedule({ id: randomUUID(), kind: 'cache', source: root, hostId })
    },
    async openDirectory(input) {
      assertHost(input?.expectedHostId)
      if (typeof input.path !== 'string' || ![root, ...preferences.backupPaths].includes(input.path))
        throw new Error('只能打开当前数据目录或已登记的迁移备份')
      const error = await shell.openPath(await realpath(input.path))
      if (error) throw new Error(`无法打开存储目录：${error}`)
    },
  }
  return {
    adapter,
    get root() {
      return root
    },
    get busy() {
      return busy
    },
    async initialize() {
      await mkdir(options.anchor, { recursive: true })
      if (options.override !== undefined) return
      preferences = await readStoragePreferences(file)
      if (preferences.pending) {
        busy = true
        try {
          await runPending(preferences.pending)
          preferences = await readStoragePreferences(file)
          if (preferences.pending) throw new Error(preferences.lastError ?? '存储维护尚未完成，无法启动应用')
          app.relaunch()
          app.exit(0)
          await new Promise<void>(() => {})
        } finally {
          busy = false
        }
      }
      await rm(path.join(options.anchor, 'storage-maintenance-session'), { recursive: true, force: true })
      root = path.resolve(preferences.dataRoot ?? defaultRoot)
      if (preferences.dataRoot && !(await stat(root).catch(() => undefined))?.isDirectory())
        throw new Error(`自定义存储目录不可用：${root}。请重新连接磁盘后重试；不会创建空目录`)
    },
  }
  async function runPending(job: StorageJob) {
    const window = new BrowserWindow({
      width: 560,
      height: 280,
      resizable: false,
      closable: false,
      title: '存储维护',
      webPreferences: {
        partition: `storage-maintenance-${job.id}`,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    window.setMenu(null)
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event) => event.preventDefault())
    await window.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><style>body{font:15px system-ui;margin:32px;background:#171717;color:#eee}p{color:#aaa;line-height:1.6}progress{width:100%}</style><h1>正在维护存储</h1><p>请勿关闭应用或断开磁盘。</p><p id="status" role="status">正在检查任务…</p><progress aria-label="维护进度"></progress></html>')}`,
    )
    const stages: Record<StorageProgress['stage'], string> = {
      scanning: '正在统计文件',
      copying: '正在复制文件',
      verifying: '正在校验副本',
      relocating: '正在修复数据关联',
      cleaning: '正在清理缓存',
      complete: '维护完成',
    }
    let lastPaint = 0
    try {
      await runStorageProcess({ type: 'run', file, anchor: options.anchor, job }, (value) => {
        if (Date.now() - lastPaint < 100 && value.stage !== 'complete') return
        lastPaint = Date.now()
        void window.webContents
          .executeJavaScript(
            `document.getElementById('status').textContent=${JSON.stringify(stages[value.stage])};${value.totalBytes > 0 ? `document.querySelector('progress').max=${value.totalBytes};document.querySelector('progress').value=${value.completedBytes};` : "document.querySelector('progress').removeAttribute('value');"}`,
          )
          .catch(() => {})
      })
    } catch (cause) {
      await dialog.showMessageBox(window, {
        type: 'error',
        title: '存储维护未完成',
        message: cause instanceof Error ? cause.message : String(cause),
        detail: '原数据未删除。请查看常规设置中的维护错误；尚未恢复的任务会阻止服务启动。',
      })
    } finally {
      window.destroy()
    }
  }
}
