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
    let disposing: Promise<void> | undefined
    const requests = new Map<string, { resolve: () => void; reject: (cause: Error) => void; timer: NodeJS.Timeout }>()
    const startup = setTimeout(() => {
      child.kill()
      reject(new Error('本机服务启动超时'))
    }, 30000)
    child.stderr?.on('data', (data: Buffer) => console.error(data.toString()))
    function stop(timeoutMs: number, force: boolean) {
      if (exited)
        return !force && exitCode !== 0 ? Promise.reject(new Error(`服务未正常退出（${exitCode}）`)) : Promise.resolve()
      return new Promise<void>((resolve, reject) => {
        let timer: NodeJS.Timeout
        const onExit = (code: number) => {
          clearTimeout(timer)
          if (code === 0) resolve()
          else reject(new Error(`服务未正常退出（${code}）`))
        }
        timer = setTimeout(() => {
          child.removeListener('exit', onExit)
          if (force) child.kill()
          reject(new Error(force ? '本机服务停机超时' : '服务正常停机超时，维护已取消；不会强制终止后迁移'))
        }, timeoutMs)
        child.once('exit', onExit)
        child.postMessage({ type: 'stop', hostId })
      })
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
        if (value.type === 'ready') {
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
              disposing ??= stop(10000, true)
              return disposing
            },
          })
        }
        if (value.type === 'failed') {
          clearTimeout(startup)
          reject(Object.assign(new Error(value.message ?? '服务启动失败'), { code: value.code }))
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
      reject(cause)
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
        ? path.join(process.resourcesPath, 'runtime/bin/node')
        : (options.env.PI_MEME_PLUGIN_NODE ?? ''),
      PI_MEME_PLUGIN_ENTRY: app.isPackaged
        ? path.join(process.resourcesPath, 'runtime/restricted-entry.mjs')
        : (options.env.PI_MEME_PLUGIN_ENTRY ?? ''),
    })
  return acquireLocalHost({
    url: localHostUrl(port),
    dataRoot: options.dataRoot,
    create: () => create(port),
    createOnFreePort: app.isPackaged && options.env.PI_MEME_PORT === undefined ? () => create(0) : undefined,
  })
}
