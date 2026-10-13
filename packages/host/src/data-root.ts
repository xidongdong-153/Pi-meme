import { mkdir, readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import lockfile from 'proper-lockfile'
import { windowsMounts } from '@pi-meme/pi-runtime/sdk/linux-sandbox'
import { pathWithin } from '@pi-meme/pi-runtime/sdk/access-sandbox'

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
      lockfilePath: path.join(root, 'host.lock'),
      stale: 30000,
      update: 5000,
      retries: 0,
    })
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ELOCKED') throw new Error(`此数据目录已有 Host：${root}`)
    throw cause
  }
}
