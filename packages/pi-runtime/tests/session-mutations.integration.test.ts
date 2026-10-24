import assert from 'node:assert/strict'
import { afterAll as after, test } from 'vitest'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import path from 'node:path'
import { PiSessionPool } from '../src/session-pool'
import { AgentAccessStore } from '../src/access-store'
import { useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'
import { requestText } from '../../../tests/fixtures/fake-provider.mjs'

const root = await mkdtemp(path.join(tmpdir(), 'pi-session-mutations-'))
// 含 slow 的提示词回复较慢，用来把会话保持在运行中状态。
const agent = await useFakeAgent(root, {
  reply: (body) => ({ text: '收到', delayMs: requestText(body).includes('slow') ? 1000 : 0 }),
})
after(async () => {
  await agent.dispose()
  await rm(root, { recursive: true, force: true })
})

async function poolFor(name: string) {
  const cwd = path.join(root, name)
  await mkdir(cwd)
  const pool = new PiSessionPool(
    cwd,
    { connection: () => {}, event: () => {}, error: () => {}, sessionsChanged: () => {} },
    new AgentAccessStore(path.join(cwd, 'access.json')),
    agent.runtimePaths,
    agent.credentials,
  )
  pool.prepare(cwd)
  return pool
}

async function idle(pool: PiSessionPool) {
  for (let index = 0; index < 100; index++) {
    if (pool.getRuntimeSessions().every((session) => !session.running)) return
    await delay(10)
  }
  throw new Error('等待会话空闲超时')
}

test('删除当前会话后，仍指向旧会话的视图读快照不会碰到空的 accessReady', async () => {
  const pool = await poolFor('stale-snapshot')
  const view = pool.createClientView()
  try {
    const key = await pool.withClientView(view, () => {
      pool.prepare(path.join(root, 'stale-snapshot'))
      return view.sessionKey!
    })
    const copy = { ...view }
    const active = pool.withClientView(copy, () => pool.getActiveSession())
    const targets = [key, active.sessionFile].filter((item): item is string => Boolean(item))
    await pool.withClientView(copy, () =>
      pool.deleteSessions(targets, undefined, async () => ({ deletedPaths: targets, errors: [] })),
    )
    await assert.rejects(
      pool.withClientView(view, () => pool.snapshot()),
      (cause: unknown) => {
        assert.ok(cause instanceof Error)
        assert.match(cause.message, /当前查看的会话已更换/)
        assert.equal(cause.message.includes('accessReady'), false)
        return true
      },
    )
  } finally {
    pool.releaseClientView(view)
    await pool.stopAndWait()
  }
})

test.each([false, true])('删除运行或暂停中的会话会先停止运行，操作期间拒绝发送和选择：暂停 %s', async (paused) => {
  const pool = await poolFor(`busy-${paused}`)
  try {
    const key = pool.connection().sessionKey!
    await pool.prompt(key, '运行中的任务 slow')
    const runtime = pool.getRuntimeSession(key)
    const file = pool.getActiveSession().sessionFile!
    await pool.renameSession(file, '新名称')
    assert.equal((await pool.snapshot()).state.sessionName, '新名称')
    if (paused) {
      await pool.pause(key)
      assert.equal((await pool.snapshot()).state.isPaused, true)
    }
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const deleting = pool.deleteSessions([file], undefined, async () => {
      assert.equal(runtime.connection().status, 'disconnected')
      entered()
      await gate
      return { deletedPaths: [file], errors: [] }
    })
    await Promise.race([started, deleting])
    await assert.rejects(pool.prompt(key, '禁止复活'), /正在修改或删除会话/)
    await assert.rejects(pool.switchSession(file), /正在修改或删除会话/)
    await assert.rejects(
      pool.idle(async () => {}),
      /有会话正在运行/,
    )
    release()
    const result = await deleting
    assert.deepEqual(result.deletedKeys, [key])
    assert.notEqual(pool.connection().sessionKey, key)
    assert.equal(pool.connection().status, 'idle')
  } finally {
    pool.stop()
    await delay(100)
  }
})

test('项目删除期间锁定目标目录，其他项目继续运行，部分失败保留失败会话', async () => {
  const pool = await poolFor('project-lock')
  try {
    await pool.prompt(pool.connection().sessionKey!, '目标项目任务 slow')
    const target = pool.cwd
    const file = pool.getActiveSession().sessionFile!
    const other = path.join(root, 'other-project')
    await mkdir(other)
    pool.newSessionInDirectory(other)
    const otherKey = pool.connection().sessionKey!
    await pool.prompt(otherKey, '后台继续运行 slow')
    const outcome = await pool.deleteSessions([file], target, async () => {
      assert.throws(() => pool.newSessionInDirectory(target), /正在删除项目会话/)
      await assert.rejects(pool.selectWorkspaceDirectory(target), /正在删除项目会话/)
      await assert.rejects(pool.switchSession(file), /正在修改或删除会话/)
      return { deletedPaths: [], errors: ['模拟文件权限错误'] }
    })
    assert.deepEqual(outcome.deletedKeys, [])
    assert.equal(outcome.selection, undefined)
    assert.equal(pool.connection().sessionKey, otherKey)
    assert.ok(pool.getRuntimeSessions().find((session) => session.path === file))
    assert.equal(pool.getRuntimeSessions().find((session) => session.id === otherKey)?.running, true)
    await pool.abort(otherKey)
    await idle(pool)
    await pool.switchSession(file)
    assert.equal(pool.connection().status, 'idle')
  } finally {
    pool.stop()
    await delay(100)
  }
})

test('AgentAccessStore 支持删除前捕获 canonical key并在删除后幂等清理，部分删除保留未影响项', async () => {
  const storeFile = path.join(root, 'access-cleanup-test.json')
  const store = new AgentAccessStore(storeFile)
  const dir = path.join(root, 'temp-sessions')
  await mkdir(dir, { recursive: true })
  const file1 = path.join(dir, 'session1.jsonl')
  const file2 = path.join(dir, 'session2.jsonl')
  const { writeFile } = await import('node:fs/promises')
  await writeFile(file1, '{"type":"session"}\n')
  await writeFile(file2, '{"type":"session"}\n')

  await store.set(file1, 'full-access')
  await store.set(file2, 'read-only')
  assert.equal(await store.get(file1), 'full-access')
  assert.equal(await store.get(file2), 'read-only')

  // 1. 删除前捕获 canonicalKey
  const canonical1 = await store.canonicalKey(file1)
  const _canonical2 = await store.canonicalKey(file2)
  assert.ok(canonical1.endsWith('session1.jsonl'))

  // 2. 模拟文件与目录已被物理删除
  await rm(file1, { force: true })

  // 3. 即使物理文件已不存在，使用捕获的 canonical key 也能准确清理
  const deleted = await store.remove([canonical1])
  assert.deepEqual(deleted, [canonical1])

  // 验证 session1 回退默认，session2 权限仍完整保留
  assert.equal(await store.get(file1), 'workspace-write')
  assert.equal(await store.get(file2), 'read-only')

  // 重复清理幂等
  const secondDeleted = await store.remove([canonical1])
  assert.deepEqual(secondDeleted, [])

  // 重新加载验证持久化文件内容正确
  const reloaded = new AgentAccessStore(storeFile)
  assert.equal(await reloaded.get(file1), 'workspace-write')
  assert.equal(await reloaded.get(file2), 'read-only')
})
