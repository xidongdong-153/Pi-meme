import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { Connection, SessionSelectionResult, Snapshot } from '@pi-meme/contracts/desktop'
import { AgentAccessStore } from '@pi-meme/pi-runtime/access-store'
import { PiSessionPool } from '@pi-meme/pi-runtime/session-pool'
import { HostCollaborationBridge } from '@pi-meme/subagents/server/coordinator'
import { useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'
import { createHost } from '../src/service'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('首次协作绑定可在权限切换中读取冷快照，执行操作仍受锁保护', { timeout: 15000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'host-access-cold-'))
  const fake = await useFakeAgent(root)
  const host = await createHost({ dataRoot: path.join(root, 'userData'), credentials: fake.credentials })
  const rpc = (method: string, args: unknown[] = [], sessionId?: string) =>
    host.rpc({ requestId: crypto.randomUUID(), clientId: 'client', method, args, sessionId })
  const entered = deferred()
  const release = deferred()
  const setAccessMode = PiSessionPool.prototype.setAccessMode
  let assertLocked!: () => Promise<void>
  let acquired = 0
  const acquire = host.plugins.acquire.bind(host.plugins)
  host.plugins.acquire = () => {
    acquired++
    return acquire()
  }
  PiSessionPool.prototype.setAccessMode = async function (key, mode) {
    assertLocked = async () => {
      await assert.rejects(this.prompt(key, '锁内不能发送'), /正在更新 Agent 访问权限/)
      await assert.rejects(setAccessMode.call(this, key, 'full-access'), /正在更新 Agent 访问权限/)
      assert.throws(() => this.getRuntimeSession(key), /正在更新 Agent 访问权限/)
    }
    const session = this.getRuntimeSession(key)
    const stop = session.stopAndWait
    session.stopAndWait = async () => {
      entered.resolve()
      await release.promise
      await stop()
    }
    try {
      await setAccessMode.call(this, key, mode)
    } finally {
      session.stopAndWait = stop
    }
  }
  let changing: ReturnType<typeof rpc> | undefined
  try {
    const key = ((await rpc('pi:connection')).result as Connection).sessionKey!
    changing = rpc('pi:access-mode', [key, 'full-access'], key)
    await entered.promise
    const response = await rpc('pi:snapshot', [], key)
    assert.equal(response.error, undefined)
    const during = response.result as Snapshot
    assert.equal(during.connection.accessChanging, true)
    assert.equal(during.state.mode, 'default')
    assert.ok(during.agent?.agentId)
    assert.equal(during.agents?.length, 1)
    assert.deepEqual(during.planDocuments, [])
    assert.equal((await rpc('pi:agents', [key], key)).error, undefined)
    await assertLocked()
    assert.equal(acquired, 0)
    release.resolve()
    assert.equal((await changing).error, undefined)
    const after = (await rpc('pi:snapshot', [], key)).result as Snapshot
    assert.equal(after.connection.accessChanging, false)
    assert.equal(after.connection.accessMode, 'full-access')
    assert.equal(after.agent?.accessMode, 'full-access')
    assert.equal(after.agent?.agentId, during.agent?.agentId)
    assert.equal(acquired, 0)
  } finally {
    release.resolve()
    await changing
    PiSessionPool.prototype.setAccessMode = setAccessMode
    await host.dispose()
    await fake.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test(
  '权限落盘期间与快照返回后的切换都保持协作计划；重启恢复模式且旧快照不覆盖手动关闭',
  { timeout: 30000, skip: !['darwin', 'linux'].includes(process.platform) },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'host-access-plan-'))
    let saved = false
    const fake = await useFakeAgent(root, {
      reply: () => {
        if (saved) return { text: '只读分析结束' }
        saved = true
        return {
          tool: { name: 'save_plan', arguments: JSON.stringify({ title: '保留计划', markdown: '仅查看文件。' }) },
        }
      },
    })
    const options = { dataRoot: path.join(root, 'userData'), credentials: fake.credentials }
    let host = await createHost(options)
    const rpc = (method: string, args: unknown[] = [], sessionId?: string) =>
      host.rpc({ requestId: crypto.randomUUID(), clientId: 'client', method, args, sessionId })
    const entered = deferred()
    const release = deferred()
    const snapshotRead = deferred()
    const releaseSnapshot = deferred()
    const modeRead = deferred()
    const releaseMode = deferred()
    const set = AgentAccessStore.prototype.set
    const snapshot = PiSessionPool.prototype.snapshot
    const getMode = HostCollaborationBridge.prototype.getSessionMode
    let holdAccess = false
    let holdSnapshot = false
    let holdMode = false
    let changing: ReturnType<typeof rpc> | undefined
    let selecting: ReturnType<typeof rpc> | undefined
    let staleSnapshot: ReturnType<typeof rpc> | undefined
    const run = async (key: string, text: string) => {
      const completed = deferred()
      const unsubscribe = await host.subscribe('client', (event) => {
        if (
          event.type === 'event' &&
          event.value.event.type === 'agents_update' &&
          event.value.event.agents.some((agent) => agent.depth === 0 && agent.status === 'completed')
        )
          completed.resolve()
      })
      try {
        assert.equal((await rpc('pi:prompt', [key, text], key)).error, undefined)
        await completed.promise
      } finally {
        unsubscribe()
      }
    }
    try {
      const key = ((await rpc('pi:snapshot')).result as Snapshot).connection.sessionKey!
      await rpc('pi:access-mode', [key, 'full-access'], key)
      await rpc('pi:session-mode', [key, 'plan'], key)
      await run(key, '保存只读计划')
      const before = (await rpc('pi:snapshot', [], key)).result as Snapshot
      assert.equal(before.planDocuments?.length, 1)
      const sessionFile = before.connection.sessionFile!
      AgentAccessStore.prototype.set = async function (file, mode) {
        if (holdAccess && mode === 'read-only') {
          holdAccess = false
          entered.resolve()
          await release.promise
        }
        await set.call(this, file, mode)
      }
      PiSessionPool.prototype.snapshot = async function () {
        const result = await snapshot.call(this)
        if (holdSnapshot) {
          holdSnapshot = false
          snapshotRead.resolve()
          await releaseSnapshot.promise
        }
        return result
      }
      holdSnapshot = true
      staleSnapshot = rpc('pi:snapshot', [], key)
      await snapshotRead.promise
      holdAccess = true
      changing = rpc('pi:access-mode', [key, 'read-only'], key)
      await entered.promise
      const during = await rpc('pi:snapshot', [], key)
      assert.equal(during.error, undefined)
      const value = during.result as Snapshot
      assert.equal(value.connection.accessChanging, true)
      assert.equal(value.state.mode, 'plan')
      assert.deepEqual(value.planDocuments, before.planDocuments)
      assert.equal(value.agent?.agentId, before.agent?.agentId)
      releaseSnapshot.resolve()
      const raced = await staleSnapshot
      assert.equal(raced.error, undefined)
      assert.equal((raced.result as Snapshot).state.mode, 'plan')
      assert.deepEqual((raced.result as Snapshot).planDocuments, before.planDocuments)
      release.resolve()
      assert.equal((await changing).error, undefined)
      const after = (await rpc('pi:snapshot', [], key)).result as Snapshot
      assert.equal(after.connection.accessChanging, false)
      assert.equal(after.connection.accessMode, 'read-only')
      assert.equal(after.agent?.accessMode, 'read-only')
      await host.dispose()
      host = await createHost(options)
      const selection = (await rpc('pi:switch-session', [sessionFile])).result as SessionSelectionResult
      assert.equal(selection.cancelled, false)
      if (selection.cancelled) throw new Error('恢复会话不应取消')
      assert.equal(selection.snapshot.state.mode, 'plan')
      assert.deepEqual(selection.snapshot.planDocuments, before.planDocuments)
      await run(selection.snapshot.connection.sessionKey!, '恢复后不传模式的下一轮')
      const request = fake.provider.requests.at(-1)
      const tools = request?.tools?.map((tool: { function: { name: string } }) => tool.function.name)
      assert.ok(tools?.includes('save_plan'))
      assert.ok(!tools?.some((name: string) => ['write', 'edit', 'bash', 'codemode'].includes(name)))
      await host.dispose()
      host = await createHost(options)
      HostCollaborationBridge.prototype.getSessionMode = async function (sessionKey) {
        const mode = await getMode.call(this, sessionKey)
        if (holdMode) {
          holdMode = false
          modeRead.resolve()
          await releaseMode.promise
        }
        return mode
      }
      holdMode = true
      selecting = rpc('pi:switch-session', [sessionFile])
      await modeRead.promise
      const restoredKey = ((await rpc('pi:connection')).result as Connection).sessionKey!
      await rpc('pi:session-mode', [restoredKey, 'plan'], restoredKey)
      await rpc('pi:session-mode', [restoredKey, 'default'], restoredKey)
      releaseMode.resolve()
      const closed = (await selecting).result as SessionSelectionResult
      assert.equal(closed.cancelled, false)
      if (closed.cancelled) throw new Error('恢复会话不应取消')
      assert.equal(closed.snapshot.state.mode, 'default')
      assert.equal(((await rpc('pi:snapshot')).result as Snapshot).state.mode, 'default')
    } finally {
      release.resolve()
      releaseSnapshot.resolve()
      releaseMode.resolve()
      await Promise.all([changing, selecting, staleSnapshot])
      AgentAccessStore.prototype.set = set
      PiSessionPool.prototype.snapshot = snapshot
      HostCollaborationBridge.prototype.getSessionMode = getMode
      await host.dispose()
      await fake.dispose()
      await rm(root, { recursive: true, force: true })
    }
  },
)
