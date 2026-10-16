import { executeStorageTask, type StorageProcessRequest } from './storage/task'

const parent = (
  process as NodeJS.Process & {
    parentPort?: {
      postMessage: (value: unknown) => void
      once: (event: 'message', listener: (event: { data: StorageProcessRequest }) => void) => void
    }
  }
).parentPort
if (!parent) throw new Error('存储维护进程必须由 Desktop 启动')
// 只在此离线进程禁用虚拟 ASAR 文件系统，用户数据中的 .asar 仍按普通物理文件复制。
Object.assign(process, { noAsar: true })
parent.once('message', ({ data }) => {
  void executeStorageTask(data, (value) => parent.postMessage({ type: 'progress', value })).then(
    (result) => {
      parent.postMessage({ type: 'result', result })
      process.exit(0)
    },
    (cause: unknown) => {
      parent.postMessage({ type: 'error', message: cause instanceof Error ? cause.message : String(cause) })
      process.exit(1)
    },
  )
})
