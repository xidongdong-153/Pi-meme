import { randomUUID, createHash } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir, statfs } from 'node:fs/promises'
import path from 'node:path'
import {
  STORAGE_LAYOUT_FORMAT,
  STORAGE_LAYOUT_VERSION,
  type StorageLayoutManifest,
  storageLayoutRelativePaths,
} from '@pi-meme/contracts/storage-paths'
import { createHostStoragePaths } from './paths'
import { workspaceKey } from '@pi-meme/pi-runtime/runtime-paths'
import {
  migrateLegacyCollaborationJson,
  saveCollaborationPlans,
  saveCollaborationRoot,
} from '@pi-meme/subagents/server/collaboration-store'
import { importLegacyControlState, createControlStorePaths } from '../control-store'
import { importLegacyRequests } from '../request-registry'
import { runGit } from '@pi-meme/git/server/git-service'
import { relocatedMarker, storageOwnerFile } from '../data-root'
import { contains, digest, listFiles, optionalStat, physicalPath, readJson, writeJson, writeText } from './files'
import { relocateAttachmentBlock, type WorktreeRelocation } from './relocate'
import { resourceIdentity } from '@pi-meme/resources/server/resource-identity'

export type PublishItem = {
  relative: string
  hash: string
  kind: 'file'
}

export type DirMoveRecord = {
  fromRelative: string
  toRelative: string
  fingerprint?: string
}

export type UpgradeLedger = {
  version: 1
  id: string
  hostId: string
  stage: 'preparing' | 'staged' | 'publishing' | 'verified' | 'committed'
  backupDir: string
  stagingDir: string
  legacyDir: string
  worktrees: WorktreeRelocation[]
  publishItems: PublishItem[]
  dirMoves?: DirMoveRecord[]
  createdAt: string
  updatedAt: string
}

export type StorageLayoutCheckResult =
  | { status: 'current'; version: number }
  | { status: 'empty' }
  | { status: 'needs-upgrade'; fromVersion: 1 }
  | { status: 'in-progress'; jobId: string }
  | { status: 'corrupt'; error: string }

export const BUILTIN_MODULE_NAMES = new Set([
  '@pi-meme/goals',
  '@pi-meme/chat',
  '@pi-meme/workspace',
  '@pi-meme/git',
  '@pi-meme/models',
  '@pi-meme/settings',
  '@pi-meme/interaction',
  '@pi-meme/mcp',
  '@pi-meme/history',
  '@pi-meme/usage',
  '@pi-meme/resources',
  '@pi-meme/sandbox-macos',
  '@pi-meme/sandbox-linux',
  '@pi-meme/permissions',
  '@pi-meme/codemode',
  '@pi-meme/subagents',
])

export function isBuiltinModuleId(idOrEncoded: string): boolean {
  try {
    const decoded = decodeURIComponent(idOrEncoded)
    return BUILTIN_MODULE_NAMES.has(decoded)
  } catch {
    return false
  }
}

type RecordValue = Record<string, unknown>
function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('升级元数据必须是对象')
  return value as RecordValue
}
function records(value: unknown): RecordValue[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('升级元数据列表格式无效')
  return value.map(record)
}

function ledgerFileName(jobId: string) {
  return `.storage-layout-upgrade-${jobId}.json`
}

/** 检查存储布局状态 */
export async function checkStorageLayout(root: string): Promise<StorageLayoutCheckResult> {
  const resolved = path.resolve(root)

  // 1. 检查是否存在不可继续的旧迁移或正在进行的换根维护
  if (await optionalStat(path.join(resolved, relocatedMarker))) {
    return { status: 'corrupt', error: '此目录已被标记为已迁移，不能作为当前数据根启动' }
  }
  const existingJob = await readJson<{ id?: string; stage?: string }>(path.join(resolved, storageOwnerFile))
  if (existingJob && existingJob.stage !== 'committed') {
    return { status: 'corrupt', error: '此目录存在未完成的换根维护任务' }
  }

  // 2. 检查是否有进行中的就地升级任务文件（优先完成中断任务）
  const files = await readdir(resolved).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === 'ENOENT') return []
    throw cause
  })
  const upgradeJobs = files.filter((f) => f.startsWith('.storage-layout-upgrade-') && f.endsWith('.json'))
  if (upgradeJobs.length > 0) {
    const jobId = upgradeJobs[0].slice('.storage-layout-upgrade-'.length, -'.json'.length)
    return { status: 'in-progress', jobId }
  }

  // 3. 检查 storage.json
  const manifestFile = path.join(resolved, storageLayoutRelativePaths.manifestFile)
  const manifest = await readJson<StorageLayoutManifest>(manifestFile)
  if (manifest) {
    if (manifest.format !== STORAGE_LAYOUT_FORMAT)
      return { status: 'corrupt', error: `数据目录清单格式不支持：${manifest.format}` }
    if (typeof manifest.version !== 'number' || !Number.isInteger(manifest.version) || manifest.version <= 0) {
      return {
        status: 'corrupt',
        error: `数据目录清单版本无效: ${String(manifest.version)}，版本必须为正整数`,
      }
    }
    if (manifest.version === STORAGE_LAYOUT_VERSION) return { status: 'current', version: STORAGE_LAYOUT_VERSION }
    if (manifest.version === 1) return { status: 'needs-upgrade', fromVersion: 1 }
    if (manifest.version > STORAGE_LAYOUT_VERSION)
      return {
        status: 'corrupt',
        error: `未知的数据目录布局版本: ${manifest.version}，当前支持版本为 ${STORAGE_LAYOUT_VERSION}，请升级应用`,
      }
    return { status: 'corrupt', error: `不支持的数据目录布局版本: ${manifest.version}` }
  }

  const meaningful = files.filter((f) => !['.DS_Store', 'host.lock'].includes(f))
  if (meaningful.length === 0) return { status: 'empty' }

  // 4. 检查是否包含已知旧版特征
  const oldMarkers = [
    'host-id',
    'settings.json',
    'auth.json',
    'projects.json',
    'control.json',
    'collaboration.json',
    'pi',
    'sessions',
    'workspaces',
    'plugins',
  ]
  const hasOldFeatures = meaningful.some((f) => oldMarkers.includes(f))
  if (hasOldFeatures) return { status: 'needs-upgrade', fromVersion: 1 }

  return {
    status: 'corrupt',
    error: `目录含有未知文件且缺少 ${storageLayoutRelativePaths.manifestFile}，无法识别数据根`,
  }
}

/** 供 Host 启动前调用：初始化空根或自动执行必要升级 */
export async function assertStorageLayout(root: string) {
  const check = await checkStorageLayout(root)
  if (check.status === 'current') return
  if (check.status === 'empty') {
    await initEmptyStorageLayout(root)
    return
  }
  if (check.status === 'needs-upgrade') {
    await upgradeStorageLayout(root)
    return
  }
  if (check.status === 'in-progress') {
    await resumeStorageLayoutUpgrade(root, check.jobId)
    return
  }
  throw new Error(check.error)
}

/** 初始化全新数据根 */
export async function initEmptyStorageLayout(root: string) {
  const resolved = path.resolve(root)
  await mkdir(resolved, { recursive: true, mode: 0o700 })
  const now = new Date().toISOString()
  const manifest: StorageLayoutManifest = {
    format: STORAGE_LAYOUT_FORMAT,
    version: STORAGE_LAYOUT_VERSION,
    createdAt: now,
    updatedAt: now,
  }
  const manifestFile = path.join(resolved, storageLayoutRelativePaths.manifestFile)
  await writeJson(manifestFile, manifest)
}

/** 执行就地目录布局升级：采用基于 Staging 的发布架构 */
export async function upgradeStorageLayout(
  root: string,
  options?: { jobId?: string; progress?: (stage: string) => void },
) {
  const resolved = path.resolve(root)
  const jobId = options?.jobId ?? randomUUID()
  const ledgerFile = path.join(resolved, ledgerFileName(jobId))
  const paths = createHostStoragePaths(resolved)

  // 1. 读取或创建 hostId
  let hostId: string
  try {
    hostId = (await readFile(paths.hostIdFile, 'utf8')).trim()
    if (!hostId) throw new Error('host-id 文件内容为空')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      hostId = randomUUID()
      await writeText(paths.hostIdFile, `${hostId}\n`)
    } else {
      throw new Error(`无法读取持久 host-id：${String(cause)}`, { cause })
    }
  }

  // 2. 空间与目录准备
  const backupDir = paths.layoutBackupDirectory(jobId)
  const legacyDir = paths.legacyBackupDirectory(jobId)
  const stagingDir = path.join(resolved, `.upgrade-staging-${jobId}`)

  if (!contains(resolved, backupDir) || !contains(resolved, legacyDir) || !contains(resolved, stagingDir)) {
    throw new Error('维护目录路径超出数据根')
  }

  // 严格校验维护目录路径及父目录均不可为符号链接
  await physicalPath(resolved, path.relative(resolved, stagingDir))
  await physicalPath(resolved, path.relative(resolved, backupDir))
  await physicalPath(resolved, path.relative(resolved, legacyDir))

  const filesToBackup = await inventoryAllSourceFiles(resolved)
  const totalBackupBytes = filesToBackup.reduce((sum, f) => sum + f.bytes, 0)

  const stats = await statfs(resolved)
  const availableBytes = stats.bavail * stats.bsize
  if (availableBytes < totalBackupBytes * 2 + 16 * 1024 * 1024) {
    throw new Error(
      `数据根磁盘可用空间不足：需要至少 ${Math.ceil((totalBackupBytes * 2 + 16 * 1024 * 1024) / 1024 / 1024)} MiB`,
    )
  }

  // 3. 创建初始账本
  const now = new Date().toISOString()
  const ledger: UpgradeLedger = {
    version: 1,
    id: jobId,
    hostId,
    stage: 'preparing',
    backupDir,
    stagingDir,
    legacyDir,
    worktrees: [],
    publishItems: [],
    createdAt: now,
    updatedAt: now,
  }
  await writeJson(ledgerFile, ledger)

  await runUpgradeStages(resolved, paths, ledger, ledgerFile, filesToBackup, options?.progress)
}

const VALID_STAGES = new Set(['preparing', 'staged', 'publishing', 'verified', 'committed'])

function validateLedger(ledger: unknown, expectedJobId: string): UpgradeLedger {
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) {
    throw new Error(`无法恢复布局升级任务：账本损坏或格式无效（${expectedJobId}）`)
  }
  const l = ledger as Record<string, unknown>
  if (l.version !== 1 || l.id !== expectedJobId) {
    throw new Error(`无法恢复布局升级任务：账本损坏或 ID 不匹配（${expectedJobId}）`)
  }
  if (!/^[\w-]{1,64}$/.test(expectedJobId)) {
    throw new Error(`非法的布局升级任务 ID：${expectedJobId}`)
  }
  if (typeof l.stage !== 'string' || !VALID_STAGES.has(l.stage)) {
    throw new TypeError(`无法恢复布局升级任务：账本 stage 状态非法或未知：${String(l.stage)}`)
  }
  if (typeof l.backupDir !== 'string' || typeof l.stagingDir !== 'string' || typeof l.legacyDir !== 'string') {
    throw new TypeError(`无法恢复布局升级任务：账本目录配置缺失或无效（${expectedJobId}）`)
  }
  if (!Array.isArray(l.worktrees)) {
    throw new TypeError(`无法恢复布局升级任务：账本 worktrees 清单缺失或格式无效（${expectedJobId}）`)
  }
  if (!Array.isArray(l.publishItems)) {
    throw new TypeError(`无法恢复布局升级任务：账本 publishItems 清单缺失或格式无效（${expectedJobId}）`)
  }
  for (const item of l.publishItems) {
    if (
      !item ||
      typeof item !== 'object' ||
      typeof (item as PublishItem).relative !== 'string' ||
      typeof (item as PublishItem).hash !== 'string'
    ) {
      throw new TypeError(`无法恢复布局升级任务：账本中的发布项格式无效（${expectedJobId}）`)
    }
  }
  if (l.dirMoves !== undefined) {
    if (!Array.isArray(l.dirMoves)) {
      throw new TypeError(`无法恢复布局升级任务：账本 dirMoves 清单格式无效（${expectedJobId}）`)
    }
    for (const move of l.dirMoves) {
      if (
        !move ||
        typeof move !== 'object' ||
        typeof (move as DirMoveRecord).fromRelative !== 'string' ||
        typeof (move as DirMoveRecord).toRelative !== 'string'
      ) {
        throw new TypeError(`无法恢复布局升级任务：账本中的目录移动项格式无效（${expectedJobId}）`)
      }
    }
  }

  return l as unknown as UpgradeLedger
}

/** 恢复未完成的升级任务 */
export async function resumeStorageLayoutUpgrade(
  root: string,
  jobId: string,
  options?: { progress?: (stage: string) => void },
) {
  const resolved = path.resolve(root)
  const ledgerFile = path.join(resolved, ledgerFileName(jobId))
  const rawLedger = await readJson<unknown>(ledgerFile)
  const ledger = validateLedger(rawLedger, jobId)

  const paths = createHostStoragePaths(resolved)
  const expectedBackupDir = paths.layoutBackupDirectory(ledger.id)
  const expectedLegacyDir = paths.legacyBackupDirectory(ledger.id)
  const expectedStagingDir = path.join(resolved, `.upgrade-staging-${ledger.id}`)

  if (
    path.resolve(ledger.backupDir) !== expectedBackupDir ||
    path.resolve(ledger.legacyDir) !== expectedLegacyDir ||
    path.resolve(ledger.stagingDir) !== expectedStagingDir ||
    ledger.stagingDir === resolved ||
    ledger.backupDir === resolved ||
    ledger.legacyDir === resolved
  ) {
    throw new Error(`升级账本中的目录不合法或被篡改，拒绝恢复：${ledger.id}`)
  }

  const checkNotSymlink = async (target: string) => {
    try {
      const st = await lstat(target)
      if (st.isSymbolicLink()) {
        throw new Error(`检测到维护目录为符号链接，拒绝恢复：${target}`)
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
  }
  await checkNotSymlink(ledger.stagingDir)
  await checkNotSymlink(ledger.backupDir)
  await checkNotSymlink(ledger.legacyDir)

  const realRoot = await realpath(resolved).catch(() => resolved)
  const stagingParent = path.dirname(path.resolve(ledger.stagingDir))
  const realStagingParent = await realpath(stagingParent).catch(() => stagingParent)
  if (realStagingParent !== realRoot) {
    throw new Error('stagingDir 所在真实路径不属于数据根，拒绝恢复')
  }

  // 严格校验维护目录中间所有段均不可为符号链接
  await physicalPath(resolved, path.relative(resolved, ledger.stagingDir))
  await physicalPath(resolved, path.relative(resolved, ledger.backupDir))
  await physicalPath(resolved, path.relative(resolved, ledger.legacyDir))

  const filesToBackup = await inventoryAllSourceFiles(resolved)
  await runUpgradeStages(resolved, paths, ledger, ledgerFile, filesToBackup, options?.progress)
}

/** 盘点数据根下所有将被迁移或可能被重写的文件（全量递归，不漏未知子文件和点文件） */
async function inventoryAllSourceFiles(root: string): Promise<Array<{ relative: string; bytes: number }>> {
  const result: Array<{ relative: string; bytes: number }> = []
  const seen = new Set<string>()

  const singleFiles = [
    'settings.json',
    'auth.json',
    'projects.json',
    'goals.json',
    'agent-permissions.json',
    'control.json',
    'collaboration.json',
    'resources/state.json',
    'plugins/installed.json',
    'remote-services.json',
    'sessions-cache.json',
    'sessions-cache.json.tmp',
    'remote-services.json.tmp',
    'settings.json.tmp',
    'auth.json.tmp',
    'projects.json.tmp',
    'goals.json.tmp',
    'agent-permissions.json.tmp',
    'control.json.tmp',
    'collaboration.json.tmp',
  ]
  for (const rel of singleFiles) {
    const full = path.join(root, rel)
    const info = await optionalStat(full)
    if (info && info.isFile()) {
      result.push({ relative: rel, bytes: info.size })
      seen.add(rel)
    }
  }

  // 递归盘点属于旧布局的受管目录中的所有文件
  const directoriesToInventory = [
    'pi',
    'sessions',
    'data/sessions',
    'workspaces',
    'attachments',
    'plans',
    'profile',
    'requests',
    'resources',
    'plugins',
    'plugin-data',
    'skills',
    'themes',
    'builtin-resources',
  ]
  for (const dirName of directoriesToInventory) {
    const dir = path.join(root, dirName)
    if (await optionalStat(dir)) {
      const allFiles = await listFiles(dir)
      for (const file of allFiles) {
        const rel = path.relative(root, file)
        if (!seen.has(rel)) {
          const info = await optionalStat(file)
          if (info && info.isFile()) {
            result.push({ relative: rel, bytes: info.size })
            seen.add(rel)
          }
        }
      }
    }
  }

  return result
}

async function runUpgradeStages(
  root: string,
  paths: ReturnType<typeof createHostStoragePaths>,
  ledger: UpgradeLedger,
  ledgerFile: string,
  filesToBackup: Array<{ relative: string; bytes: number }>,
  progress?: (stage: string) => void,
) {
  const notify = (stage: string) => progress?.(stage)

  // 阶段 1：完整备份与哈希校验
  if (ledger.stage === 'preparing') {
    notify('backing-up')
    await executeBackup(root, ledger, filesToBackup)
    ledger.stage = 'staged'
    ledger.updatedAt = new Date().toISOString()
    await writeJson(ledgerFile, ledger)
  }

  // 阶段 2：在 Staging 中构建全新的完整 v2 结构并预计算发布哈希
  if (ledger.stage === 'staged') {
    notify('transforming')
    await buildStagedV2Layout(root, paths, ledger)
    ledger.stage = 'publishing'
    ledger.updatedAt = new Date().toISOString()
    await writeJson(ledgerFile, ledger)
  }

  // 阶段 3：执行发布（原子移换与 Worktree repair）并校验
  if (ledger.stage === 'publishing') {
    notify('publishing')
    await executePublishStage(root, paths, ledger)
    await verifyUpgradedLayout(paths)
    ledger.stage = 'verified'
    ledger.updatedAt = new Date().toISOString()
    await writeJson(ledgerFile, ledger)
  }

  // 阶段 4：提交与清理
  if (ledger.stage === 'verified') {
    notify('committing')
    const now = new Date().toISOString()
    const manifest: StorageLayoutManifest = {
      format: STORAGE_LAYOUT_FORMAT,
      version: STORAGE_LAYOUT_VERSION,
      createdAt: ledger.createdAt,
      updatedAt: now,
    }
    await writeJson(paths.manifestFile, manifest)

    // 归档升级账本到 state/maintenance/
    await mkdir(paths.maintenanceDirectory, { recursive: true })
    const finalReportFile = path.join(paths.maintenanceDirectory, `layout-upgrade-${ledger.id}.json`)
    ledger.stage = 'committed'
    ledger.updatedAt = now
    await writeJson(finalReportFile, ledger)

    // 清理 staging 与根下临时账本
    await rm(ledger.stagingDir, { recursive: true, force: true })
    await rm(ledgerFile, { force: true })
    notify('complete')
  }
}

/** 阶段 1：备份所有源文件到 backupDir 并验证哈希 */
async function executeBackup(
  root: string,
  ledger: UpgradeLedger,
  filesToBackup: Array<{ relative: string; bytes: number }>,
) {
  await mkdir(ledger.backupDir, { recursive: true, mode: 0o700 })
  const manifest: Record<string, string> = {}

  for (const item of filesToBackup) {
    const src = path.join(root, item.relative)
    const dest = path.join(ledger.backupDir, item.relative)
    await mkdir(path.dirname(dest), { recursive: true })

    const srcHash = await digest(src)
    await copyFile(src, dest)
    const destHash = await digest(dest)
    if (srcHash !== destHash) {
      throw new Error(`备份校验失败：${item.relative} 哈希不匹配`)
    }
    manifest[item.relative] = srcHash
  }

  await writeJson(path.join(ledger.backupDir, 'backup-manifest.json'), manifest)
}

async function dirFingerprint(dir: string): Promise<string> {
  const files = await listFiles(dir)
  const items = await Promise.all(
    files.sort().map(async (f) => `${path.relative(dir, f)}:${(await optionalStat(f))?.size}:${await digest(f)}`),
  )
  return createHash('sha256').update(items.join('\n')).digest('hex')
}

/** 阶段 2：在 Staging 目录中从备份构建完整的 v2 目标结构，并重写已知定位与附件 */
async function buildStagedV2Layout(
  root: string,
  paths: ReturnType<typeof createHostStoragePaths>,
  ledger: UpgradeLedger,
) {
  const staging = ledger.stagingDir
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true, mode: 0o700 })

  const fromBackup = async (rel: string) => {
    const file = path.join(ledger.backupDir, rel)
    return (await optionalStat(file)) ? file : undefined
  }

  // 1. config/app.json
  const settingsSrc = (await fromBackup('settings.json')) ?? (await fromBackup('config/app.json'))
  if (settingsSrc) {
    const dest = path.join(staging, storageLayoutRelativePaths.appConfigFile)
    await mkdir(path.dirname(dest), { recursive: true })
    await copyFile(settingsSrc, dest)
  }

  // 2. credentials/auth.json
  const authSrc = (await fromBackup('auth.json')) ?? (await fromBackup('credentials/auth.json'))
  if (authSrc) {
    const dest = path.join(staging, storageLayoutRelativePaths.authFile)
    await mkdir(path.dirname(dest), { recursive: true })
    await copyFile(authSrc, dest)
    await chmod(dest, 0o600)
  }

  // 3. config/profile/
  const profileDir = (await optionalStat(path.join(ledger.backupDir, 'profile')))
    ? path.join(ledger.backupDir, 'profile')
    : (await optionalStat(path.join(ledger.backupDir, 'config', 'profile')))
      ? path.join(ledger.backupDir, 'config', 'profile')
      : undefined
  if (profileDir) {
    const dest = path.join(staging, storageLayoutRelativePaths.profileDirectory)
    await copyDirRecursive(profileDir, dest)
  }

  // 4. config/agent/ (从不可变备份中的旧 pi/ 或 config/agent)
  const piSrc = (await optionalStat(path.join(ledger.backupDir, 'pi')))
    ? path.join(ledger.backupDir, 'pi')
    : (await optionalStat(path.join(ledger.backupDir, 'config', 'agent')))
      ? path.join(ledger.backupDir, 'config', 'agent')
      : undefined
  if (piSrc) {
    const dest = path.join(staging, storageLayoutRelativePaths.agentDirectory)
    await mkdir(dest, { recursive: true })
    for (const entry of await readdir(piSrc)) {
      const entryPath = path.join(piSrc, entry)
      if (entry === 'mcp.log') {
        const logDest = path.join(staging, storageLayoutRelativePaths.mcpLogFile)
        await mkdir(path.dirname(logDest), { recursive: true })
        await copyFile(entryPath, logDest)
        continue
      }
      if (['builtin-skills', 'extensions'].includes(entry)) {
        const legDest = path.join(ledger.legacyDir, entry)
        await mkdir(path.dirname(legDest), { recursive: true })
        const s = await optionalStat(entryPath)
        if (s?.isDirectory()) {
          await copyDirRecursive(entryPath, legDest)
        } else if (s?.isFile()) {
          await copyFile(entryPath, legDest)
        }
        continue
      }
      const s = await optionalStat(entryPath)
      if (s?.isDirectory()) {
        await copyDirRecursive(entryPath, path.join(dest, entry))
      } else if (s?.isFile()) {
        await copyFile(entryPath, path.join(dest, entry))
      }
    }
  }

  // 5. state/projects.json
  const projectsSrc = (await fromBackup('projects.json')) ?? (await fromBackup('state/projects.json'))
  if (projectsSrc) {
    const dest = path.join(staging, storageLayoutRelativePaths.projectsFile)
    await mkdir(path.dirname(dest), { recursive: true })
    await copyFile(projectsSrc, dest)
  }

  // 6. state/goals.json
  const goalsSrc = (await fromBackup('goals.json')) ?? (await fromBackup('state/goals.json'))
  if (goalsSrc) {
    const dest = path.join(staging, storageLayoutRelativePaths.goalsFile)
    await mkdir(path.dirname(dest), { recursive: true })
    await copyFile(goalsSrc, dest)
  }

  // 7. state/agent-permissions.json
  const permsSrc = (await fromBackup('agent-permissions.json')) ?? (await fromBackup('state/agent-permissions.json'))
  if (permsSrc) {
    const dest = path.join(staging, storageLayoutRelativePaths.agentPermissionsFile)
    await mkdir(path.dirname(dest), { recursive: true })
    await copyFile(permsSrc, dest)
  }

  // 8. state/resources.json
  const resSrc = (await fromBackup('resources/state.json')) ?? (await fromBackup('state/resources.json'))
  if (resSrc) {
    const dest = path.join(staging, storageLayoutRelativePaths.resourcesFile)
    await mkdir(path.dirname(dest), { recursive: true })
    await copyFile(resSrc, dest)
  }

  // 9. state/plugins.json
  const pluginsSrc = (await fromBackup('plugins/installed.json')) ?? (await fromBackup('state/plugins.json'))
  if (pluginsSrc) {
    let raw: unknown
    try {
      raw = await readJson(pluginsSrc)
    } catch (cause) {
      throw new Error(`插件清单文件损坏或格式错误：${String(cause)}`)
    }
    let envelope: RecordValue
    if (Array.isArray(raw)) {
      envelope = { format: 'pi-meme-plugins', version: 1, generationHighWaterMark: 0, records: raw }
    } else if (
      raw &&
      typeof raw === 'object' &&
      (raw as RecordValue).format === 'pi-meme-plugins' &&
      (raw as RecordValue).version === 1
    ) {
      envelope = raw as RecordValue
    } else {
      throw new Error('插件清单版本不支持或结构无效，升级中止以防丢失插件状态')
    }
    const dest = path.join(staging, storageLayoutRelativePaths.pluginsFile)
    await mkdir(path.dirname(dest), { recursive: true })
    await writeJson(dest, envelope)
  }

  // 9.1 plugin-data -> plugins/data / state/modules
  const pluginDataSrc = (await optionalStat(path.join(ledger.backupDir, 'plugin-data')))
    ? path.join(ledger.backupDir, 'plugin-data')
    : undefined
  if (pluginDataSrc) {
    for (const entry of await readdir(pluginDataSrc)) {
      if (entry.startsWith('.')) continue
      const entrySrc = path.join(pluginDataSrc, entry)
      const isModule = isBuiltinModuleId(entry)
      const targetBase = isModule
        ? path.join(staging, storageLayoutRelativePaths.modulesDirectory)
        : path.join(staging, storageLayoutRelativePaths.pluginDataDirectory)
      const dest = path.join(targetBase, entry)
      const s = await optionalStat(entrySrc)
      if (s?.isDirectory()) {
        await copyDirRecursive(entrySrc, dest)
      } else if (s?.isFile()) {
        await mkdir(path.dirname(dest), { recursive: true })
        await copyFile(entrySrc, dest)
      }
    }
  }

  // 10. state/control/
  const controlSrc = await fromBackup('control.json')
  if (controlSrc) {
    const raw = record(await readJson(controlSrc)) as {
      version: 2
      journalEpoch: string
      seq: number
      projects: import('@pi-meme/contracts/app-host').AppProject[]
      sessions: import('@pi-meme/contracts/app-host').AppSession[]
      operations: Record<string, any>
      receipts: import('@pi-meme/contracts/app-host').SubmissionReceipt[]
      events: import('@pi-meme/contracts/app-host').HostControlEvent[]
    }
    const destDir = path.join(staging, storageLayoutRelativePaths.controlDirectory)
    await importLegacyControlState(createControlStorePaths(destDir), raw)
  }

  // 11. state/requests.jsonl
  const requestsSrc = (await optionalStat(path.join(ledger.backupDir, 'requests')))
    ? path.join(ledger.backupDir, 'requests')
    : (await optionalStat(path.join(ledger.backupDir, 'state', 'requests.jsonl')))
      ? path.join(ledger.backupDir, 'state', 'requests.jsonl')
      : undefined
  if (requestsSrc) {
    const dest = path.join(staging, storageLayoutRelativePaths.requestsFile)
    const st = await optionalStat(requestsSrc)
    if (st?.isDirectory()) {
      await importLegacyRequests(requestsSrc, dest)
    } else if (st?.isFile()) {
      await copyFile(requestsSrc, dest)
    }
  }

  // 12. state/collaboration/
  const collabSrc = await fromBackup('collaboration.json')
  if (collabSrc) {
    const raw = record(await readJson(collabSrc))
    const converted = migrateLegacyCollaborationJson(raw as { records?: unknown[]; plans?: unknown[] })
    const rootsDir = path.join(staging, storageLayoutRelativePaths.collaborationRootsDirectory)
    const plansFile = path.join(staging, storageLayoutRelativePaths.collaborationPlansFile)
    await mkdir(rootsDir, { recursive: true })
    for (const [rId, part] of converted.roots) {
      await saveCollaborationRoot(rootsDir, rId, part)
    }
    await saveCollaborationPlans(plansFile, converted.plans)
  }

  // 13. config/workspaces/ (旧 workspaces/<hash>)
  const oldWsDir = (await optionalStat(path.join(ledger.backupDir, 'workspaces')))
    ? path.join(ledger.backupDir, 'workspaces')
    : (await optionalStat(path.join(ledger.backupDir, 'config', 'workspaces')))
      ? path.join(ledger.backupDir, 'config', 'workspaces')
      : undefined
  if (oldWsDir) {
    for (const entry of await readdir(oldWsDir)) {
      if (/^[a-f0-9]{64}$/.test(entry)) {
        const srcDir = path.join(oldWsDir, entry)
        const destDir = path.join(staging, storageLayoutRelativePaths.workspacesConfigDirectory, entry)
        await mkdir(destDir, { recursive: true })
        for (const f of await readdir(srcDir)) {
          await copyFile(path.join(srcDir, f), path.join(destDir, f))
        }
      }
    }
  }

  // 14. data/sessions/
  for (const sDirName of ['sessions', 'data/sessions']) {
    const sDir = path.join(ledger.backupDir, sDirName)
    if (await optionalStat(sDir)) {
      for (const hash of await readdir(sDir)) {
        if (/^[a-f0-9]{64}$/.test(hash)) {
          const srcHashDir = path.join(sDir, hash)
          const destHashDir = path.join(staging, storageLayoutRelativePaths.sessionsDataDirectory, hash)
          await mkdir(destHashDir, { recursive: true })
          for (const f of await readdir(srcHashDir)) {
            if (f.endsWith('.jsonl')) {
              await copyFile(path.join(srcHashDir, f), path.join(destHashDir, f))
            }
          }
        }
      }
    }
  }

  // 15. data/attachments/
  const attachDir = (await optionalStat(path.join(ledger.backupDir, 'attachments')))
    ? path.join(ledger.backupDir, 'attachments')
    : (await optionalStat(path.join(ledger.backupDir, 'data', 'attachments')))
      ? path.join(ledger.backupDir, 'data', 'attachments')
      : undefined
  if (attachDir) {
    const dest = path.join(staging, storageLayoutRelativePaths.attachmentsDirectory)
    await copyDirRecursive(attachDir, dest)
  }

  // 16. data/plans/
  const plansDir = (await optionalStat(path.join(ledger.backupDir, 'plans')))
    ? path.join(ledger.backupDir, 'plans')
    : (await optionalStat(path.join(ledger.backupDir, 'data', 'plans')))
      ? path.join(ledger.backupDir, 'data', 'plans')
      : undefined
  if (plansDir) {
    const dest = path.join(staging, storageLayoutRelativePaths.plansDataDirectory)
    await copyDirRecursive(plansDir, dest)
  }

  // 17. 建立 cwd 变迁映射与重写字段
  // standalone 由 root/standalone-workspaces/<id> 变迁至 root/workspaces/standalone/<id>
  // worktrees 由 root/worktrees/<id> 变迁至 root/workspaces/worktrees/<id>
  const cwds = new Map<string, string>()
  const oldStandalone = path.join(root, 'standalone-workspaces')
  if (await optionalStat(oldStandalone)) {
    for (const name of await readdir(oldStandalone)) {
      if (name.startsWith('.')) continue
      cwds.set(
        path.join(oldStandalone, name),
        path.join(root, storageLayoutRelativePaths.standaloneWorkspacesDirectory, name),
      )
    }
  }

  const oldWorktrees = path.join(root, 'worktrees')
  if (await optionalStat(oldWorktrees)) {
    for (const name of await readdir(oldWorktrees)) {
      if (name.startsWith('.')) continue
      cwds.set(path.join(oldWorktrees, name), path.join(root, storageLayoutRelativePaths.worktreesDirectory, name))
    }
  }

  const hashes = new Map([...cwds].map(([from, to]) => [workspaceKey(from), workspaceKey(to)]))

  // 路径重写器
  const relocatePath = (value: string): string => {
    if (!path.isAbsolute(value)) return value

    for (const [from, to] of cwds) {
      if (value === from || value.startsWith(`${from}${path.sep}`)) {
        return path.join(to, path.relative(from, value))
      }
    }

    const oldAttach = path.join(root, 'attachments')
    if (value === oldAttach || value.startsWith(`${oldAttach}${path.sep}`)) {
      return path.join(paths.attachmentsDirectory, path.relative(oldAttach, value))
    }

    const oldSessions = path.join(root, 'sessions')
    if (value === oldSessions || value.startsWith(`${oldSessions}${path.sep}`)) {
      const rel = path.relative(oldSessions, value)
      const parts = rel.split(path.sep)
      if (parts[0] && hashes.has(parts[0])) {
        parts[0] = hashes.get(parts[0])!
      }
      return path.join(paths.sessionsDataDirectory, ...parts)
    }

    const oldWorkspaces = path.join(root, 'workspaces')
    if (value.startsWith(`${oldWorkspaces}${path.sep}`)) {
      const rel = path.relative(oldWorkspaces, value)
      const parts = rel.split(path.sep)
      if (/^[a-f0-9]{64}$/.test(parts[0])) {
        if (hashes.has(parts[0])) {
          parts[0] = hashes.get(parts[0])!
        }
        return path.join(paths.workspacesConfigDirectory, ...parts)
      }
    }

    const oldPlugins = path.join(root, 'plugins')
    if (value.startsWith(`${oldPlugins}${path.sep}`)) {
      const rel = path.relative(oldPlugins, value)
      if (!rel.startsWith(`packages${path.sep}`) && !rel.startsWith(`data${path.sep}`)) {
        return path.join(paths.pluginPackagesDirectory, rel)
      }
    }

    const oldPluginData = path.join(root, 'plugin-data')
    if (value === oldPluginData || value.startsWith(`${oldPluginData}${path.sep}`)) {
      const rel = path.relative(oldPluginData, value)
      const firstSegment = rel.split(path.sep)[0]
      if (isBuiltinModuleId(firstSegment)) {
        return path.join(paths.modulesDirectory, rel)
      }
      return path.join(paths.pluginDataDirectory, rel)
    }

    const oldSkills = path.join(root, 'skills')
    if (value === oldSkills || value.startsWith(`${oldSkills}${path.sep}`)) {
      return path.join(paths.skillsDirectory, path.relative(oldSkills, value))
    }
    const oldThemes = path.join(root, 'themes')
    if (value === oldThemes || value.startsWith(`${oldThemes}${path.sep}`)) {
      return path.join(paths.themesDirectory, path.relative(oldThemes, value))
    }
    const oldBuiltin = path.join(root, 'builtin-resources', 'skills')
    if (value === oldBuiltin || value.startsWith(`${oldBuiltin}${path.sep}`)) {
      return path.join(paths.builtinSkillsDirectory, path.relative(oldBuiltin, value))
    }

    return value
  }

  const fields = (entry: RecordValue, names: string[]) => {
    for (const name of names) {
      if (typeof entry[name] === 'string') entry[name] = relocatePath(entry[name] as string)
    }
  }

  // 18. 在 staging 中重命名哈希发生变化的目录
  for (const [from, to] of hashes) {
    if (from === to) continue
    const sOld = path.join(staging, storageLayoutRelativePaths.sessionsDataDirectory, from)
    const sNew = path.join(staging, storageLayoutRelativePaths.sessionsDataDirectory, to)
    if (await optionalStat(sOld)) {
      await rename(sOld, sNew)
    }
    const wOld = path.join(staging, storageLayoutRelativePaths.workspacesConfigDirectory, from)
    const wNew = path.join(staging, storageLayoutRelativePaths.workspacesConfigDirectory, to)
    if (await optionalStat(wOld)) {
      await rename(wOld, wNew)
    }
  }

  // 19. 重写 staging 内的 projects.json 与预先记录 worktree 修复清单
  const worktreesToRepair: WorktreeRelocation[] = []
  const stagedProjects = path.join(staging, storageLayoutRelativePaths.projectsFile)
  if (await optionalStat(stagedProjects)) {
    const doc = record(await readJson(stagedProjects))
    for (const entry of records(doc.projects)) fields(entry, ['cwd'])
    for (const entry of records(doc.worktrees)) {
      if (typeof entry.checkoutRoot === 'string' && typeof entry.sourceProjectCwd === 'string') {
        const from = entry.checkoutRoot
        const to = relocatePath(from)
        if (from !== to) {
          worktreesToRepair.push({ from, to, repository: entry.sourceProjectCwd })
        }
      }
      fields(entry, ['checkoutRoot', 'cwd', 'sourceProjectCwd'])
    }
    await writeJson(stagedProjects, doc)
  }
  ledger.worktrees = worktreesToRepair

  // 20. 重写 staging 内的 control/snapshot.json
  const stagedSnapshot = path.join(staging, storageLayoutRelativePaths.controlSnapshotFile)
  if (await optionalStat(stagedSnapshot)) {
    const doc = record(await readJson(stagedSnapshot))
    for (const entry of records(doc.projects)) fields(entry, ['cwd'])
    for (const entry of records(doc.sessions)) fields(entry, ['cwd', 'sessionFile'])
    await writeJson(stagedSnapshot, doc)
  }

  // 20.1 重写 staging 内的 control/events.jsonl
  const stagedEvents = path.join(staging, storageLayoutRelativePaths.controlEventsFile)
  if (await optionalStat(stagedEvents)) {
    const content = await readFile(stagedEvents, 'utf8')
    let changed = false
    const lines = content.split('\n').map((line) => {
      if (!line.trim()) return line
      const entry = record(JSON.parse(line))
      let lineChanged = false
      const applyMutation = (mut: RecordValue) => {
        if (mut.kind === 'project_upsert' && mut.project) {
          const oldCwd = (mut.project as RecordValue).cwd
          fields(record(mut.project), ['cwd'])
          if ((mut.project as RecordValue).cwd !== oldCwd) lineChanged = true
        } else if (mut.kind === 'session_upsert' && mut.session) {
          const sess = record(mut.session)
          const oldCwd = sess.cwd
          const oldFile = sess.sessionFile
          fields(sess, ['cwd', 'sessionFile'])
          if (sess.cwd !== oldCwd || sess.sessionFile !== oldFile) lineChanged = true
        } else if (mut.kind === 'receipt_upsert' && mut.receipt) {
          const rec = record(mut.receipt)
          if (rec.session && typeof rec.session === 'object') {
            const s = record(rec.session)
            const oldFile = s.sessionFile
            fields(s, ['sessionFile'])
            if (s.sessionFile !== oldFile) lineChanged = true
          }
        } else if (mut.kind === 'session_receipt_upsert') {
          if (mut.session) {
            const sess = record(mut.session)
            const oldCwd = sess.cwd
            const oldFile = sess.sessionFile
            fields(sess, ['cwd', 'sessionFile'])
            if (sess.cwd !== oldCwd || sess.sessionFile !== oldFile) lineChanged = true
          }
          if (mut.receipt && typeof mut.receipt === 'object') {
            const rec = record(mut.receipt)
            if (rec.session && typeof rec.session === 'object') {
              const s = record(rec.session)
              const oldFile = s.sessionFile
              fields(s, ['sessionFile'])
              if (s.sessionFile !== oldFile) lineChanged = true
            }
          }
        }
      }
      if (entry.mutation && typeof entry.mutation === 'object') {
        applyMutation(record(entry.mutation))
      }
      if (Array.isArray(entry.mutations)) {
        for (const m of entry.mutations) {
          if (m && typeof m === 'object') applyMutation(record(m))
        }
      }
      if (entry.event && typeof entry.event === 'object') {
        const ev = record(entry.event)
        if (ev.value && typeof ev.value === 'object') {
          const val = record(ev.value)
          if (typeof val.cwd === 'string' || typeof val.sessionFile === 'string') {
            const oldCwd = val.cwd
            const oldFile = val.sessionFile
            fields(val, ['cwd', 'sessionFile'])
            if (val.cwd !== oldCwd || val.sessionFile !== oldFile) lineChanged = true
          }
        }
      }
      if (lineChanged) {
        changed = true
        return JSON.stringify(entry)
      }
      return line
    })
    if (changed) {
      await writeText(stagedEvents, lines.join('\n'))
    }
  }

  // 20.2 重写 staging 内的 control/operations.jsonl
  const stagedOps = path.join(staging, storageLayoutRelativePaths.controlOperationsFile)
  if (await optionalStat(stagedOps)) {
    const content = await readFile(stagedOps, 'utf8')
    let changed = false
    const lines = content.split('\n').map((line) => {
      if (!line.trim()) return line
      const entry = record(JSON.parse(line))
      let lineChanged = false
      if (entry.result && typeof entry.result === 'object') {
        const res = record(entry.result)
        if (typeof res.cwd === 'string' || typeof res.sessionFile === 'string') {
          const oldCwd = res.cwd
          const oldFile = res.sessionFile
          fields(res, ['cwd', 'sessionFile'])
          if (res.cwd !== oldCwd || res.sessionFile !== oldFile) lineChanged = true
        }
        if (res.session && typeof res.session === 'object') {
          const s = record(res.session)
          const oldFile = s.sessionFile
          fields(s, ['sessionFile'])
          if (s.sessionFile !== oldFile) lineChanged = true
        }
        if (res.project && typeof res.project === 'object') {
          const p = record(res.project)
          const oldCwd = p.cwd
          fields(p, ['cwd'])
          if (p.cwd !== oldCwd) lineChanged = true
        }
      }
      if (lineChanged) {
        changed = true
        return JSON.stringify(entry)
      }
      return line
    })
    if (changed) {
      await writeText(stagedOps, lines.join('\n'))
    }
  }

  // 21. 重写 staging 内的 collaboration roots
  const stagedCollabRoots = path.join(staging, storageLayoutRelativePaths.collaborationRootsDirectory)
  if (await optionalStat(stagedCollabRoots)) {
    for (const f of await readdir(stagedCollabRoots)) {
      if (!f.endsWith('.json') || f.startsWith('.')) continue
      const target = path.join(stagedCollabRoots, f)
      const part = record(await readJson(target))
      for (const entry of records(part.records)) {
        fields(record(entry.summary), ['cwd', 'sessionFile'])
        for (const reply of records(entry.replies)) {
          const res = record(reply.result)
          if ('agentId' in res) fields(res, ['cwd', 'sessionFile'])
          if (res.agent) fields(record(res.agent), ['cwd', 'sessionFile'])
          for (const a of records(res.agents)) fields(a, ['cwd', 'sessionFile'])
        }
      }
      await writeJson(target, part)
    }
  }

  // 22. 重写 staging 内的 config/app.json
  const stagedSettings = path.join(staging, storageLayoutRelativePaths.appConfigFile)
  if (await optionalStat(stagedSettings)) {
    const doc = record(await readJson(stagedSettings))
    if (Array.isArray(doc.pinnedPaths)) {
      doc.pinnedPaths = doc.pinnedPaths.map((p) => (typeof p === 'string' ? relocatePath(p) : p))
    }
    const itemKey = (key: string): string => {
      try {
        const tuple: unknown = JSON.parse(key)
        if (Array.isArray(tuple) && tuple.length === 3 && tuple[0] === 'local' && typeof tuple[2] === 'string')
          return JSON.stringify([tuple[0], tuple[1], relocatePath(tuple[2])])
      } catch {
        /* 非本机键保持原样 */
      }
      return key
    }
    if (doc.sidebar) {
      const sidebar = record(doc.sidebar)
      if (sidebar.orders) {
        sidebar.orders = Object.fromEntries(
          Object.entries(record(sidebar.orders)).map(([key, values]) => {
            if (!Array.isArray(values) || values.some((v) => typeof v !== 'string')) return [key, values]
            return [key.startsWith('project:') ? `project:${itemKey(key.slice(8))}` : key, values.map(itemKey)]
          }),
        )
      }
    }
    await writeJson(stagedSettings, doc)
  }

  // 23. 重写 staging 内的 agent-permissions.json
  const stagedPerms = path.join(staging, storageLayoutRelativePaths.agentPermissionsFile)
  if (await optionalStat(stagedPerms)) {
    const doc = record(await readJson(stagedPerms))
    const updated: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(doc)) {
      updated[relocatePath(k)] = v
    }
    await writeJson(stagedPerms, updated)
  }

  // 24. 重写 staging 内的 state/plugins.json
  const stagedPlugins = path.join(staging, storageLayoutRelativePaths.pluginsFile)
  if (await optionalStat(stagedPlugins)) {
    const doc = record(await readJson(stagedPlugins))
    for (const p of records(doc.records)) fields(p, ['directory', 'sourceDirectory'])
    await writeJson(stagedPlugins, doc)
  }

  // 25. 重写 staging 内的 state/resources.json (特别处理相对路径 ownerIds 与缺失旧状态时的 loose 技能补齐)
  const stagedRes = path.join(staging, storageLayoutRelativePaths.resourcesFile)
  const skillsBackupDir = path.join(ledger.backupDir, 'skills')
  const builtinBackupDir = (await optionalStat(path.join(ledger.backupDir, 'builtin-resources', 'skills')))
    ? path.join(ledger.backupDir, 'builtin-resources', 'skills')
    : (await optionalStat(path.join(ledger.backupDir, 'pi', 'builtin-skills')))
      ? path.join(ledger.backupDir, 'pi', 'builtin-skills')
      : undefined

  if ((await optionalStat(stagedRes)) || (await optionalStat(skillsBackupDir)) || builtinBackupDir) {
    const doc = (await optionalStat(stagedRes))
      ? record(await readJson(stagedRes))
      : { generation: 1, ownerIds: {}, policies: {}, imports: [] }
    const owners = doc.ownerIds ? record(doc.ownerIds) : {}
    const updatedOwners: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(owners)) {
      let nextKey = k
      if (k.startsWith('skills/')) {
        nextKey = `${storageLayoutRelativePaths.skillsDirectory}/${k.slice('skills/'.length)}`
      } else if (k.startsWith('builtin-resources/skills/')) {
        nextKey = `${storageLayoutRelativePaths.builtinSkillsDirectory}/${k.slice('builtin-resources/skills/'.length)}`
      } else if (k.startsWith('standalone-workspaces/')) {
        nextKey = `${storageLayoutRelativePaths.standaloneWorkspacesDirectory}/${k.slice('standalone-workspaces/'.length)}`
      } else if (k.startsWith('worktrees/')) {
        nextKey = `${storageLayoutRelativePaths.worktreesDirectory}/${k.slice('worktrees/'.length)}`
      }
      updatedOwners[nextKey] = v
    }
    // 自动为所有 loose 技能与 builtin 技能预先保留基于旧绝对路径的 ownerId，确保 ResourceStore.scan 算出的 resource ID 及 policy 保持一致
    if (await optionalStat(skillsBackupDir)) {
      for (const name of await readdir(skillsBackupDir)) {
        if (name.startsWith('.')) continue
        const newKey = path.join(storageLayoutRelativePaths.skillsDirectory, name)
        updatedOwners[newKey] ??= resourceIdentity(path.join(root, 'skills', name))
      }
    }
    if (builtinBackupDir) {
      for (const name of await readdir(builtinBackupDir)) {
        if (name.startsWith('.')) continue
        const newKey = path.join(storageLayoutRelativePaths.builtinSkillsDirectory, name)
        const oldRel = path.relative(ledger.backupDir, path.join(builtinBackupDir, name))
        updatedOwners[newKey] ??= resourceIdentity(path.join(root, oldRel))
      }
    }
    doc.ownerIds = updatedOwners
    for (const entry of records(doc.imports)) fields(entry, ['directory', 'sourcePath'])
    await mkdir(path.dirname(stagedRes), { recursive: true })
    await writeJson(stagedRes, doc)
  }

  // 26. 重写 staging 内的所有 session jsonl 文件
  const stagedSessionsDir = path.join(staging, storageLayoutRelativePaths.sessionsDataDirectory)
  if (await optionalStat(stagedSessionsDir)) {
    const sessionFiles = (await listFiles(stagedSessionsDir)).filter((f) => f.endsWith('.jsonl'))
    for (const file of sessionFiles) {
      const content = await readFile(file, 'utf8')
      let changed = false
      const lines = content.split('\n').map((line) => {
        if (!line.trim()) return line
        const entry = record(JSON.parse(line))
        let lineChanged = false
        if (entry.type === 'session') {
          const oldCwd = entry.cwd
          const oldParent = entry.parentSession
          fields(entry, ['cwd', 'parentSession'])
          if (entry.cwd !== oldCwd || entry.parentSession !== oldParent) lineChanged = true
        } else if (entry.type === 'custom' && entry.customType === 'pi-meme.skill-use' && entry.data) {
          const d = record(entry.data)
          const oldPath = d.path
          fields(d, ['path'])
          if (d.path !== oldPath) lineChanged = true
        } else if (entry.type === 'message' && entry.message && typeof entry.message === 'object') {
          const msg = record(entry.message)
          if (typeof msg.content === 'string') {
            const updated = relocateAttachmentBlock(msg.content, relocatePath)
            if (updated !== msg.content) {
              msg.content = updated
              lineChanged = true
            }
          } else if (Array.isArray(msg.content)) {
            let partsChanged = false
            const updatedParts = (msg.content as unknown[]).map((part) => {
              if (part && typeof part === 'object' && typeof (part as RecordValue).text === 'string') {
                const oldText = (part as RecordValue).text as string
                const newText = relocateAttachmentBlock(oldText, relocatePath)
                if (newText !== oldText) {
                  partsChanged = true
                  return { ...part, text: newText }
                }
              }
              return part
            })
            if (partsChanged) {
              msg.content = updatedParts
              lineChanged = true
            }
          }
        } else if (entry.type === 'context_edit' && entry.replacement && typeof entry.replacement === 'object') {
          const repl = record(entry.replacement)
          if (typeof repl.content === 'string') {
            const updated = relocateAttachmentBlock(repl.content, relocatePath)
            if (updated !== repl.content) {
              repl.content = updated
              lineChanged = true
            }
          } else if (Array.isArray(repl.content)) {
            let partsChanged = false
            const updatedParts = (repl.content as unknown[]).map((part) => {
              if (part && typeof part === 'object' && typeof (part as RecordValue).text === 'string') {
                const oldText = (part as RecordValue).text as string
                const newText = relocateAttachmentBlock(oldText, relocatePath)
                if (newText !== oldText) {
                  partsChanged = true
                  return { ...part, text: newText }
                }
              }
              return part
            })
            if (partsChanged) {
              repl.content = updatedParts
              lineChanged = true
            }
          }
        }
        if (lineChanged) {
          changed = true
          return JSON.stringify(entry)
        }
        return line
      })
      if (changed) {
        await writeText(file, lines.join('\n'))
      }
    }
  }

  // 27. 预计算 staging 中所有待发布文件的哈希清单与目录移动记录
  const publishItems: PublishItem[] = []
  const allStagedFiles = await listFiles(staging)
  for (const f of allStagedFiles) {
    const rel = path.relative(staging, f)
    const hash = await digest(f)
    publishItems.push({ relative: rel, hash, kind: 'file' })
  }
  ledger.publishItems = publishItems

  const dirMoves: DirMoveRecord[] = []
  const addDirMove = async (fromRel: string, toRel: string) => {
    const srcDir = path.join(root, fromRel)
    const fingerprint = (await optionalStat(srcDir))?.isDirectory() ? await dirFingerprint(srcDir) : undefined
    dirMoves.push({ fromRelative: fromRel, toRelative: toRel, fingerprint })
  }

  const standaloneMoveSrc = (await optionalStat(path.join(root, 'standalone-workspaces')))
    ? path.join(root, 'standalone-workspaces')
    : undefined
  if (standaloneMoveSrc) {
    for (const name of await readdir(standaloneMoveSrc)) {
      if (name.startsWith('.')) continue
      await addDirMove(
        path.join('standalone-workspaces', name),
        path.join(storageLayoutRelativePaths.standaloneWorkspacesDirectory, name),
      )
    }
  }

  const worktreesMoveSrc = (await optionalStat(path.join(root, 'worktrees'))) ? path.join(root, 'worktrees') : undefined
  if (worktreesMoveSrc) {
    for (const name of await readdir(worktreesMoveSrc)) {
      if (name.startsWith('.')) continue
      await addDirMove(path.join('worktrees', name), path.join(storageLayoutRelativePaths.worktreesDirectory, name))
    }
  }

  const oldSkills = (await optionalStat(path.join(root, 'skills'))) ? path.join(root, 'skills') : undefined
  if (oldSkills) {
    for (const name of await readdir(oldSkills)) {
      if (name.startsWith('.')) continue
      await addDirMove(path.join('skills', name), path.join(storageLayoutRelativePaths.skillsDirectory, name))
    }
  }

  const oldThemes = (await optionalStat(path.join(root, 'themes'))) ? path.join(root, 'themes') : undefined
  if (oldThemes) {
    for (const name of await readdir(oldThemes)) {
      if (name.startsWith('.')) continue
      await addDirMove(path.join('themes', name), path.join(storageLayoutRelativePaths.themesDirectory, name))
    }
  }

  const oldBuiltinSkills = (await optionalStat(path.join(root, 'builtin-resources', 'skills')))
    ? path.join(root, 'builtin-resources', 'skills')
    : undefined
  if (oldBuiltinSkills) {
    for (const name of await readdir(oldBuiltinSkills)) {
      if (name.startsWith('.')) continue
      await addDirMove(
        path.join('builtin-resources', 'skills', name),
        path.join(storageLayoutRelativePaths.builtinSkillsDirectory, name),
      )
    }
  }

  const oldPlugins = (await optionalStat(path.join(root, 'plugins'))) ? path.join(root, 'plugins') : undefined
  if (oldPlugins) {
    for (const name of await readdir(oldPlugins)) {
      if (['installed.json', 'packages', 'data'].includes(name) || name.startsWith('.')) continue
      const srcE = path.join(oldPlugins, name)
      const s = await optionalStat(srcE)
      if (!s?.isDirectory()) continue
      if (name.startsWith('builtin-')) {
        await addDirMove(path.join('plugins', name), path.relative(root, path.join(ledger.legacyDir, name)))
      } else {
        await addDirMove(
          path.join('plugins', name),
          path.join(storageLayoutRelativePaths.pluginPackagesDirectory, name),
        )
      }
    }
  }

  ledger.dirMoves = dirMoves
}

/** 阶段 3：发布 Staged 文件，搬迁用户实际工作目录，归档 legacy，执行 Worktree repair */
async function executePublishStage(
  root: string,
  paths: ReturnType<typeof createHostStoragePaths>,
  ledger: UpgradeLedger,
) {
  const staging = ledger.stagingDir

  // 0.0 校验源文件完整性：任何仍存在于 root 中的旧版源文件，其哈希必须严格等于备份时刻的冻结指纹；严禁存在升级期间新增的未备份文件！
  const backupManifestFile = path.join(ledger.backupDir, 'backup-manifest.json')
  const backupManifest = await readJson<Record<string, string>>(backupManifestFile)
  if (!backupManifest || typeof backupManifest !== 'object' || Array.isArray(backupManifest)) {
    throw new Error(`布局升级中止：备份清单缺失或损坏（${backupManifestFile}）`)
  }

  // 1) 校验备份清单中的每一项：必须通过 physicalPath 校验，严禁包含越界段（如 ..）或符号链接，且哈希必须为 64 位十六进制
  for (const [rel, frozenHash] of Object.entries(backupManifest)) {
    if (typeof frozenHash !== 'string' || !/^[a-f0-9]{64}$/.test(frozenHash)) {
      throw new Error(`布局升级中止：备份清单中包含非法哈希值：${rel}`)
    }
    await physicalPath(root, rel)
    const srcFile = path.join(root, rel)
    const st = await optionalStat(srcFile)
    if (st && st.isFile()) {
      const currentHash = await digest(srcFile)
      if (currentHash !== frozenHash) {
        throw new Error(`升级中止：检测到数据源文件在升级期间被修改：${rel}，为防止覆盖最新数据已停止升级`)
      }
    }
  }

  // 2) 逆向检测：扫描 root 下所有属于旧版受管目录的实际文件，严禁存在备份清单之外的新增文件！
  const oldManagedDirs = ['pi', 'profile', 'requests', 'sessions', 'attachments', 'plans', 'plugin-data']
  for (const dirName of oldManagedDirs) {
    const dirPath = path.join(root, dirName)
    if (await optionalStat(dirPath)) {
      const filesOnDisk = await listFiles(dirPath)
      for (const file of filesOnDisk) {
        const rel = path.relative(root, file)
        if (!(rel in backupManifest)) {
          throw new Error(`升级中止：检测到数据源目录在升级期间新增了未备份文件：${rel}，为防止数据丢失已停止升级`)
        }
      }
    }
  }

  // 0.1 预先做发布文件冲突与非常规文件/symlink检测
  for (const item of ledger.publishItems) {
    await physicalPath(root, item.relative)
    const targetFile = path.join(root, item.relative)
    const targetStat = await optionalStat(targetFile)
    if (targetStat) {
      if (!targetStat.isFile()) {
        throw new Error(`发布冲突：目标路径已存在非常规文件或目录：${item.relative}`)
      }
      const currentHash = await digest(targetFile)
      if (currentHash !== item.hash) {
        throw new Error(`发布冲突：目标文件已存在且内容不属于本次升级：${item.relative}`)
      }
    }
  }

  // 0.2 预先做目录搬迁冲突与指纹核验检测
  for (const move of ledger.dirMoves ?? []) {
    await physicalPath(root, move.fromRelative)
    await physicalPath(root, move.toRelative)
    const targetDir = path.join(root, move.toRelative)
    const targetStat = await optionalStat(targetDir)
    const srcDir = path.join(root, move.fromRelative)
    const srcStat = await optionalStat(srcDir)

    if (srcStat) {
      if (targetStat) {
        throw new Error(`发布冲突：目标目录已存在：${move.toRelative}（来源目录：${move.fromRelative}）`)
      }
      if (move.fingerprint && srcStat.isDirectory()) {
        const currentFp = await dirFingerprint(srcDir)
        if (currentFp !== move.fingerprint) {
          throw new Error(`升级中止：检测到数据源目录在升级期间被修改：${move.fromRelative}`)
        }
      }
    } else if (targetStat && targetStat.isDirectory() && move.fingerprint) {
      const targetFp = await dirFingerprint(targetDir)
      if (targetFp !== move.fingerprint) {
        throw new Error(`发布冲突：已存在的目标目录指纹不匹配本次任务：${move.toRelative}`)
      }
    }
  }

  // 1. 搬迁用户工作区与插件目录（精确按 ledger.dirMoves 移动，遇冲突立即抛错）
  for (const move of ledger.dirMoves ?? []) {
    const srcDir = path.join(root, move.fromRelative)
    const targetDir = path.join(root, move.toRelative)
    if (await optionalStat(srcDir)) {
      if (await optionalStat(targetDir)) {
        throw new Error(`发布冲突：目标目录已存在：${move.toRelative}`)
      }
      await mkdir(path.dirname(targetDir), { recursive: true, mode: 0o700 })
      await rename(srcDir, targetDir)
    }
  }

  // 1.7 legacy 归档
  const legacyCandidates = ['validation-sources', 'validation-results', 'extensions', 'secure/credentials.bin']
  for (const legacyItem of legacyCandidates) {
    const fullLegacy = path.join(root, legacyItem)
    if (await optionalStat(fullLegacy)) {
      await physicalPath(root, legacyItem)
      const dest = path.join(ledger.legacyDir, path.basename(legacyItem))
      await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 })
      if (!(await optionalStat(dest))) await rename(fullLegacy, dest)
    }
  }

  // 清理空的旧父目录
  for (const oldParent of ['standalone-workspaces', 'worktrees', 'skills', 'themes', 'builtin-resources', 'plugins']) {
    const oldDir = path.join(root, oldParent)
    if (await optionalStat(oldDir)) {
      const remaining = await readdir(oldDir).catch(() => [])
      if (remaining.length === 0) {
        await rmdir(oldDir).catch(() => {})
      }
    }
  }

  // 2. 将已被完整转入 staging 且核验匹配的旧源文件移入本任务备份归档
  // 严格受限范围：仅归档被搬迁/重写且已发布到新路径的旧源，严禁移动在新布局仍保留原路径的资源（如 resources/snapshots/）
  const originalsDir = path.join(ledger.backupDir, 'originals')
  await mkdir(originalsDir, { recursive: true, mode: 0o700 })

  const shouldArchiveToOriginals = (rel: string): boolean => {
    // 显式白名单：新布局中保持原路径或属于新结构的资源严禁移走
    if (rel.startsWith('resources/snapshots/') || rel === 'resources/snapshots') return false
    if (rel.startsWith('resources/builtin-skills/') || rel === 'resources/builtin-skills') return false
    if (rel.startsWith('resources/skills/') || rel === 'resources/skills') return false
    if (rel.startsWith('resources/themes/') || rel === 'resources/themes') return false

    // 需归档的旧版源文件/旧版受管目录前缀
    const oldSourcePrefixes = [
      'settings.json',
      'auth.json',
      'projects.json',
      'goals.json',
      'agent-permissions.json',
      'control.json',
      'collaboration.json',
      'resources/state.json',
      'plugins/installed.json',
      'pi/',
      'requests/',
      'sessions/',
      'attachments/',
      'plans/',
      'profile/',
      'plugin-data/',
      'sessions-cache.json',
      'sessions-cache.json.tmp',
      'remote-services.json',
      'remote-services.json.tmp',
      'settings.json.tmp',
      'auth.json.tmp',
      'projects.json.tmp',
      'goals.json.tmp',
      'agent-permissions.json.tmp',
      'control.json.tmp',
      'collaboration.json.tmp',
    ]

    if (oldSourcePrefixes.some((p) => rel === p || (p.endsWith('/') && rel.startsWith(p)))) {
      return true
    }

    // 旧版 workspaces/<64位hash>/
    if (rel.startsWith('workspaces/')) {
      const seg = rel.slice('workspaces/'.length).split(path.sep)[0]
      if (/^[a-f0-9]{64}$/.test(seg)) return true
    }

    return false
  }

  if (backupManifest) {
    for (const rel of Object.keys(backupManifest)) {
      if (!shouldArchiveToOriginals(rel)) continue
      await physicalPath(root, rel)
      const srcFile = path.join(root, rel)
      if (await optionalStat(srcFile)) {
        const archiveDest = path.join(originalsDir, rel)
        await physicalPath(originalsDir, rel)
        await mkdir(path.dirname(archiveDest), { recursive: true, mode: 0o700 })
        await rename(srcFile, archiveDest)
      }
    }
  }

  // 3. 递归清理已空的旧受管父目录（使用非递归 rmdir，若非空绝不静默删除）
  const cleanEmptyDir = async (dir: string) => {
    try {
      const entries = await readdir(dir)
      for (const entry of entries) {
        const full = path.join(dir, entry)
        const st = await optionalStat(full)
        if (st?.isDirectory()) {
          await cleanEmptyDir(full)
        }
      }
      const remaining = await readdir(dir)
      if (remaining.length === 0) {
        await rmdir(dir)
      }
    } catch {
      // ignore
    }
  }

  for (const oldFolder of ['pi', 'requests', 'sessions', 'attachments', 'plans', 'profile', 'plugin-data']) {
    const p = path.join(root, oldFolder)
    if (await optionalStat(p)) {
      await cleanEmptyDir(p)
    }
  }
  const oldWs = path.join(root, 'workspaces')
  if (await optionalStat(oldWs)) {
    const entries = await readdir(oldWs)
    if (entries.every((e) => /^[a-f0-9]{64}$/.test(e))) {
      await cleanEmptyDir(oldWs)
    }
  }

  // 3. 将 staging 中的所有文件原子发布到 root 对应位置并校验哈希
  for (const item of ledger.publishItems) {
    const stagedFile = path.join(staging, item.relative)
    const targetFile = path.join(root, item.relative)

    // 检查 target 是否已存在且哈希匹配（重入幂等）
    const targetStat = await optionalStat(targetFile)
    if (targetStat && targetStat.isFile()) {
      const targetHash = await digest(targetFile)
      if (targetHash === item.hash) continue
    }

    if (await optionalStat(stagedFile)) {
      await mkdir(path.dirname(targetFile), { recursive: true, mode: 0o700 })
      await rename(stagedFile, targetFile)
      const publishedHash = await digest(targetFile)
      if (publishedHash !== item.hash) {
        throw new Error(`发布校验失败：${item.relative} 哈希不匹配`)
      }
    } else if (!targetStat) {
      throw new Error(`发布失败：无法在 staging 或目标位置找到文件 ${item.relative}`)
    }
  }

  // 4. 执行 Git worktree repair 并校验
  for (const wt of ledger.worktrees) {
    await runGit(wt.repository, ['worktree', 'repair', wt.to])
    const checked = (await runGit(wt.to, ['rev-parse', '--show-toplevel'])).stdout.trim()
    if ((await realpath(checked)) !== (await realpath(wt.to))) {
      throw new Error(`Git Worktree 修复校验失败：${wt.to}`)
    }
  }
}

/** 阶段 4 校验：验证核心元数据与权限 */
async function verifyUpgradedLayout(paths: ReturnType<typeof createHostStoragePaths>) {
  if (!(await optionalStat(paths.hostIdFile))) {
    throw new Error(`升级校验失败：缺失 ${paths.hostIdFile}`)
  }
  if (await optionalStat(paths.appConfigFile)) {
    await readJson(paths.appConfigFile)
  }
  if (await optionalStat(paths.projectsFile)) {
    await readJson(paths.projectsFile)
  }
  if (await optionalStat(paths.controlSnapshotFile)) {
    await readJson(paths.controlSnapshotFile)
  }
  if (await optionalStat(paths.pluginsFile)) {
    await readJson(paths.pluginsFile)
  }
  if (await optionalStat(paths.authFile)) {
    const authStat = await optionalStat(paths.authFile)
    if (authStat && (authStat.mode & 0o777) !== 0o600) {
      await chmod(paths.authFile, 0o600)
    }
  }
}

async function copyDirRecursive(src: string, dest: string) {
  await mkdir(dest, { recursive: true })
  for (const entry of await readdir(src)) {
    const srcPath = path.join(src, entry)
    const destPath = path.join(dest, entry)
    const s = await optionalStat(srcPath)
    if (s?.isDirectory()) {
      await copyDirRecursive(srcPath, destPath)
    } else if (s?.isFile()) {
      await copyFile(srcPath, destPath)
    }
  }
}
