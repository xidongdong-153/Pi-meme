import { readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { optionalStat, physicalPath } from './files'

const hostCaches = [
  'sessions-cache.json',
  'sessions-cache.json.tmp',
  'remote-services.json',
  'remote-services.json.tmp',
]
const desktopCaches = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnCache',
  'ShaderCache',
  'GrShaderCache',
  'GraphiteDawnCache',
]

async function cachePaths(root: string, anchor: string) {
  const targets: string[] = []
  for (const [directory, names] of [
    [root, hostCaches],
    [anchor, desktopCaches],
  ] as const) {
    if (!(await optionalStat(directory))) continue
    for (const name of names) {
      const target = await physicalPath(directory, name)
      if (target) targets.push(target)
    }
  }
  return targets
}
async function bytes(file: string): Promise<number> {
  const info = await optionalStat(file)
  if (!info) return 0
  if (info.isSymbolicLink()) throw new Error(`缓存含有符号链接，未清理：${file}`)
  if (info.isFile()) return info.size
  if (!info.isDirectory()) throw new Error(`缓存含有特殊文件，未清理：${file}`)
  let total = 0
  for (const name of await readdir(file)) total += await bytes(path.join(file, name))
  return total
}
export async function cacheSize(root: string, anchor: string) {
  let total = 0
  for (const file of await cachePaths(root, anchor)) total += await bytes(file)
  return total
}
/** 调用方必须在停止 Host 与旧 Electron Session 后持有数据锁。 */
export async function clearCaches(root: string, anchor: string) {
  const targets = await cachePaths(root, anchor)
  for (const file of targets) await bytes(file)
  for (const file of targets) {
    try {
      await rm(file, { recursive: true, force: true })
    } catch (cause) {
      throw new Error(`缓存清理失败：${file}；${String(cause)}`, { cause })
    }
  }
}
