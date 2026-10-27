import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  migrateLegacyCollaborationJson,
  loadCollaborationPartitions,
  saveCollaborationRoot,
} from '../src/server/collaboration-store'
import { createHostCollaborationBridge } from '../src/server/coordinator'
import { fakeSession } from './coordinator-fixture'

test('migrateLegacyCollaborationJson 严格按 rootAgentId 分组并校验格式，坏数据 fail-closed 报错', () => {
  const rootId = randomUUID()
  const childId = randomUUID()
  const legacy = {
    records: [
      {
        summary: {
          agentId: rootId,
          rootAgentId: rootId,
          depth: 0,
          rootSessionKey: 'root-key',
          status: 'idle',
        },
        mailbox: [],
        consumed: [],
        queued: [],
      },
      {
        summary: {
          agentId: childId,
          rootAgentId: rootId,
          depth: 1,
          rootSessionKey: 'root-key',
          status: 'completed',
        },
        mailbox: [{ id: 'm1', kind: 'message', text: 'hello' }],
        consumed: [],
        queued: [],
        replies: [{ id: 'req1', result: { accepted: true } }],
      },
    ],
    plans: [
      {
        id: 'p1',
        sessionId: 's1',
        runId: 'r1',
        title: '计划',
        markdown: '# 计划正文',
        revision: 1,
        updatedAt: new Date().toISOString(),
      },
    ],
  }

  const { roots, plans } = migrateLegacyCollaborationJson(legacy)
  assert.equal(roots.size, 1)
  const partition = roots.get(rootId)!
  assert.equal(partition.version, 2)
  assert.equal(partition.rootAgentId, rootId)
  assert.equal(partition.rootSessionKey, 'root-key')
  assert.equal(partition.records.length, 2)
  assert.equal(plans.length, 1)
  assert.equal(plans[0]!.id, 'p1')

  // 坏记录拒绝猜测身份
  assert.throws(() => migrateLegacyCollaborationJson({ records: [{ summary: {} }] }), /缺少必需的 summary\.agentId/)
  assert.throws(() => migrateLegacyCollaborationJson({ records: [{}] }), /缺少有效 summary 字段/)
  assert.throws(() => migrateLegacyCollaborationJson({ plans: [{ id: 'p1' }] as never }), /计划条目字段无效/)
})

test('loadCollaborationPartitions fail-closed 校验文件名与 rootAgentId 及版本一致性', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pi-partitions-check-'))
  try {
    const rootAgentId = randomUUID()
    const validPartition = {
      version: 1 as const,
      rootAgentId,
      rootSessionKey: 'key-1',
      records: [],
      updatedAt: new Date().toISOString(),
    }
    await saveCollaborationRoot(dir, rootAgentId, validPartition)

    const loaded = await loadCollaborationPartitions(dir, path.join(dir, 'plans.json'))
    assert.equal(loaded.roots.size, 1)
    assert.equal(loaded.roots.get(rootAgentId)?.rootAgentId, rootAgentId)

    // 文件名与内容 rootAgentId 不一致时必须拒绝
    const mismatchFile = path.join(dir, 'mismatch-id.json')
    await writeFile(mismatchFile, JSON.stringify({ ...validPartition, rootAgentId: 'other-id' }), 'utf8')
    await assert.rejects(loadCollaborationPartitions(dir, path.join(dir, 'plans.json')), /根分片 ID 不一致/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('分片持久化只更新受影响的根，不全库序列化；跨根操作更新双方', async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'pi-collab-partition-'))
  const rootsDir = path.join(dataRoot, 'state', 'collaboration', 'roots')
  try {
    const bridge = createHostCollaborationBridge({
      dataRoot,
      collaborationRootsDirectory: rootsDir,
      createSession: (cwd, notify, _sessionKey) => fakeSession(cwd, notify).session,
      emit: () => {},
    })

    const session1 = fakeSession(dataRoot, { connection: () => {}, event: () => {}, error: () => {} })
    const session2 = fakeSession(dataRoot, { connection: () => {}, event: () => {}, error: () => {} })

    const root1 = await bridge.bindRoot({
      sessionKey: 'root1-key',
      sessionId: 's1',
      sessionFile: path.join(dataRoot, 's1.jsonl'),
      cwd: dataRoot,
      state: session1.state,
      accessMode: 'workspace-write',
      session: session1.session,
    })

    const root2 = await bridge.bindRoot({
      sessionKey: 'root2-key',
      sessionId: 's2',
      sessionFile: path.join(dataRoot, 's2.jsonl'),
      cwd: dataRoot,
      state: session2.state,
      accessMode: 'workspace-write',
      session: session2.session,
    })

    const root1File = path.join(rootsDir, `${root1.rootAgentId}.json`)
    const root2File = path.join(rootsDir, `${root2.rootAgentId}.json`)

    const stat1Before = await stat(root1File)
    const stat2Before = await stat(root2File)

    await bridge.bindRoot({
      sessionKey: 'root1-key',
      sessionId: 's1',
      sessionFile: path.join(dataRoot, 's1.jsonl'),
      cwd: dataRoot,
      state: session1.state,
      accessMode: 'workspace-write',
      session: session1.session,
    })
    assert.equal((await stat(root1File)).ino, stat1Before.ino)
    assert.equal((await stat(root1File)).mtimeMs, stat1Before.mtimeMs)

    // 等待微小时间片使 mtime 有可测差异
    await new Promise((r) => setTimeout(r, 50))

    // 修改 root 1 的模式，触发 persist(root1)
    await bridge.setSessionMode('root1-key', 'plan')

    const stat1After = await stat(root1File)
    const stat2After = await stat(root2File)

    // root 1 的文件更新了，root 2 的分片文件 mtime 与大小完全未动！彻底解决写放大！
    assert.ok(stat1After.mtimeMs > stat1Before.mtimeMs)
    assert.equal(stat2After.mtimeMs, stat2Before.mtimeMs)

    await bridge.stopAndWait()
  } finally {
    await rm(dataRoot, { recursive: true, force: true })
  }
})

test('deleteSessions 保留未确认子会话、去重 replies 与邮箱历史，隐藏子会话不泄露', async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'pi-collab-delete-'))
  const rootsDir = path.join(dataRoot, 'state', 'collaboration', 'roots')
  try {
    const bridge = createHostCollaborationBridge({
      dataRoot,
      collaborationRootsDirectory: rootsDir,
      createSession: (cwd, notify, _sessionKey) => fakeSession(cwd, notify).session,
      emit: () => {},
    })

    const fake = fakeSession(dataRoot, { connection: () => {}, event: () => {}, error: () => {} })
    const root = await bridge.bindRoot({
      sessionKey: 'root-key',
      sessionId: 'root-session-id',
      sessionFile: path.join(dataRoot, 'root.jsonl'),
      cwd: dataRoot,
      state: fake.state,
      accessMode: 'workspace-write',
      session: fake.session,
    })

    await bridge.beginRootRun('root-key', { mode: 'default', message: '主任务' })

    // 创建子任务
    const _child = (await bridge.dispatch(
      fake.session,
      {
        id: 'spawn-req',
        method: 'spawn_agent',
        params: { task_name: 'child_agent', message: '子任务' },
      },
      new AbortController().signal,
    )) as { agentId: string; sessionKey: string }

    // 此时树中含有 childSessionIdentities，且含有去重 replies
    const childSessionsBefore = await bridge.getChildSessions()
    assert.ok(childSessionsBefore.length > 0)

    // 1. 删除根会话，但未指定删除子会话的 sessionFile / sessionId
    const res1 = await bridge.deleteSessions({
      sessionIds: ['root-session-id'],
      sessionFiles: [path.join(dataRoot, 'root.jsonl')],
    })

    // 因为该根树拥有未被删除的子会话以及去重 replies，整根不能物理删除！
    assert.deepEqual(res1.deletedRootAgentIds, [])

    // getChildSessions 依然能够返回子会话身份，确保列表依然将其隐藏！
    const childSessionsAfter = await bridge.getChildSessions()
    assert.ok(childSessionsAfter.length > 0)

    // 2. 只有当子会话与根会话的所有去重结果均被彻底闭环，整根才会被物理清理
    // 先检查分片文件依然完好存在
    const partitionFile = path.join(rootsDir, `${root.rootAgentId}.json`)
    const content = await readFile(partitionFile, 'utf8')
    assert.ok(content.includes('child_agent'))

    await bridge.stopAndWait()
  } finally {
    await rm(dataRoot, { recursive: true, force: true })
  }
})
