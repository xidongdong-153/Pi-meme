import path from 'node:path'
import { readFile } from 'node:fs/promises'
import type { StorageProgress } from '@pi-meme/contracts/storage'
import { lockDataRoot, relocatedMarker } from '@pi-meme/host/data-root'
import { readJson } from '@pi-meme/host/storage/files'
import { cacheSize, clearCaches } from '@pi-meme/host/storage/cache'
import { migrateStorage, previewMigration } from '@pi-meme/host/storage/migrate'
import { readStoragePreferences, writeStoragePreferences, type StorageJob } from './preferences'

export type StorageProcessRequest =
  | { type: 'info'; root: string; anchor: string }
  | { type: 'preview'; root: string; target: string; anchor: string; retryId?: string }
  | { type: 'run'; file: string; anchor: string; job: StorageJob }

export async function executeStorageTask(request: StorageProcessRequest, progress: (value: StorageProgress) => void) {
  if (request.type === 'info') return cacheSize(request.root, request.anchor)
  if (request.type === 'preview') return previewMigration(request.root, request.target, request.anchor, request.retryId)
  const { job, file, anchor } = request
  const preferences = await readStoragePreferences(file)
  if (preferences.pending?.id !== job.id || JSON.stringify(preferences.pending) !== JSON.stringify(job))
    throw new Error('存储维护任务已变化')
  try {
    if (job.kind === 'migrate') {
      if (!job.target) throw new Error('迁移目标缺失')
      const next = {
        version: 1 as const,
        dataRoot: job.target,
        backupPaths: [...new Set([...preferences.backupPaths, job.source])],
      }
      await migrateStorage({
        source: job.source,
        target: job.target,
        anchor,
        id: job.id,
        hostId: job.hostId,
        progress,
        isCommitted: async () => (await readStoragePreferences(file)).dataRoot === job.target,
        commit: () => writeStoragePreferences(file, { ...next, pending: job }),
      })
      await writeStoragePreferences(file, next)
    } else {
      const release = await lockDataRoot(job.source)
      try {
        if ((await readFile(path.join(job.source, 'host-id'), 'utf8')).trim() !== job.hostId)
          throw new Error('维护目标服务身份不匹配')
        progress({ stage: 'cleaning', completedBytes: 0, totalBytes: 0 })
        await clearCaches(job.source, anchor)
        await writeStoragePreferences(file, {
          ...preferences,
          pending: undefined,
          failedJob: undefined,
          lastError: undefined,
        })
      } finally {
        await release()
      }
    }
  } catch (cause) {
    const current = await readStoragePreferences(file)
    const message = cause instanceof Error ? cause.message : String(cause)
    // 配置已发布时不能倒退到旧目录；仍有来源维护标记时必须保留恢复任务。
    if (
      (current.dataRoot === job.target && job.kind === 'migrate') ||
      cause instanceof AggregateError ||
      (await readJson<{ id?: string }>(path.join(job.source, relocatedMarker)))?.id === job.id
    ) {
      await writeStoragePreferences(file, { ...current, lastError: message })
    } else {
      await writeStoragePreferences(file, { ...current, pending: undefined, failedJob: job, lastError: message })
    }
    throw cause
  }
  return null
}
