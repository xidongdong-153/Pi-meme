import { mkdir, readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import lockfile from 'proper-lockfile'
import { windowsMounts } from '@pi-meme/pi-runtime/sdk/linux-sandbox'
import { pathWithin } from '@pi-meme/pi-runtime/sdk/access-sandbox'
import { storageLayoutRelativePaths } from '@pi-meme/contracts/storage-paths'

export const relocatedMarker = '.pi-meme-relocated.json'
export const storageOwnerFile = '.pi-meme-storage-job.json'

export async function assertActiveDataRoot(root: string) {
  try {
    await readFile(path.join(root, relocatedMarker))
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    let contents: string
    try {
      contents = await readFile(path.join(root, storageOwnerFile), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const job = JSON.parse(contents) as { version?: number; stage?: string; target?: string; hostId?: string }
    if (
      job.version !== 1 ||
      job.stage !== 'committed' ||
      job.target !== (await realpath(root)) ||
      job.hostId !== (await readFile(path.join(root, storageLayoutRelativePaths.hostIdFile), 'utf8')).trim()
    )
      throw new Error('此目录是尚未提交或身份不符的迁移副本，请通过 Desktop 完成维护后使用')
    return
  }
  throw new Error(`此数据目录已迁移或正在维护，不能启动 Host：${root}。请通过 Desktop 查看当前目录或完成维护`)
}

export function hostDataRoot(value = process.env.PI_MEME_DATA_ROOT) {
  return path.resolve(value ?? path.join(homedir(), '.pi-meme'))
}

/** 原子 mkdir 锁与心跳防止两个 Host 同时写同一个数据目录。 */
export async function lockDataRoot(root: string) {
  await mkdir(root, { recursive: true, mode: 0o700 })
  if (process.platform === 'linux') {
    const resolved = await realpath(root)
    const drives = windowsMounts(await readFile('/proc/self/mountinfo', 'utf8'))
    if (drives.some((drive) => pathWithin(drive, resolved)))
      throw new Error('Host 数据目录必须位于 Linux 文件系统，请将 PI_MEME_DATA_ROOT 移入 Linux 用户目录')
  }
  try {
    return await lockfile.lock(root, {
      lockfilePath: path.join(root, storageLayoutRelativePaths.hostLockFile),
      stale: 30000,
      update: 5000,
      retries: 0,
    })
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ELOCKED')
      throw Object.assign(new Error(`此数据目录已有 Host：${root}`, { cause }), { code: 'ELOCKED' })
    throw cause
  }
}
