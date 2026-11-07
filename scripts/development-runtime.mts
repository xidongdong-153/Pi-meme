import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  createRuntimeSnapshot,
  readRuntimeSnapshot,
  type RuntimeSnapshotPaths,
} from '../packages/host/src/runtime-snapshot'
import { defaultDevelopmentHostPort } from '../packages/contracts/src/host-runtime'
import { prepareWindowsNative, windowsNativePath } from './windows-native.mjs'
import { readStoragePreferences } from '../apps/desktop/src/main/storage/preferences'
import { assertStorageLayout } from '../packages/host/src/storage/upgrade'

const execute = promisify(execFile)
const repo = fileURLToPath(new URL('..', import.meta.url))
let pending: Promise<RuntimeSnapshotPaths> | undefined

/** Explicit finite startup compilation. Never watch, rebuild on request, or retain repository dependency links. */
export function prepareDevelopmentRuntime(options: { desktop?: boolean } = {}): Promise<RuntimeSnapshotPaths> {
  pending ??= (async () => {
    process.env.NODE_ENV = 'development'
    if (['memory', 'file'].includes(process.env.PI_MEME_TEST_CREDENTIALS ?? '') && !process.env.PI_MEME_DATA_ROOT)
      throw new Error('开发验收必须显式指定临时 PI_MEME_DATA_ROOT，不使用真实用户数据目录')
    process.env.PI_MEME_PORT ??= String(defaultDevelopmentHostPort)
    if (process.env.PI_MEME_DATA_ROOT === undefined && options.desktop) {
      const appData =
        process.platform === 'darwin'
          ? path.join(homedir(), 'Library/Application Support')
          : (process.env.APPDATA ?? path.join(homedir(), 'AppData/Roaming'))
      const preferences = await readStoragePreferences(path.join(appData, 'pi-meme-dev/storage-location.json'))
      process.env.PI_MEME_DATA_ROOT = preferences.dataRoot ?? path.join(homedir(), '.pi-meme-dev')
    }
    process.env.PI_MEME_DATA_ROOT ??= path.join(homedir(), '.pi-meme-dev')
    const dataRoot = path.resolve(process.env.PI_MEME_DATA_ROOT)
    await assertStorageLayout(dataRoot)
    let snapshot: RuntimeSnapshotPaths
    if (process.env.PI_MEME_RUNTIME_SNAPSHOT)
      snapshot = await readRuntimeSnapshot(process.env.PI_MEME_RUNTIME_SNAPSHOT, dataRoot)
    else {
      if (process.platform === 'win32' && !process.env.PI_MEME_WINDOWS_NATIVE) {
        await prepareWindowsNative()
        process.env.PI_MEME_WINDOWS_NATIVE = windowsNativePath
      }
      console.log('构建固定开发运行时与静态界面；本次运行不监听源码，下次显式启动时更新。')
      snapshot = await createRuntimeSnapshot({
        dataRoot,
        prepare: async (directory) => {
          const env: NodeJS.ProcessEnv = {}
          for (const key of [
            'PATH',
            'HOME',
            'USERPROFILE',
            'LOCALAPPDATA',
            'APPDATA',
            'TMPDIR',
            'TMP',
            'TEMP',
            'SystemRoot',
            'WINDIR',
            'COMSPEC',
            'PATHEXT',
            'PI_MEME_WINDOWS_NATIVE',
          ])
            if (process.env[key] !== undefined) env[key] = process.env[key]
          env.NODE_ENV = 'production'
          const { stdout, stderr } = await execute(
            process.execPath,
            [
              '--import',
              import.meta.resolve('tsx'),
              fileURLToPath(new URL('./build-development-runtime.mts', import.meta.url)),
              directory,
              options.desktop ? 'desktop' : 'server',
            ],
            { cwd: repo, env, timeout: 5 * 60 * 1000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
          )
          if (stdout) process.stdout.write(stdout)
          if (stderr) process.stderr.write(stderr)
        },
      })
    }
    if (options.desktop) await access(snapshot.desktopPath)
    process.env.PI_MEME_DATA_ROOT = dataRoot
    process.env.PI_MEME_RUNTIME_SNAPSHOT = snapshot.root
    process.env.PI_MEME_WORKER_PATH = snapshot.workerPath
    process.env.PI_MEME_WEB_ROOT = snapshot.staticDirectory
    process.env.PI_MEME_BUILTIN_SKILLS_SOURCE = snapshot.skillsDirectory
    process.env.PI_MEME_PLUGIN_NODE = snapshot.nodePath
    process.env.PI_MEME_PLUGIN_ENTRY = snapshot.restrictedEntry
    delete process.env.PI_MEME_FRONTEND_URL
    delete process.env.PI_DESKTOP_DEV_SERVER_URL
    if (process.platform === 'win32') process.env.PI_MEME_WINDOWS_NATIVE = snapshot.windowsNativePath
    return snapshot
  })()
  return pending
}
