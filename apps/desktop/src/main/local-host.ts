import { app, utilityProcess, type UtilityProcess } from 'electron'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { defaultDevelopmentHostPort, defaultHostPort, hostPort, localHostUrl } from '@pi-meme/contracts/host-runtime'
import { acquireLocalHost } from '@pi-meme/host/local-host'
import { prepareDesktopHostEnv } from './user-login-path'

export type DesktopHostProcess = {
  url: string
  child: UtilityProcess
  prepareMaintenance: () => Promise<void>
  stopForMaintenance: () => Promise<void>
  dispose: () => Promise<void>
}

function launchHost(entry: string, env: NodeJS.ProcessEnv): Promise<DesktopHostProcess> {
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(entry, [], { serviceName: 'Pi Meme Host', env, stdio: 'pipe' })
    let exited = false
    let exitCode: number | undefined
    let hostId = ''
    let startupError: Error | undefined
    let disposing: Promise<void> | undefined
    const requests = new Map<string, { resolve: () => void; reject: (cause: Error) => void; timer: NodeJS.Timeout }>()
    const startup = setTimeout(() => {
      startupError ??= new Error('本机服务启动超时')
      void terminate().catch(reject)
    }, 30000)
    child.stderr?.on('data', (data: Buffer) => console.error(data.toString()))
    function waitForExit(timeoutMs: number) {
      if (exited) return Promise.resolve(exitCode)
      return new Promise<number | undefined>((resolve) => {
        let timer: NodeJS.Timeout
        const onExit = (code: number) => {
          clearTimeout(timer)
          resolve(code)
        }
        timer = setTimeout(() => {
          child.removeListener('exit', onExit)
          resolve(undefined)
        }, timeoutMs)
        child.once('exit', onExit)
      })
    }
    async function terminate() {
      if (exited) return
      child.kill()
      if ((await waitForExit(2_000)) !== undefined) return
      if (child.pid !== undefined) {
        try {
          process.kill(child.pid, 'SIGKILL')
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') throw cause
        }
      }
      if ((await waitForExit(5_000)) === undefined) throw new Error('本机 Host 进程尚未退出')
    }
    async function stop(timeoutMs: number, force: boolean) {
      if (exited && force) return
      if (!exited) {
        try {
          child.postMessage({ type: 'stop', hostId })
        } catch (cause) {
          if (force) return terminate()
          throw cause
        }
      }
      const code = await waitForExit(timeoutMs)
      if (code === 0) return
      if (code !== undefined) throw new Error(`服务未正常退出（${code}）`)
      if (force) return terminate()
      throw new Error('服务正常停机超时，维护已取消；不会强制终止后迁移')
    }
    child.on(
      'message',
      (value: {
        type: string
        url: string
        hostId: string
        id: string
        message?: string
        error?: string
        code?: string
      }) => {
        if (value.type === 'ready' && !startupError) {
          clearTimeout(startup)
          hostId = value.hostId
          resolve({
            url: value.url,
            child,
            prepareMaintenance: () =>
              new Promise<void>((resolve, reject) => {
                if (exited) {
                  reject(new Error('本机服务已退出'))
                  return
                }
                const id = randomUUID()
                const timer = setTimeout(() => {
                  requests.delete(id)
                  reject(new Error('本机服务维护准备超时'))
                }, 10000)
                requests.set(id, { resolve, reject, timer })
                child.postMessage({ type: 'maintenance:prepare', id, hostId })
              }),
            stopForMaintenance: () => stop(60000, false),
            dispose() {
              disposing ??= stop(10000, true).catch((cause: unknown) => {
                disposing = undefined
                throw cause
              })
              return disposing
            },
          })
        }
        if (value.type === 'failed') {
          startupError = Object.assign(new Error(value.message ?? '服务启动失败'), { code: value.code })
        }
        if (value.type === 'maintenance:result') {
          const request = requests.get(value.id)
          if (!request) return
          requests.delete(value.id)
          clearTimeout(request.timer)
          if (value.error) request.reject(new Error(value.error))
          else request.resolve()
        }
      },
    )
    child.once('exit', (code) => {
      exitCode = code
      exited = true
      clearTimeout(startup)
      const cause = new Error(`本机服务已退出（${code}）`)
      for (const request of requests.values()) {
        clearTimeout(request.timer)
        request.reject(cause)
      }
      requests.clear()
      reject(startupError ?? cause)
    })
  })
}

export function acquireDesktopHost(options: { entry: string; env: NodeJS.ProcessEnv; dataRoot: string }) {
  const port = hostPort(options.env.PI_MEME_PORT, app.isPackaged ? defaultHostPort : defaultDevelopmentHostPort)
  const create = async (listenPort: number) =>
    launchHost(options.entry, {
      ...(await prepareDesktopHostEnv(options.env)),
      PI_MEME_PORT: String(listenPort),
      PI_MEME_DATA_ROOT: options.dataRoot,
      PI_MEME_PLUGIN_NODE: app.isPackaged
        ? path.join(process.resourcesPath, 'runtime/bin', process.platform === 'win32' ? 'node.exe' : 'node')
        : (options.env.PI_MEME_PLUGIN_NODE ?? ''),
      PI_MEME_PLUGIN_ENTRY: app.isPackaged
        ? path.join(process.resourcesPath, 'runtime/restricted-entry.mjs')
        : (options.env.PI_MEME_PLUGIN_ENTRY ?? ''),
      ...(app.isPackaged && process.platform === 'win32'
        ? { PI_MEME_WINDOWS_NATIVE: path.join(process.resourcesPath, 'runtime/bin/pi-meme-windows.exe') }
        : {}),
    })
  return acquireLocalHost({
    url: localHostUrl(port),
    dataRoot: options.dataRoot,
    create: () => create(port),
    createOnFreePort: app.isPackaged && options.env.PI_MEME_PORT === undefined ? () => create(0) : undefined,
  })
}
