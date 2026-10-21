import { readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { validateControlSnapshotData, validateJournalEntry, validateOperationEntry } from '../control-store'
import { validateRequestEntry } from '../request-registry'
import {
  validateCollaborationPlansIndex,
  validateCollaborationRootPartition,
} from '@pi-meme/subagents/server/collaboration-store'
import { isValidGoalState } from '@pi-meme/goals/server/service'
import { relocatedMarker, storageOwnerFile } from '../data-root'
import { optionalStat, physicalPath } from './files'
import type { HostStoragePaths } from './paths'

export type CandidateRetentionReason = 'target_missing' | 'target_corrupted' | 'symlink_detected'

export type CleanupCandidate = {
  temporaryFile: string
  targetFile: string
  reason: CandidateRetentionReason
}

export type SkippedPath = {
  path: string
  reason: string
}

export type CleanupTemporaryFilesReport = {
  deleted: string[]
  retainedCandidates: CleanupCandidate[]
  skipped: SkippedPath[]
}

const UUID_PATTERN = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'

async function isMaintenanceInProgress(root: string): Promise<boolean> {
  const hasRelocated = await optionalStat(path.join(root, relocatedMarker))
  if (hasRelocated) return true

  const jobStat = await optionalStat(path.join(root, storageOwnerFile))
  if (jobStat?.isFile()) {
    try {
      const content = await readFile(path.join(root, storageOwnerFile), 'utf8')
      const job = JSON.parse(content) as { stage?: string }
      if (job && job.stage && job.stage !== 'committed') {
        return true
      }
    } catch {
      return true
    }
  }

  try {
    const rootFiles = await readdir(root)
    if (rootFiles.some((f) => f.startsWith('.storage-layout-upgrade-') && f.endsWith('.json'))) {
      return true
    }
  } catch {
    // 忽略目录不可读
  }

  return false
}

type FileValidator = (filePath: string) => Promise<boolean>

async function validateControlSnapshot(filePath: string): Promise<boolean> {
  try {
    const content = await readFile(filePath, 'utf8')
    const data: unknown = JSON.parse(content)
    validateControlSnapshotData(data)
    return true
  } catch {
    return false
  }
}

async function validateEventsJournal(filePath: string): Promise<boolean> {
  try {
    const content = await readFile(filePath, 'utf8')
    if (content.length === 0) return true
    if (!content.endsWith('\n')) return false
    const lines = content.split('\n').filter((l) => l.trim().length > 0)
    for (const line of lines) {
      const parsed: unknown = JSON.parse(line)
      validateJournalEntry(parsed)
    }
    return true
  } catch {
    return false
  }
}

async function validateOperationsJournal(filePath: string): Promise<boolean> {
  try {
    const content = await readFile(filePath, 'utf8')
    if (content.length === 0) return true
    if (!content.endsWith('\n')) return false
    const lines = content.split('\n').filter((l) => l.trim().length > 0)
    for (const line of lines) {
      const parsed: unknown = JSON.parse(line)
      validateOperationEntry(parsed)
    }
    return true
  } catch {
    return false
  }
}

async function validateRequests(filePath: string): Promise<boolean> {
  try {
    const content = await readFile(filePath, 'utf8')
    if (content.length === 0) return true
    if (!content.endsWith('\n')) return false
    const lines = content.split('\n').filter((l) => l.trim().length > 0)
    for (const line of lines) {
      const parsed: unknown = JSON.parse(line)
      validateRequestEntry(parsed)
      const item = parsed as { t?: unknown }
      if (item.t !== undefined && (typeof item.t !== 'string' || Number.isNaN(Date.parse(item.t)))) {
        return false
      }
    }
    return true
  } catch {
    return false
  }
}

async function validateAuth(filePath: string): Promise<boolean> {
  try {
    const content = await readFile(filePath, 'utf8')
    const data = JSON.parse(content) as unknown
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false
    const entries = Object.entries(data)
    if (entries.length === 0) return false
    return entries.every(([k, v]) => typeof k === 'string' && typeof v === 'string')
  } catch {
    return false
  }
}

async function validateGoals(filePath: string): Promise<boolean> {
  try {
    const content = await readFile(filePath, 'utf8')
    const data: unknown = JSON.parse(content)
    return isValidGoalState(data)
  } catch {
    return false
  }
}

async function validateCollaborationPlans(filePath: string): Promise<boolean> {
  try {
    const content = await readFile(filePath, 'utf8')
    const data: unknown = JSON.parse(content)
    validateCollaborationPlansIndex(data)
    return true
  } catch {
    return false
  }
}

function validateCollaborationRoot(expectedRootId: string): FileValidator {
  return async (filePath: string) => {
    try {
      const content = await readFile(filePath, 'utf8')
      const data: unknown = JSON.parse(content)
      validateCollaborationRootPartition(data, expectedRootId)
      return true
    } catch {
      return false
    }
  }
}

async function validateTextDocument(filePath: string): Promise<boolean> {
  try {
    const stat = await optionalStat(filePath)
    return Boolean(stat?.isFile())
  } catch {
    return false
  }
}

type SingleFileCleanTarget = {
  relativeTmp: string
  relativeFinal: string
  validate: FileValidator
}

export async function cleanupTemporaryFiles(storagePaths: HostStoragePaths): Promise<CleanupTemporaryFilesReport> {
  const report: CleanupTemporaryFilesReport = {
    deleted: [],
    retainedCandidates: [],
    skipped: [],
  }

  const root = storagePaths.root
  try {
    const safeRoot = await physicalPath(root, '.')
    if (!safeRoot) return report
  } catch (cause) {
    report.skipped.push({ path: root, reason: `数据根目录包含符号链接或超出限制：${String(cause)}` })
    return report
  }

  if (await isMaintenanceInProgress(root)) {
    report.skipped.push({ path: root, reason: '检测到维护、迁移或升级进行中，跳过临时文件清理' })
    return report
  }

  async function checkAndClean(item: SingleFileCleanTarget) {
    const fullTmp = path.join(root, item.relativeTmp)
    const fullFinal = path.join(root, item.relativeFinal)

    let safeTmp: string | null = null
    try {
      safeTmp = await physicalPath(root, item.relativeTmp)
      if (!safeTmp) return
    } catch {
      report.retainedCandidates.push({
        temporaryFile: fullTmp,
        targetFile: fullFinal,
        reason: 'symlink_detected',
      })
      return
    }

    let safeFinal: string | null = null
    try {
      safeFinal = await physicalPath(root, item.relativeFinal)
      if (!safeFinal) {
        report.retainedCandidates.push({
          temporaryFile: safeTmp,
          targetFile: fullFinal,
          reason: 'target_missing',
        })
        return
      }
    } catch {
      report.retainedCandidates.push({
        temporaryFile: safeTmp,
        targetFile: fullFinal,
        reason: 'symlink_detected',
      })
      return
    }

    const isValid = await item.validate(safeFinal)
    if (!isValid) {
      report.retainedCandidates.push({
        temporaryFile: safeTmp,
        targetFile: safeFinal,
        reason: 'target_corrupted',
      })
      return
    }

    await rm(safeTmp, { force: true })
    report.deleted.push(safeTmp)
  }

  // 1. Control 与 Requests 固定临时文件
  const fixedTargets: SingleFileCleanTarget[] = [
    {
      relativeTmp: path.relative(root, `${storagePaths.controlSnapshotFile}.tmp`),
      relativeFinal: path.relative(root, storagePaths.controlSnapshotFile),
      validate: validateControlSnapshot,
    },
    {
      relativeTmp: path.relative(root, `${storagePaths.controlEventsFile}.tmp`),
      relativeFinal: path.relative(root, storagePaths.controlEventsFile),
      validate: validateEventsJournal,
    },
    {
      relativeTmp: path.relative(root, `${storagePaths.controlOperationsFile}.tmp`),
      relativeFinal: path.relative(root, storagePaths.controlOperationsFile),
      validate: validateOperationsJournal,
    },
    {
      relativeTmp: path.relative(root, `${storagePaths.requestsFile}.tmp`),
      relativeFinal: path.relative(root, storagePaths.requestsFile),
      validate: validateRequests,
    },
  ]

  for (const target of fixedTargets) {
    await checkAndClean(target)
  }

  // 2. Auth 凭据 UUID 临时文件：credentials/auth.json.<uuid>.tmp
  const credentialsRel = path.relative(root, storagePaths.credentialsDirectory)
  try {
    const safeCreds = await physicalPath(root, credentialsRel)
    if (safeCreds) {
      const entries = await readdir(safeCreds).catch(() => [])
      const authPattern = new RegExp(`^auth\\.json\\.${UUID_PATTERN}\\.tmp$`)
      for (const entry of entries) {
        if (!authPattern.test(entry)) continue
        await checkAndClean({
          relativeTmp: path.join(credentialsRel, entry),
          relativeFinal: path.relative(root, storagePaths.authFile),
          validate: validateAuth,
        })
      }
    }
  } catch (cause) {
    report.skipped.push({ path: storagePaths.credentialsDirectory, reason: String(cause) })
  }

  // 3. Goals 目标服务 UUID 临时文件：state/goals.json.<uuid>.tmp
  const stateRel = path.relative(root, storagePaths.stateDirectory)
  try {
    const safeState = await physicalPath(root, stateRel)
    if (safeState) {
      const entries = await readdir(safeState).catch(() => [])
      const goalsPattern = new RegExp(`^goals\\.json\\.${UUID_PATTERN}\\.tmp$`)
      for (const entry of entries) {
        if (!goalsPattern.test(entry)) continue
        await checkAndClean({
          relativeTmp: path.join(stateRel, entry),
          relativeFinal: path.relative(root, storagePaths.goalsFile),
          validate: validateGoals,
        })
      }
    }
  } catch (cause) {
    report.skipped.push({ path: storagePaths.stateDirectory, reason: String(cause) })
  }

  // 4. Collaboration plans UUID 临时文件：state/collaboration/plans.json.<uuid>.tmp
  const collabRel = path.relative(root, storagePaths.collaborationDirectory)
  try {
    const safeCollab = await physicalPath(root, collabRel)
    if (safeCollab) {
      const entries = await readdir(safeCollab).catch(() => [])
      const plansPattern = new RegExp(`^plans\\.json\\.${UUID_PATTERN}\\.tmp$`)
      for (const entry of entries) {
        if (!plansPattern.test(entry)) continue
        await checkAndClean({
          relativeTmp: path.join(collabRel, entry),
          relativeFinal: path.relative(root, storagePaths.collaborationPlansFile),
          validate: validateCollaborationPlans,
        })
      }
    }
  } catch (cause) {
    report.skipped.push({ path: storagePaths.collaborationDirectory, reason: String(cause) })
  }

  // 5. Collaboration 根分片 UUID 临时文件：state/collaboration/roots/<rootId>.json.<uuid>.tmp
  const rootsRel = path.relative(root, storagePaths.collaborationRootsDirectory)
  try {
    const safeRoots = await physicalPath(root, rootsRel)
    if (safeRoots) {
      const entries = await readdir(safeRoots).catch(() => [])
      const rootPattern = new RegExp(`^([^.]+)\\.json\\.${UUID_PATTERN}\\.tmp$`)
      for (const entry of entries) {
        const match = rootPattern.exec(entry)
        if (!match) continue
        const rootId = match[1]
        await checkAndClean({
          relativeTmp: path.join(rootsRel, entry),
          relativeFinal: path.relative(root, storagePaths.collaborationRootFile(rootId)),
          validate: validateCollaborationRoot(rootId),
        })
      }
    }
  } catch (cause) {
    report.skipped.push({ path: storagePaths.collaborationRootsDirectory, reason: String(cause) })
  }

  // 6. Data plans 文档 UUID 临时文件：data/plans/<sessionId>/<documentId>.md.<uuid>.tmp
  const plansDataRel = path.relative(root, storagePaths.plansDataDirectory)
  try {
    const safePlansData = await physicalPath(root, plansDataRel)
    if (safePlansData) {
      const sessionDirs = await readdir(safePlansData, { withFileTypes: true }).catch(() => [])
      const docPattern = new RegExp(`^([^.]+)\\.md\\.${UUID_PATTERN}\\.tmp$`)
      for (const dirent of sessionDirs) {
        if (!dirent.isDirectory()) continue
        const sessionRel = path.join(plansDataRel, dirent.name)
        try {
          const safeSessionDir = await physicalPath(root, sessionRel)
          if (!safeSessionDir) continue
          const files = await readdir(safeSessionDir).catch(() => [])
          for (const file of files) {
            const match = docPattern.exec(file)
            if (!match) continue
            const docId = match[1]
            await checkAndClean({
              relativeTmp: path.join(sessionRel, file),
              relativeFinal: path.relative(root, storagePaths.planFile(dirent.name, docId)),
              validate: validateTextDocument,
            })
          }
        } catch {
          // 符号链接 session 目录跳过
          continue
        }
      }
    }
  } catch (cause) {
    report.skipped.push({ path: storagePaths.plansDataDirectory, reason: String(cause) })
  }

  return report
}
