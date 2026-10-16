import path from 'node:path'
import { readFileSync } from 'node:fs'
import { readJson, writeJson } from '@pi-meme/host/storage/files'

export type StorageJob = { id: string; kind: 'migrate' | 'cache'; source: string; hostId: string; target?: string }
export type StoragePreferences = {
  version: 1
  dataRoot?: string
  backupPaths: string[]
  pending?: StorageJob
  failedJob?: StorageJob
  lastError?: string
}
function validJob(value: StorageJob) {
  return (
    value &&
    typeof value.id === 'string' &&
    /^[\da-f-]{36}$/i.test(value.id) &&
    ['migrate', 'cache'].includes(value.kind) &&
    typeof value.hostId === 'string' &&
    Boolean(value.hostId) &&
    typeof value.source === 'string' &&
    path.isAbsolute(value.source) &&
    (value.kind !== 'migrate' || (typeof value.target === 'string' && path.isAbsolute(value.target)))
  )
}
function validatePreferences(value: StoragePreferences | undefined): StoragePreferences {
  if (value === undefined) return { version: 1, backupPaths: [] }
  if (
    !value ||
    typeof value !== 'object' ||
    value.version !== 1 ||
    !Array.isArray(value.backupPaths) ||
    value.backupPaths.some((entry) => typeof entry !== 'string' || !path.isAbsolute(entry)) ||
    (value.dataRoot !== undefined && (typeof value.dataRoot !== 'string' || !path.isAbsolute(value.dataRoot))) ||
    (value.lastError !== undefined && typeof value.lastError !== 'string') ||
    (value.pending !== undefined && !validJob(value.pending)) ||
    (value.failedJob !== undefined && !validJob(value.failedJob))
  )
    throw new Error('存储定位文件损坏，请恢复 storage-location.json 后重试；不会自动切换到空目录')
  return value
}
export async function readStoragePreferences(file: string): Promise<StoragePreferences> {
  return validatePreferences(await readJson<StoragePreferences>(file))
}
/** Electron sessionData 必须在 ready 前设置；这里只读取很小的本机定位文件。 */
export function pendingStorageJob(file: string) {
  try {
    return validatePreferences(JSON.parse(readFileSync(file, 'utf8')) as StoragePreferences).pending
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    // 正常初始化会报告损坏；此处不据此创建其他数据目录。
    return undefined
  }
}
export const writeStoragePreferences = (file: string, value: StoragePreferences) => writeJson(file, value)
