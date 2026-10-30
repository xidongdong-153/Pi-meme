import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm, rmdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { WorkspaceDeletionResult } from '@pi-meme/contracts/desktop'
import type { AgentAccessStore } from '@pi-meme/pi-runtime/access-store'
import type { HostCollaborationBridge } from '@pi-meme/subagents/server/coordinator'
import type { GoalService } from '@pi-meme/goals/server/service'

export type PendingCleanupRecord = {
  version: 1
  id: string
  stage: 'prepared' | 'deleted'
  candidatePaths: string[]
  candidateKeys: string[]
  canonicalKeys: Array<[string, string]> // [path, canonicalKey]
  sessionIdsMap: Array<[string, string]> // [pathOrKey, sessionId]
  cwd?: string
  timestamp: string
}

export type PreparedDeletionContext = {
  id: string
  canonicalKeys: Map<string, string>
  sessionIdsMap: Map<string, string>
  candidateSessionIds: string[]
}

export type SessionCleanupOptions = {
  maintenanceDirectory: string
  accessStore: AgentAccessStore
  collaboration: HostCollaborationBridge
  goals?: GoalService
  detachArtifacts?: (sessionIds: string[]) => Promise<void>
  control?: {
    deleteSessions: (result: {
      deletedPaths: string[]
      deletedKeys: string[]
      deletedSessionIds?: string[]
    }) => Promise<{ deletedSessionIds: string[] }>
    lookupSessionIds: (paths: string[], keys: string[]) => Promise<Record<string, string>>
  }
  isStandaloneDirectory?: (cwd: string) => boolean
  hasWorkspaceReferences?: (cwd: string) => Promise<boolean> | boolean
}

const safeIdPattern = /^[\w-]+$/
const uuidPattern = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i

export function assertSafeId(id: string, name = 'ID'): void {
  if (!id || typeof id !== 'string' || !safeIdPattern.test(id)) {
    throw new TypeError(`非法安全 ${name}：${id}`)
  }
}

function isValidTuple(item: unknown): item is [string, string] {
  return (
    Array.isArray(item) &&
    item.length === 2 &&
    typeof item[0] === 'string' &&
    item[0].length > 0 &&
    typeof item[1] === 'string' &&
    item[1].length > 0
  )
}

function validatePendingCleanupRecord(record: unknown, expectedId: string): asserts record is PendingCleanupRecord {
  if (!record || typeof record !== 'object') {
    throw new Error('损坏的 pending 清理记录：必须为对象')
  }
  const r = record as Partial<PendingCleanupRecord>
  if (r.version !== 1) {
    throw new Error(`损坏的 pending 清理记录：版本不受支持 (${String(r.version)})`)
  }
  if (r.id !== expectedId) {
    throw new Error(`损坏的 pending 清理记录：ID 不匹配 (expected: ${expectedId}, actual: ${String(r.id)})`)
  }
  assertSafeId(r.id, 'record.id')
  if (r.stage !== 'prepared' && r.stage !== 'deleted') {
    throw new Error(`损坏的 pending 清理记录：未知阶段 (${String(r.stage)})`)
  }
  if (!Array.isArray(r.candidatePaths) || r.candidatePaths.some((p) => typeof p !== 'string' || !path.isAbsolute(p))) {
    throw new Error('损坏的 pending 清理记录：candidatePaths 必须包含绝对路径字符串')
  }
  if (!Array.isArray(r.candidateKeys) || r.candidateKeys.some((k) => typeof k !== 'string' || !k.trim())) {
    throw new Error('损坏的 pending 清理记录：candidateKeys 必须包含非空字符串')
  }
  if (
    !Array.isArray(r.canonicalKeys) ||
    r.canonicalKeys.some((item) => !isValidTuple(item) || !path.isAbsolute(item[1]))
  ) {
    throw new Error('损坏的 pending 清理记录：canonicalKeys 必须为绝对路径二元组')
  }
  const candidatesSet = new Set([...r.candidatePaths, ...r.candidateKeys])
  if (
    !Array.isArray(r.sessionIdsMap) ||
    r.sessionIdsMap.some((item) => !isValidTuple(item) || !candidatesSet.has(item[0]))
  ) {
    throw new Error('损坏的 pending 清理记录：sessionIdsMap 必须为二元组且键必须属于候选集合')
  }
  if (r.cwd !== undefined && (typeof r.cwd !== 'string' || !path.isAbsolute(r.cwd))) {
    throw new Error('损坏的 pending 清理记录：cwd 必须为绝对路径')
  }
}

async function atomicWrite(file: string, content: string) {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(content)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, file)
    if (process.platform !== 'win32') {
      const parent = await open(path.dirname(file), 'r')
      try {
        await parent.sync()
      } finally {
        await parent.close()
      }
    }
  } finally {
    await rm(temporary, { force: true })
  }
}

export class SessionCleanupService {
  constructor(private readonly options: SessionCleanupOptions) {}

  /**
   * 在物理文件删除前持久化删除意向（prepared intent）。
   * 必须在 unlink 之前落盘。通过权威 lookup 获取公开 SessionRef，禁止猜测。
   * 若 lookup 或 canonicalKey 发生非 ENOENT 错误则直接抛出，拒绝进入删除流程。
   */
  async prepare(paths: string[], cwd?: string): Promise<PreparedDeletionContext> {
    const id = randomUUID()
    const candidatePaths: string[] = []
    const candidateKeys: string[] = []
    const canonicalMap = new Map<string, string>()
    const sessionIdsMap = new Map<string, string>()

    for (const target of paths) {
      if (!target) continue
      if (target.startsWith('runtime:')) {
        candidateKeys.push(target)
      } else {
        candidatePaths.push(target)
        try {
          const canonical = await this.options.accessStore.canonicalKey(target)
          canonicalMap.set(target, canonical)
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
            canonicalMap.set(target, path.resolve(target))
          } else {
            throw cause
          }
        }
      }
    }

    if (this.options.control?.lookupSessionIds) {
      const lookupResult = await this.options.control.lookupSessionIds(candidatePaths, candidateKeys)
      if (lookupResult && typeof lookupResult === 'object') {
        for (const [target, sid] of Object.entries(lookupResult)) {
          if (sid && typeof sid === 'string') {
            sessionIdsMap.set(target, sid)
          }
        }
      }
    }

    const record: PendingCleanupRecord = {
      version: 1,
      id,
      stage: 'prepared',
      candidatePaths,
      candidateKeys,
      canonicalKeys: [...canonicalMap.entries()],
      sessionIdsMap: [...sessionIdsMap.entries()],
      cwd,
      timestamp: new Date().toISOString(),
    }

    const file = path.join(this.options.maintenanceDirectory, `pending-cleanup-${id}.json`)
    await atomicWrite(file, `${JSON.stringify(record, null, 2)}\n`)

    return {
      id,
      canonicalKeys: canonicalMap,
      sessionIdsMap,
      candidateSessionIds: [...new Set(sessionIdsMap.values())],
    }
  }

  /**
   * 在物理删除成功返回结果后调用。
   * 仅依据成功的 deletedPaths 和 deletedKeys 收窄清理范围。
   */
  async afterDelete(
    result: WorkspaceDeletionResult,
    prepared: PreparedDeletionContext,
    cwd?: string,
    options?: { destroyTemporary?: boolean },
  ): Promise<void> {
    const file = path.join(this.options.maintenanceDirectory, `pending-cleanup-${prepared.id}.json`)

    if (!result.deletedPaths.length && !result.deletedKeys.length) {
      await rm(file, { force: true })
      return
    }

    const confirmedCanonicalKeys = result.deletedPaths.map((p) => prepared.canonicalKeys.get(p) ?? p)

    const confirmedSessionIdsSet = new Set<string>()
    const confirmedSessionIdsMapEntries: Array<[string, string]> = []
    for (const p of [...result.deletedPaths, ...result.deletedKeys]) {
      const sid = prepared.sessionIdsMap.get(p)
      if (sid) {
        confirmedSessionIdsSet.add(sid)
        confirmedSessionIdsMapEntries.push([p, sid])
      }
    }

    const record: PendingCleanupRecord = {
      version: 1,
      id: prepared.id,
      stage: 'deleted',
      candidatePaths: [...result.deletedPaths],
      candidateKeys: [...result.deletedKeys],
      canonicalKeys: confirmedCanonicalKeys.map((k, i) => [result.deletedPaths[i] ?? k, k]),
      sessionIdsMap: confirmedSessionIdsMapEntries,
      cwd,
      timestamp: new Date().toISOString(),
    }

    await atomicWrite(file, `${JSON.stringify(record, null, 2)}\n`)

    await this.applyCleanup(
      record.candidatePaths,
      record.candidateKeys,
      confirmedCanonicalKeys,
      [...confirmedSessionIdsSet],
      record.cwd,
      options?.destroyTemporary,
    )
    await rm(file, { force: true })
  }

  /**
   * 启动时或维护时重放未完成的清理任务。严格校验 intent 结构，保留失败 intent 并抛出错误。
   */
  async recoverPending(): Promise<void> {
    let entries: Array<import('node:fs').Dirent>
    try {
      entries = await readdir(this.options.maintenanceDirectory, { withFileTypes: true })
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return
      throw cause
    }

    const errors: unknown[] = []

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith('pending-cleanup-') || !entry.name.endsWith('.json')) continue
      const fileId = entry.name.slice('pending-cleanup-'.length, -'.json'.length)

      const file = path.join(this.options.maintenanceDirectory, entry.name)
      try {
        const content = await readFile(file, 'utf8')
        const record = JSON.parse(content) as unknown
        validatePendingCleanupRecord(record, fileId)

        const sessionMap = new Map(record.sessionIdsMap)

        if (record.stage === 'deleted') {
          const canonicalKeys = record.canonicalKeys.map(([, c]) => c)
          const targetSessionIds = [...new Set(sessionMap.values())]
          await this.applyCleanup(
            record.candidatePaths,
            record.candidateKeys,
            canonicalKeys,
            targetSessionIds,
            record.cwd,
          )
          await rm(file, { force: true })
        } else if (record.stage === 'prepared') {
          const confirmedDeletedPaths: string[] = []
          const confirmedCanonicalMap = new Map(record.canonicalKeys)
          const confirmedCanonicalKeys: string[] = []
          const confirmedSessionIdsSet = new Set<string>()

          for (const p of record.candidatePaths) {
            try {
              await stat(p)
              // 物理文件仍然存在，未被删除，跳过
            } catch (cause) {
              if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
                confirmedDeletedPaths.push(p)
                confirmedCanonicalKeys.push(confirmedCanonicalMap.get(p) ?? p)
                const sid = sessionMap.get(p)
                if (sid) confirmedSessionIdsSet.add(sid)
              } else {
                throw cause
              }
            }
          }

          // prepared 恢复时未确认物理删除的 candidateKeys 传空保护
          if (confirmedDeletedPaths.length > 0) {
            await this.applyCleanup(
              confirmedDeletedPaths,
              [],
              confirmedCanonicalKeys,
              [...confirmedSessionIdsSet],
              record.cwd,
            )
          }
          await rm(file, { force: true })
        }
      } catch (cause) {
        errors.push(cause)
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, '部分 pending cleanup 任务恢复失败，已保留对应 intent 文件')
    }
  }

  private async applyCleanup(
    deletedPaths: string[],
    deletedKeys: string[],
    canonicalKeys: string[],
    candidateSessionIds: string[],
    cwd?: string,
    destroyTemporary?: boolean,
  ): Promise<void> {
    const sessionIdsToClean = new Set(candidateSessionIds)

    // 1. 先通知 control 清理（终结/取消排队提交，注销会话）
    if (this.options.control) {
      const controlResult = await this.options.control.deleteSessions({
        deletedPaths,
        deletedKeys,
        deletedSessionIds: [...sessionIdsToClean],
      })
      for (const sid of controlResult?.deletedSessionIds ?? []) {
        if (sid) sessionIdsToClean.add(sid)
      }
    }

    // 2. 清理 permissions 映射
    if (canonicalKeys.length > 0) {
      await this.options.accessStore.remove(canonicalKeys)
    }

    // 3. 清理 goals
    const targetSessionIds = [...sessionIdsToClean]
    if (this.options.goals && targetSessionIds.length > 0) {
      await this.options.goals.deleteSessions(targetSessionIds)
    }

    await this.options.detachArtifacts?.(targetSessionIds)

    // 4. 清理 collaboration
    await this.options.collaboration.deleteSessions({
      sessionIds: targetSessionIds,
      sessionFiles: deletedPaths,
      ...(destroyTemporary ? { destroyTemporary: true } : {}),
    })

    // 5. 保守清理真实受管且空的 standalone 目录
    if (cwd) {
      await this.cleanupStandaloneDirectory(cwd)
    }
  }

  private async cleanupStandaloneDirectory(cwd: string): Promise<void> {
    const baseName = path.basename(cwd)
    if (!uuidPattern.test(baseName)) return

    if (!this.options.isStandaloneDirectory || !this.options.isStandaloneDirectory(cwd)) {
      return
    }

    // 缺少引用检查器时保守返回，不具备安全依据绝不清理
    if (!this.options.hasWorkspaceReferences) {
      return
    }

    // 检查是否存在任何会话或项目引用（包含新创建的 idle 会话、当前工作区引用等）
    if (await this.options.hasWorkspaceReferences(cwd)) {
      return
    }

    try {
      await rmdir(cwd)
    } catch {
      // 非空目录（用户数据）或权限受限时安全保留
    }
  }
}
