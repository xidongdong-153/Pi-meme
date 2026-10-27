import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { SessionCleanupService } from '../src/session-cleanup'
import { AgentAccessStore } from '@pi-meme/pi-runtime/access-store'
import { GoalService } from '@pi-meme/goals/server/service'
import { createHostCollaborationBridge } from '@pi-meme/subagents/server/coordinator'

function fakeSession(cwd: string, _notify?: unknown) {
  const sessionId = randomUUID()
  let status = 'ready'
  const session = {
    sessionId,
    cwd,
    getActiveSession: () => ({ sessionId }),
    connection: () => ({ cwd, generation: 1, status }),
    stopAndWait: async () => {
      status = 'disconnected'
    },
    abort: async () => {},
  } as unknown as import('@pi-meme/pi-runtime/session-pool').RuntimeSdkSession
  return { session }
}

test('SessionCleanupService 闭环删除：先终结control回执、清权限、清goals、清协作并安全回收空standalone', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-session-cleanup-'))
  const maintenanceDir = path.join(root, 'state', 'maintenance')
  const permissionsFile = path.join(root, 'state', 'agent-permissions.json')
  const goalsFile = path.join(root, 'state', 'goals.json')
  const sessionsDir = path.join(root, 'data', 'sessions')
  const standaloneParent = path.join(root, 'workspaces', 'standalone')

  await mkdir(maintenanceDir, { recursive: true })
  await mkdir(sessionsDir, { recursive: true })
  await mkdir(standaloneParent, { recursive: true })

  try {
    const accessStore = new AgentAccessStore(permissionsFile)
    const goals = new GoalService({ file: goalsFile, sessionsDirectory: sessionsDir })
    await goals.init()

    const collaboration = createHostCollaborationBridge({
      dataRoot: root,
      collaborationRootsDirectory: path.join(root, 'state', 'collaboration', 'roots'),
      createSession: (cwd, notify) => fakeSession(cwd, notify).session,
      emit: () => {},
    })

    const sessionFile1 = path.join(sessionsDir, 's1.jsonl')
    const sessionFile2 = path.join(sessionsDir, 's2.jsonl')
    await writeFile(sessionFile1, '{"type":"session"}\n')
    await writeFile(sessionFile2, '{"type":"session"}\n')

    await accessStore.set(sessionFile1, 'full-access')
    await accessStore.set(sessionFile2, 'read-only')

    const s1Ref = { hostId: 'h1', sessionId: 's1' }
    const s2Ref = { hostId: 'h1', sessionId: 's2' }
    await goals.start(s1Ref, { objective: '目标1' })
    await goals.start(s2Ref, { objective: '目标2' })

    const emptyStandaloneId = randomUUID()
    const emptyStandaloneDir = path.join(standaloneParent, emptyStandaloneId)
    await mkdir(emptyStandaloneDir)

    const nonEmptyStandaloneId = randomUUID()
    const nonEmptyStandaloneDir = path.join(standaloneParent, nonEmptyStandaloneId)
    await mkdir(nonEmptyStandaloneDir)
    await writeFile(path.join(nonEmptyStandaloneDir, 'user-work.txt'), '用户数据')

    let controlDeleteCalled = false
    const cleanup = new SessionCleanupService({
      maintenanceDirectory: maintenanceDir,
      accessStore,
      goals,
      collaboration,
      control: {
        lookupSessionIds: async () => ({ [sessionFile1]: 's1', [sessionFile2]: 's2' }),
        deleteSessions: async (result) => {
          controlDeleteCalled = true
          assert.deepEqual(result.deletedPaths, [sessionFile1])
          return { deletedSessionIds: ['s1'] }
        },
      },
      isStandaloneDirectory: (cwd) => cwd.startsWith(standaloneParent),
      hasWorkspaceReferences: () => false,
    })

    // 1. 删除前准备阶段，持久化删除意向并权威获取公开 sessionId 映射
    const prepared = await cleanup.prepare([sessionFile1, sessionFile2], emptyStandaloneDir)
    assert.ok(prepared.canonicalKeys.has(sessionFile1))
    assert.equal(prepared.sessionIdsMap.get(sessionFile1), 's1')
    assert.equal(prepared.sessionIdsMap.get(sessionFile2), 's2')

    // 2. 物理删除后调用 afterDelete（仅 s1 成功删除，s2 未删）
    await rm(sessionFile1, { force: true })

    await cleanup.afterDelete(
      { deletedPaths: [sessionFile1], deletedKeys: ['s1-key'], errors: [] },
      prepared,
      emptyStandaloneDir,
    )

    assert.equal(controlDeleteCalled, true)

    // 验证 permissions 已清 s1，保留未删除的 s2
    assert.equal(await accessStore.get(sessionFile1), 'workspace-write')
    assert.equal(await accessStore.get(sessionFile2), 'read-only')

    // 验证 goals 已清 s1，保留未删除的 s2
    assert.equal(goals.get(s1Ref), undefined)
    assert.ok(goals.get(s2Ref))

    // 验证空 standalone 目录已被非递归 rmdir
    await assert.rejects(stat(emptyStandaloneDir), /ENOENT/)

    // 验证测试非空 standalone 目录绝对不会被误删
    await cleanup.afterDelete({ deletedPaths: [], deletedKeys: [], errors: [] }, prepared, nonEmptyStandaloneDir)
    assert.ok((await stat(nonEmptyStandaloneDir)).isDirectory())
    assert.equal(await readFile(path.join(nonEmptyStandaloneDir, 'user-work.txt'), 'utf8'), '用户数据')

    // 验证完成后 pending-cleanup 文件被安全清理
    const pendingFiles = await (await import('node:fs/promises')).readdir(maintenanceDir)
    assert.equal(pendingFiles.filter((f) => f.startsWith('pending-cleanup-')).length, 0)

    await collaboration.stopAndWait()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('断点测试 1：unlink 后尚未写成功结果就崩溃，重启 recoverPending 仅补清确认 ENOENT 项，传空 keys 保护未确认 runtime 会话', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-session-unlink-crash-'))
  const maintenanceDir = path.join(root, 'state', 'maintenance')
  const permissionsFile = path.join(root, 'state', 'agent-permissions.json')
  const goalsFile = path.join(root, 'state', 'goals.json')
  const sessionsDir = path.join(root, 'data', 'sessions')

  await mkdir(maintenanceDir, { recursive: true })
  await mkdir(sessionsDir, { recursive: true })

  try {
    const accessStore = new AgentAccessStore(permissionsFile)
    const goals = new GoalService({ file: goalsFile, sessionsDirectory: sessionsDir })
    await goals.init()

    const collaboration = createHostCollaborationBridge({
      dataRoot: root,
      collaborationRootsDirectory: path.join(root, 'state', 'collaboration', 'roots'),
      createSession: (cwd, notify) => fakeSession(cwd, notify).session,
      emit: () => {},
    })

    const deletedFile = path.join(sessionsDir, 'deleted.jsonl')
    const retainedFile = path.join(sessionsDir, 'retained.jsonl')
    await writeFile(deletedFile, '{"type":"session"}\n')
    await writeFile(retainedFile, '{"type":"session"}\n')

    await accessStore.set(deletedFile, 'full-access')
    await accessStore.set(retainedFile, 'full-access')

    const deletedRef = { hostId: 'h1', sessionId: 'deleted' }
    const retainedRef = { hostId: 'h1', sessionId: 'retained' }
    await goals.start(deletedRef, { objective: '已删目标' })
    await goals.start(retainedRef, { objective: '保留目标' })

    let controlDeleteInput!: { deletedPaths: string[]; deletedKeys: string[] }
    const cleanup = new SessionCleanupService({
      maintenanceDirectory: maintenanceDir,
      accessStore,
      goals,
      collaboration,
      control: {
        lookupSessionIds: async () => ({ [deletedFile]: 'deleted', [retainedFile]: 'retained' }),
        deleteSessions: async (result) => {
          controlDeleteInput = result
          return { deletedSessionIds: ['deleted'] }
        },
      },
    })

    // 1. prepare 阶段：传入 candidatePaths 和未确认的 runtime candidateKey
    await cleanup.prepare([deletedFile, retainedFile, 'runtime:unconfirmed-key'])

    // 2. 物理阶段：只 unlink 了 deletedFile；retainedFile 仍留在磁盘；崩溃发生，未能调用 afterDelete
    await rm(deletedFile, { force: true })

    // 3. 重启恢复（实例化新 cleanup 模拟重启）
    const restartedCleanup = new SessionCleanupService({
      maintenanceDirectory: maintenanceDir,
      accessStore,
      goals,
      collaboration,
      control: {
        lookupSessionIds: async () => ({ [deletedFile]: 'deleted', [retainedFile]: 'retained' }),
        deleteSessions: async (result) => {
          controlDeleteInput = result
          return { deletedSessionIds: ['deleted'] }
        },
      },
    })

    await restartedCleanup.recoverPending()

    // 验证 1：仅已确认 ENOENT 的 deletedFile 触发了补清，retainedFile 绝未被补清！
    assert.deepEqual(controlDeleteInput.deletedPaths, [deletedFile])
    // 验证 2：prepared 恢复时未确认的 candidateKeys 绝不清理，传 [] 保护！
    assert.deepEqual(controlDeleteInput.deletedKeys, [])

    assert.equal(await accessStore.get(deletedFile), 'workspace-write')
    assert.equal(await accessStore.get(retainedFile), 'full-access')

    assert.equal(goals.get(deletedRef), undefined)
    assert.ok(goals.get(retainedRef))

    // intent 文件在恢复后被清理
    const pendingFiles = await (await import('node:fs/promises')).readdir(maintenanceDir)
    assert.equal(pendingFiles.filter((f) => f.startsWith('pending-cleanup-')).length, 0)

    await collaboration.stopAndWait()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('断点测试 2：control 完成后 goal 失败，重启重试时即使 control 返回空仍依据 intent 中的 sessionIdsMap 清理对应 goal', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-session-goal-fail-crash-'))
  const maintenanceDir = path.join(root, 'state', 'maintenance')
  const permissionsFile = path.join(root, 'state', 'agent-permissions.json')
  const goalsFile = path.join(root, 'state', 'goals.json')
  const sessionsDir = path.join(root, 'data', 'sessions')

  await mkdir(maintenanceDir, { recursive: true })
  await mkdir(sessionsDir, { recursive: true })

  try {
    const accessStore = new AgentAccessStore(permissionsFile)
    const goals = new GoalService({ file: goalsFile, sessionsDirectory: sessionsDir })
    await goals.init()

    const collaboration = createHostCollaborationBridge({
      dataRoot: root,
      collaborationRootsDirectory: path.join(root, 'state', 'collaboration', 'roots'),
      createSession: (cwd, notify) => fakeSession(cwd, notify).session,
      emit: () => {},
    })

    const targetFile = path.join(sessionsDir, 'goalcrash.jsonl')
    await writeFile(targetFile, '{"type":"session"}\n')
    const goalRef = { hostId: 'h1', sessionId: 'goalcrash' }
    await goals.start(goalRef, { objective: '需恢复的目标' })
    assert.ok(goals.get(goalRef))

    let controlCallCount = 0
    let goalStepShouldFail = true

    const failingGoalsProxy = new Proxy(goals, {
      get(target, prop, receiver) {
        if (prop === 'deleteSessions' && goalStepShouldFail) {
          return () => Promise.reject(new Error('模拟写入 goals 磁盘失败导致崩溃'))
        }
        return Reflect.get(target, prop, receiver)
      },
    })

    const cleanup = new SessionCleanupService({
      maintenanceDirectory: maintenanceDir,
      accessStore,
      goals: failingGoalsProxy,
      collaboration,
      control: {
        lookupSessionIds: async () => ({ [targetFile]: 'goalcrash' }),
        deleteSessions: async () => {
          controlCallCount++
          if (controlCallCount === 1) {
            return { deletedSessionIds: ['goalcrash'] }
          }
          return { deletedSessionIds: [] }
        },
      },
    })

    // 1. prepare
    const prepared = await cleanup.prepare([targetFile])
    assert.equal(prepared.sessionIdsMap.get(targetFile), 'goalcrash')

    // 2. 物理删除
    await rm(targetFile, { force: true })

    // 3. 执行 afterDelete，第一轮在 goals 步骤抛出异常模拟崩溃
    await assert.rejects(
      cleanup.afterDelete({ deletedPaths: [targetFile], deletedKeys: ['goalcrash-key'], errors: [] }, prepared),
      /模拟写入 goals 磁盘失败/,
    )

    // 此时 control 已经执行过一次，pending intent 依然保留在磁盘上
    assert.equal(controlCallCount, 1)
    const pendingFiles = await (await import('node:fs/promises')).readdir(maintenanceDir)
    assert.equal(pendingFiles.filter((f) => f.startsWith('pending-cleanup-')).length, 1)

    // 4. 重启模拟：恢复正常的 goals 服务
    goalStepShouldFail = false
    const restartedCleanup = new SessionCleanupService({
      maintenanceDirectory: maintenanceDir,
      accessStore,
      goals,
      collaboration,
      control: {
        lookupSessionIds: async () => ({ [targetFile]: 'goalcrash' }),
        deleteSessions: async () => {
          controlCallCount++
          // 第二次重试：control 内部已无此会话，返回空数组
          return { deletedSessionIds: [] }
        },
      },
    })

    // 执行崩溃恢复
    await restartedCleanup.recoverPending()

    assert.equal(controlCallCount, 2)
    // 即使 control 第二次返回空数组，goal 依然根据 intent 中持久化的 sessionIdsMap 成功被清理！
    assert.equal(goals.get(goalRef), undefined)

    // 恢复完成后 intent 记录被移除
    const remainingFiles = await (await import('node:fs/promises')).readdir(maintenanceDir)
    assert.equal(remainingFiles.filter((f) => f.startsWith('pending-cleanup-')).length, 0)

    await collaboration.stopAndWait()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('recoverPending 遇到损坏 intent 抛错并保留原文件，fail-closed 不吞错', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-session-corrupt-intent-'))
  const maintenanceDir = path.join(root, 'state', 'maintenance')
  await mkdir(maintenanceDir, { recursive: true })

  try {
    const corruptFile = path.join(maintenanceDir, 'pending-cleanup-corrupt.json')
    await writeFile(corruptFile, '{ invalid json', 'utf8')

    const cleanup = new SessionCleanupService({
      maintenanceDirectory: maintenanceDir,
      accessStore: new AgentAccessStore(),
      collaboration: createHostCollaborationBridge({
        dataRoot: root,
        createSession: (cwd, notify) => fakeSession(cwd, notify).session,
        emit: () => {},
      }),
    })

    // 遇到损坏 intent，抛出 AggregateError，绝不静默吞错
    await assert.rejects(cleanup.recoverPending(), /部分 pending cleanup 任务恢复失败/)

    // 必须保留损坏的 intent 文件以供排查，不静默删除
    assert.ok((await stat(corruptFile)).isFile())
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('intent 深度合法性校验：非绝对路径、非合法元组、key 不在候选集合均拒绝并保留原文件', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-session-intent-schema-'))
  const maintenanceDir = path.join(root, 'state', 'maintenance')
  await mkdir(maintenanceDir, { recursive: true })

  try {
    const cleanup = new SessionCleanupService({
      maintenanceDirectory: maintenanceDir,
      accessStore: new AgentAccessStore(),
      collaboration: createHostCollaborationBridge({
        dataRoot: root,
        createSession: (cwd, notify) => fakeSession(cwd, notify).session,
        emit: () => {},
      }),
    })

    // 用例 A：candidatePaths 包含相对路径
    const fileA = path.join(maintenanceDir, 'pending-cleanup-a1.json')
    await writeFile(
      fileA,
      JSON.stringify({
        version: 1,
        id: 'a1',
        stage: 'prepared',
        candidatePaths: ['relative/path/session.jsonl'],
        candidateKeys: [],
        canonicalKeys: [],
        sessionIdsMap: [],
        timestamp: new Date().toISOString(),
      }),
    )
    await assert.rejects(
      cleanup.recoverPending(),
      (err: unknown) =>
        err instanceof AggregateError &&
        err.errors.some((e: Error) => /candidatePaths 必须包含绝对路径/.test(e.message)),
    )
    assert.ok((await stat(fileA)).isFile())
    await rm(fileA)

    // 用例 B：sessionIdsMap 中的 key 不在候选集中
    const fileB = path.join(maintenanceDir, 'pending-cleanup-b1.json')
    await writeFile(
      fileB,
      JSON.stringify({
        version: 1,
        id: 'b1',
        stage: 'prepared',
        candidatePaths: ['/tmp/absolute/session.jsonl'],
        candidateKeys: [],
        canonicalKeys: [['/tmp/absolute/session.jsonl', '/tmp/absolute/session.jsonl']],
        sessionIdsMap: [['/other/unknown/key', 'sid-1']],
        timestamp: new Date().toISOString(),
      }),
    )
    await assert.rejects(
      cleanup.recoverPending(),
      (err: unknown) =>
        err instanceof AggregateError &&
        err.errors.some((e: Error) => /sessionIdsMap 必须为二元组且键必须属于候选集合/.test(e.message)),
    )
    assert.ok((await stat(fileB)).isFile())
    await rm(fileB)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('standalone 目录完整引用检查：被 idle 新会话或工作区引用时绝不删除', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-session-standalone-ref-'))
  const maintenanceDir = path.join(root, 'state', 'maintenance')
  const standaloneDir = path.join(root, 'workspaces', 'standalone', '11111111-2222-3333-4444-555555555555')

  await mkdir(maintenanceDir, { recursive: true })
  await mkdir(standaloneDir, { recursive: true })

  try {
    let hasReference = true

    const cleanup = new SessionCleanupService({
      maintenanceDirectory: maintenanceDir,
      accessStore: new AgentAccessStore(),
      collaboration: createHostCollaborationBridge({
        dataRoot: root,
        createSession: (cwd, notify) => fakeSession(cwd, notify).session,
        emit: () => {},
      }),
      isStandaloneDirectory: (cwd) => cwd.startsWith(path.join(root, 'workspaces', 'standalone')),
      hasWorkspaceReferences: () => hasReference,
    })

    const dummyFile = path.join(root, 'dummy.jsonl')
    await writeFile(dummyFile, '{"type":"session"}\n')

    // 1. prepare
    const prepared = await cleanup.prepare([dummyFile], standaloneDir)
    await rm(dummyFile, { force: true })

    // 2. afterDelete：虽然物理目录为空，但 hasWorkspaceReferences 为 true（例如存在 idle 新会话）
    await cleanup.afterDelete({ deletedPaths: [dummyFile], deletedKeys: [], errors: [] }, prepared, standaloneDir)

    // 验证目录被安全保留！
    assert.ok((await stat(standaloneDir)).isDirectory())

    // 3. 当没有任何引用（hasWorkspaceReferences 为 false）时，才安全 rmdir
    hasReference = false
    const dummyFile2 = path.join(root, 'dummy2.jsonl')
    await writeFile(dummyFile2, '{"type":"session"}\n')
    const prepared2 = await cleanup.prepare([dummyFile2], standaloneDir)
    await rm(dummyFile2, { force: true })
    await cleanup.afterDelete({ deletedPaths: [dummyFile2], deletedKeys: [], errors: [] }, prepared2, standaloneDir)

    // 验证无引用且为空的目录被成功移除
    await assert.rejects(stat(standaloneDir), { code: 'ENOENT' })

    // 4. 验证缺少 hasWorkspaceReferences 检查器时保守返回，不具备安全依据绝不清理
    await mkdir(standaloneDir, { recursive: true })
    const cleanupWithoutChecker = new SessionCleanupService({
      maintenanceDirectory: maintenanceDir,
      accessStore: new AgentAccessStore(),
      collaboration: createHostCollaborationBridge({
        dataRoot: root,
        createSession: (cwd, notify) => fakeSession(cwd, notify).session,
        emit: () => {},
      }),
      isStandaloneDirectory: (cwd) => cwd.startsWith(path.join(root, 'workspaces', 'standalone')),
      // 未配置 hasWorkspaceReferences
    })
    const dummyFile3 = path.join(root, 'dummy3.jsonl')
    await writeFile(dummyFile3, '{"type":"session"}\n')
    const prepared3 = await cleanupWithoutChecker.prepare([dummyFile3], standaloneDir)
    await rm(dummyFile3, { force: true })
    await cleanupWithoutChecker.afterDelete(
      { deletedPaths: [dummyFile3], deletedKeys: [], errors: [] },
      prepared3,
      standaloneDir,
    )
    assert.ok((await stat(standaloneDir)).isDirectory())
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('临时会话清理通过 destroyTemporary 参数触发级联整树销毁，不残留任何协作记录', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-temp-cleanup-'))
  const maintenanceDir = path.join(root, 'state', 'maintenance')
  const permissionsFile = path.join(root, 'state', 'agent-permissions.json')
  const goalsFile = path.join(root, 'state', 'goals.json')
  const sessionsDir = path.join(root, 'temporary', 'temp-session', 'sessions')

  await mkdir(maintenanceDir, { recursive: true })
  await mkdir(sessionsDir, { recursive: true })

  try {
    const accessStore = new AgentAccessStore(permissionsFile)
    const goals = new GoalService({ file: goalsFile, sessionsDirectory: sessionsDir })
    await goals.init()

    let deleteOptionsPassed: any
    const fakeCollaboration = {
      deleteSessions: async (opts: any) => {
        deleteOptionsPassed = opts
        return { deletedRootAgentIds: ['root-1'] }
      },
    }

    const tempFile = path.join(sessionsDir, 'temp.jsonl')
    await writeFile(tempFile, '{"type":"session"}\n')
    await accessStore.set(tempFile, 'full-access')

    const tempRef = { hostId: 'h', sessionId: 'temp-session' }
    await goals.start(tempRef, { objective: '临时目标' }, undefined, { temporary: true })

    const cleanup = new SessionCleanupService({
      maintenanceDirectory: maintenanceDir,
      accessStore,
      goals,
      collaboration: fakeCollaboration as any,
      control: {
        lookupSessionIds: async () => ({ [tempFile]: 'temp-session' }),
        deleteSessions: async () => ({ deletedSessionIds: ['temp-session'] }),
      },
    })

    const prepared = await cleanup.prepare([tempFile])
    await rm(tempFile, { force: true })
    await cleanup.afterDelete({ deletedPaths: [tempFile], deletedKeys: [], errors: [] }, prepared, undefined, {
      destroyTemporary: true,
    })

    assert.equal(deleteOptionsPassed?.destroyTemporary, true, '向 collaboration 传递了 destroyTemporary: true')
    assert.equal(await accessStore.get(tempFile), 'workspace-write', '权限已重置')
    assert.equal(goals.get(tempRef), undefined, '临时目标已被移除')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
