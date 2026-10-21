import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'vitest'
import { saveCollaborationRoot } from '@pi-meme/subagents/server/collaboration-store'
import { RequestRegistry } from '../src/request-registry'
import { relocatedMarker, storageOwnerFile } from '../src/data-root'
import { createHostStoragePaths } from '../src/storage/paths'
import { cleanupTemporaryFiles } from '../src/storage/cleanup-temporary-files'

async function setup() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cleanup-temporary-files-')))
  const paths = createHostStoragePaths(root)
  // 初始化必要目录
  await mkdir(paths.controlDirectory, { recursive: true })
  await mkdir(paths.credentialsDirectory, { recursive: true })
  await mkdir(paths.stateDirectory, { recursive: true })
  await mkdir(paths.collaborationDirectory, { recursive: true })
  await mkdir(paths.collaborationRootsDirectory, { recursive: true })
  await mkdir(paths.plansDataDirectory, { recursive: true })
  await mkdir(paths.cacheDirectory, { recursive: true })
  return { root, paths }
}

test('精确 owner 命中：仅当对应正式文件存在且通过严格结构校验时删除残骸，保留正式文件', async () => {
  const { root, paths } = await setup()
  try {
    // 1. Control snapshot 与 events (严格 version 2 快照)
    await writeFile(
      paths.controlSnapshotFile,
      JSON.stringify({
        version: 2,
        journalEpoch: 'epoch-1',
        appliedCommitSeq: 10,
        seq: 10,
        projects: [],
        sessions: [],
        receipts: [],
      }),
    )
    const snapTmp = `${paths.controlSnapshotFile}.tmp`
    await writeFile(snapTmp, 'old-snap-temp')

    await writeFile(
      paths.controlEventsFile,
      `${JSON.stringify({ commitSeq: 1, journalEpoch: 'epoch-1', timestamp: '2026-10-21T00:00:00Z' })}\n`,
    )
    const eventsTmp = `${paths.controlEventsFile}.tmp`
    await writeFile(eventsTmp, 'old-events-temp')

    // 2. Requests 哈希日志 (调用真实 RequestRegistry.run 写入规范 journal)
    const registry = new RequestRegistry('host', paths.requestsFile)
    await registry.run(
      { requestId: 'req-1', clientId: 'client-1', hostId: 'host', sessionId: 's1', method: 'test', args: [] },
      async () => ({ result: 'ok' }),
    )
    const requestsTmp = `${paths.requestsFile}.tmp`
    await writeFile(requestsTmp, 'old-requests-temp')

    // 3. Auth credentials (合法字符串键值)
    await writeFile(paths.authFile, JSON.stringify({ 'provider:test': 'key' }))
    const authUuid = randomUUID()
    const authTmp = path.join(paths.credentialsDirectory, `auth.json.${authUuid}.tmp`)
    await writeFile(authTmp, 'old-auth-temp')

    // 4. Goals (真实合法 Goal 记录验证清理)
    const validGoalRecord = {
      goal: {
        session: { sessionId: 'sid-1', hostId: 'host-1' },
        goalId: 'gid-1',
        description: 'valid goal',
        objective: 'do work',
        mode: 'default',
        status: 'active',
        tokensUsed: 0,
        elapsedMs: 0,
        turns: 0,
        revision: 1,
        evidence: ['evidence 1'],
        usageIncomplete: false,
        createdAt: '2026-10-21T00:00:00.000Z',
        updatedAt: '2026-10-21T00:00:00.000Z',
      },
      accounted: [],
      emptyTurns: 0,
    }
    await writeFile(paths.goalsFile, JSON.stringify({ version: 1, goals: { 'sid-1': validGoalRecord } }))
    const goalUuid = randomUUID()
    const goalTmp = path.join(paths.stateDirectory, `goals.json.${goalUuid}.tmp`)
    await writeFile(goalTmp, 'old-goals-temp')

    // 5. Collaboration plans & roots (调用 saveCollaborationRoot 生成真实 schema)
    await writeFile(paths.collaborationPlansFile, JSON.stringify({ version: 1, plans: [] }))
    const plansUuid = randomUUID()
    const plansTmp = path.join(paths.collaborationDirectory, `plans.json.${plansUuid}.tmp`)
    await writeFile(plansTmp, 'old-collab-plans-temp')

    const rootAgentId = 'root-agent-123'
    await saveCollaborationRoot(paths.collaborationRootsDirectory, rootAgentId, {
      version: 1,
      rootAgentId,
      rootSessionKey: 'session-key-1',
      records: [],
      updatedAt: '2026-10-21T00:00:00Z',
    })
    const rootUuid = randomUUID()
    const rootTmp = path.join(paths.collaborationRootsDirectory, `${rootAgentId}.json.${rootUuid}.tmp`)
    await writeFile(rootTmp, 'old-root-temp')

    // 6. Data plans document
    const sessionId = 'session-abc'
    const docId = 'plan-doc-1'
    const sessionPlansDir = paths.sessionPlansDirectory(sessionId)
    await mkdir(sessionPlansDir, { recursive: true })
    const finalDoc = paths.planFile(sessionId, docId)
    await writeFile(finalDoc, '# Plan markdown')
    const docUuid = randomUUID()
    const docTmp = path.join(sessionPlansDir, `${docId}.md.${docUuid}.tmp`)
    await writeFile(docTmp, 'old-plan-doc-temp')

    // 执行清理
    const report = await cleanupTemporaryFiles(paths)

    // 验证所有临时残骸均被成功删除
    assert.ok(report.deleted.includes(snapTmp))
    assert.ok(report.deleted.includes(eventsTmp))
    assert.ok(report.deleted.includes(requestsTmp))
    assert.ok(report.deleted.includes(authTmp))
    assert.ok(report.deleted.includes(goalTmp))
    assert.ok(report.deleted.includes(plansTmp))
    assert.ok(report.deleted.includes(rootTmp))
    assert.ok(report.deleted.includes(docTmp))

    // 验证正式文件依然完整可用
    assert.equal(JSON.parse(await readFile(paths.controlSnapshotFile, 'utf8')).version, 2)
    assert.equal(JSON.parse(await readFile(paths.authFile, 'utf8'))['provider:test'], 'key')
    assert.equal(await readFile(finalDoc, 'utf8'), '# Plan markdown')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('相似用户文件与未知归属文件保留，绝不误删', async () => {
  const { root, paths } = await setup()
  try {
    const userCustom = path.join(paths.stateDirectory, 'my-backup.tmp')
    await writeFile(userCustom, 'keep me')

    const authNonUuid = path.join(paths.credentialsDirectory, 'auth.json.bak.tmp')
    await writeFile(authNonUuid, 'keep me too')

    const randomStateTmp = path.join(paths.stateDirectory, 'notes.tmp')
    await writeFile(randomStateTmp, 'important notes')

    const report = await cleanupTemporaryFiles(paths)

    // 均未被删除
    assert.equal(report.deleted.length, 0)
    assert.equal(await readFile(userCustom, 'utf8'), 'keep me')
    assert.equal(await readFile(authNonUuid, 'utf8'), 'keep me too')
    assert.equal(await readFile(randomStateTmp, 'utf8'), 'important notes')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('正式文件缺失或损坏时保留临时恢复候选，不自动恢复或覆盖', async () => {
  const { root, paths } = await setup()
  try {
    // 场景 A: 正式文件缺失
    const authUuid = randomUUID()
    const missingTargetTmp = path.join(paths.credentialsDirectory, `auth.json.${authUuid}.tmp`)
    await writeFile(missingTargetTmp, 'candidate-auth-data')

    // 场景 B: 正式文件损坏（坏内部记录 { sid: null } 被 isValidGoalState 拒绝；JSONL 缺少末尾换行；Requests 缺少 64 字节 hex）
    await writeFile(paths.goalsFile, JSON.stringify({ version: 1, goals: { 'sid-bad': null } }))
    const corruptedGoalTmp = path.join(paths.stateDirectory, `goals.json.${randomUUID()}.tmp`)
    await writeFile(corruptedGoalTmp, 'candidate-goals-data')

    await writeFile(paths.controlEventsFile, '{"commitSeq":1}') // 缺少完整换行提交边界
    const corruptedEventsTmp = `${paths.controlEventsFile}.tmp`
    await writeFile(corruptedEventsTmp, 'candidate-events-data')

    await writeFile(paths.requestsFile, '{"k":"not-a-64-hex","i":"not-a-64-hex","t":"invalid-date"}\n')
    const corruptedRequestsTmp = `${paths.requestsFile}.tmp`
    await writeFile(corruptedRequestsTmp, 'candidate-requests-data')

    const report = await cleanupTemporaryFiles(paths)

    // 不应被删除
    assert.equal(report.deleted.length, 0)

    // 记录为保留候选
    const missingCandidate = report.retainedCandidates.find((c) => c.temporaryFile === missingTargetTmp)
    assert.ok(missingCandidate)
    assert.equal(missingCandidate.reason, 'target_missing')

    const corruptedGoal = report.retainedCandidates.find((c) => c.temporaryFile === corruptedGoalTmp)
    assert.ok(corruptedGoal)
    assert.equal(corruptedGoal.reason, 'target_corrupted')

    const corruptedEvents = report.retainedCandidates.find((c) => c.temporaryFile === corruptedEventsTmp)
    assert.ok(corruptedEvents)
    assert.equal(corruptedEvents.reason, 'target_corrupted')

    const corruptedRequests = report.retainedCandidates.find((c) => c.temporaryFile === corruptedRequestsTmp)
    assert.ok(corruptedRequests)
    assert.equal(corruptedRequests.reason, 'target_corrupted')

    // 临时文件与损坏文件均原样保留
    assert.equal(await readFile(missingTargetTmp, 'utf8'), 'candidate-auth-data')
    assert.equal(await readFile(corruptedGoalTmp, 'utf8'), 'candidate-goals-data')
    assert.equal(await readFile(corruptedEventsTmp, 'utf8'), 'candidate-events-data')
    assert.equal(await readFile(corruptedRequestsTmp, 'utf8'), 'candidate-requests-data')
    assert.equal(await readFile(paths.goalsFile, 'utf8'), JSON.stringify({ version: 1, goals: { 'sid-bad': null } }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('符号链接防护：复用 physicalPath 逐段拒绝中间与末端 symlink', async () => {
  const { root, paths } = await setup()
  const outside = await realpath(await mkdtemp(path.join(tmpdir(), 'cleanup-outside-')))
  try {
    const externalFile = path.join(outside, 'external.txt')
    await writeFile(externalFile, 'external-data')

    // 临时文件本身是符号链接
    const snapTmpLink = `${paths.controlSnapshotFile}.tmp`
    await writeFile(
      paths.controlSnapshotFile,
      JSON.stringify({
        version: 2,
        journalEpoch: 'epoch-1',
        appliedCommitSeq: 1,
        seq: 1,
        projects: [],
        sessions: [],
        receipts: [],
      }),
    )
    await symlink(externalFile, snapTmpLink)

    const report = await cleanupTemporaryFiles(paths)

    // 符号链接临时文件被拦截并保留，外部文件未被删除
    assert.ok(report.retainedCandidates.some((c) => c.temporaryFile === snapTmpLink && c.reason === 'symlink_detected'))
    assert.equal(await readFile(externalFile, 'utf8'), 'external-data')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('维护状态保护：真实 .storage-layout-upgrade-*.json 或 .pi-meme-relocated.json 时跳过清理', async () => {
  const { root, paths } = await setup()
  try {
    // 写入真实升级账本标记
    const upgradeLedger = path.join(root, '.storage-layout-upgrade-test-123.json')
    await writeFile(upgradeLedger, JSON.stringify({ version: 1, stage: 'preparing' }))

    // 放置一个原本合法的临时文件
    await writeFile(paths.authFile, JSON.stringify({ 'provider:test': 'key' }))
    const authTmp = path.join(paths.credentialsDirectory, `auth.json.${randomUUID()}.tmp`)
    await writeFile(authTmp, 'should-not-delete')

    let report = await cleanupTemporaryFiles(paths)
    assert.equal(report.deleted.length, 0)
    assert.ok(report.skipped.some((s) => s.path === root))
    assert.equal(await readFile(authTmp, 'utf8'), 'should-not-delete')

    // 移除账本，放置 relocated 标记
    await rm(upgradeLedger)
    const relocatedFile = path.join(root, relocatedMarker)
    await writeFile(relocatedFile, JSON.stringify({ relocatedTo: '/other' }))

    report = await cleanupTemporaryFiles(paths)
    assert.equal(report.deleted.length, 0)
    assert.ok(report.skipped.some((s) => s.path === root))

    // 移除 relocated，放置未提交的 storage-job
    await rm(relocatedFile)
    const storageJob = path.join(root, storageOwnerFile)
    await writeFile(storageJob, JSON.stringify({ version: 1, stage: 'preparing' }))

    report = await cleanupTemporaryFiles(paths)
    assert.equal(report.deleted.length, 0)
    assert.ok(report.skipped.some((s) => s.path === root))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
