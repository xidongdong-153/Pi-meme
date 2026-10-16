import { utilityProcess } from 'electron'
import path from 'node:path'
import type { StorageProgress } from '@pi-meme/contracts/storage'
import type { StorageProcessRequest } from './task'

export function runStorageProcess<T>(
  request: StorageProcessRequest,
  onProgress?: (value: StorageProgress) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const child = utilityProcess.fork(path.join(__dirname, 'storage-process.js'), [], {
      serviceName: 'Pi Meme Storage',
      stdio: 'pipe',
    })
    let settled = false
    const timer =
      request.type === 'run'
        ? undefined
        : setTimeout(() => {
            settled = true
            child.kill()
            reject(new Error('读取存储信息超时，请重试'))
          }, 10 * 60_000)
    child.on('message', (value: { type: string; result?: T; message?: string; value?: StorageProgress }) => {
      if (value.type === 'progress' && value.value) onProgress?.(value.value)
      if (value.type !== 'result' && value.type !== 'error') return
      clearTimeout(timer)
      settled = true
      if (value.type === 'error') reject(new Error(value.message ?? '存储维护失败'))
      else resolve(value.result as T)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (!settled) reject(new Error(`存储维护进程异常退出（${code}）；未完成任务将在下次启动检查`))
    })
    child.postMessage(request)
  })
}
