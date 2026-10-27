import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { setup } from './host-server-fixture'
import type { Snapshot } from '@pi-meme/contracts/desktop'
import type { PiSessionsSnapshot } from '@pi-meme/contracts/sessions'
import { GoalService } from '@pi-meme/goals/server/service'

async function filesContaining(targetDir: string, text: string): Promise<string[]> {
  const matches: string[] = []
  async function scan(current: string) {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await scan(full)
      } else if (entry.isFile()) {
        const content = await readFile(full, 'utf8').catch(() => '')
        if (content.includes(text)) matches.push(full)
      }
    }
  }
  await scan(targetDir)
  return matches
}

test('临时会话核心：创建、恢复、主会话隔离、所有权拦截、历史过滤、目录隔离与关闭幂等清理', async () => {
  const fixture = await setup(true)
  try {
    const clientA = 'test-client-a'
    const clientB = 'test-client-b'

    // 1. 初始化 clientA 的主会话
    const mainA = (await fixture.rpc(clientA, 'pi:snapshot')).result as Snapshot
    assert.ok(mainA.connection.sessionKey)
    const mainKeyA = mainA.connection.sessionKey

    // 2. Client A 打开临时会话（显式指定 sourceSessionKey）
    const openRes = await fixture.rpc(clientA, 'temporary-session:open', [{ sourceSessionKey: mainKeyA }])
    assert.equal(openRes.error, undefined)
    const tempSnapshot = openRes.result as Snapshot
    assert.ok(tempSnapshot.connection.sessionKey)
    const tempKey = tempSnapshot.connection.sessionKey
    assert.notEqual(tempKey, mainKeyA)
    assert.ok(tempKey.startsWith('runtime:'))
    assert.equal(tempSnapshot.appSession?.temporary, true)
    assert.equal(tempSnapshot.connection.cwd, mainA.connection.cwd)

    // 3. 重复调用 temporary-session:open 返回相同会话，不创建多余实例
    const reopenRes = await fixture.rpc(clientA, 'temporary-session:open', [])
    assert.equal((reopenRes.result as Snapshot).connection.sessionKey, tempKey)

    // 4. temporary-session:get 查询当前存活临时会话
    const getRes = await fixture.rpc(clientA, 'temporary-session:get', [])
    assert.equal((getRes.result as Snapshot).connection.sessionKey, tempKey)

    // 5. Client B 没有临时会话，get 返回 null
    const getBRes = await fixture.rpc(clientB, 'temporary-session:get', [])
    assert.equal(getBRes.result, null)

    // 6. 跨 Client 所有权隔离：Client B 无权对 Client A 的临时会话发送指令或关闭
    const promptB = await fixture.rpc(clientB, 'pi:prompt', [tempKey, '未经授权的消息', [], []], tempKey)
    const promptBError =
      typeof promptB.error === 'string' ? promptB.error : ((promptB.error as { message?: string })?.message ?? '')
    assert.match(promptBError, /无权访问其他窗口的临时会话/)

    const closeB = await fixture.rpc(clientB, 'temporary-session:close', [tempKey])
    const closeBError =
      typeof closeB.error === 'string' ? closeB.error : ((closeB.error as { message?: string })?.message ?? '')
    assert.match(closeBError, /无权访问其他窗口的临时会话/)

    // 7. 存储目录隔离：临时目录在 data/temporary-sessions 中
    const tempRoot = path.join(fixture.server.host.root, 'data', 'temporary-sessions')
    const tempFolders = await readdir(tempRoot)
    assert.equal(tempFolders.length, 1)
    const sessionDir = path.join(tempRoot, tempFolders[0], 'sessions')
    assert.ok((await stat(sessionDir)).isDirectory())

    // 8. 历史过滤：pi:sessions 中绝不暴露临时会话
    const sessionsRes = (await fixture.rpc(clientA, 'pi:sessions')).result as PiSessionsSnapshot
    const allListedPaths = [
      ...sessionsRes.projects.flatMap((p) => p.sessions.map((s) => s.path)),
      ...sessionsRes.recents.map((s) => s.path),
      ...(sessionsRes.standaloneSessions ?? []).map((s) => s.path),
    ]
    assert.ok(!allListedPaths.includes(tempKey))

    // 9. 主会话切换不影响临时会话目标
    const newMain = await fixture.rpc(clientA, 'pi:new-session')
    assert.equal(newMain.error, undefined)
    const afterSwitchGet = await fixture.rpc(clientA, 'temporary-session:get', [])
    assert.equal((afterSwitchGet.result as Snapshot).connection.sessionKey, tempKey)

    // 10. 关闭临时会话：级联清理物理目录并释放资源
    const closeRes = await fixture.rpc(clientA, 'temporary-session:close', [tempKey])
    assert.deepEqual(closeRes.result, { closed: true })

    // 关闭后物理临时文件夹彻底删除
    const tempFoldersAfterClose = await readdir(tempRoot)
    assert.equal(tempFoldersAfterClose.length, 0)

    // 关闭后查询返回 null
    const afterCloseGet = await fixture.rpc(clientA, 'temporary-session:get', [])
    assert.equal(afterCloseGet.result, null)

    // 11. 重复关闭幂等，返回 closed: true
    const recloseRes = await fixture.rpc(clientA, 'temporary-session:close', [tempKey])
    assert.deepEqual(recloseRes.result, { closed: true })
  } finally {
    await fixture.dispose()
  }
})

test('sourceSessionKey 无效时显式报错拒绝，不静默回退其他会话', async () => {
  const fixture = await setup(false)
  try {
    const res = await fixture.rpc('test-client', 'temporary-session:open', [
      { sourceSessionKey: 'runtime:non-existent' },
    ])
    const errMsg = typeof res.error === 'string' ? res.error : ((res.error as { message?: string })?.message ?? '')
    assert.match(errMsg, /目标会话已关闭|目标会话不存在/)
  } finally {
    await fixture.dispose()
  }
})

test('临时会话真实 prompt 发送，递归检查永久目录无明文且主会话零污染', async () => {
  const fixture = await setup(true)
  try {
    const client = 'test-client-prompt'
    const secretPrompt = '绝密临时聊天提问内容-XYZ123'
    const mainSnapshot = (await fixture.rpc(client, 'pi:snapshot')).result as Snapshot
    const mainKey = mainSnapshot.connection.sessionKey!

    const openRes = await fixture.rpc(client, 'temporary-session:open', [{ sourceSessionKey: mainKey }])
    const tempKey = (openRes.result as Snapshot).connection.sessionKey!

    // 向临时会话发送真实消息
    const promptRes = await fixture.rpc(client, 'pi:prompt', [tempKey, secretPrompt, [], []], tempKey)
    assert.equal(promptRes.error, undefined)

    // 轮询快照直至收到包含回复的消息
    let tempAfter: Snapshot | null = null
    for (let count = 0; count < 100; count++) {
      const getRes = await fixture.rpc(client, 'temporary-session:get', [tempKey])
      tempAfter = getRes.result as Snapshot
      if (
        tempAfter &&
        tempAfter.messages.length > 0 &&
        tempAfter.messages.some((m) => JSON.stringify(m).includes('假模型回复'))
      ) {
        break
      }
      await delay(50)
    }
    assert.ok(tempAfter && tempAfter.messages.length > 0)
    assert.ok(tempAfter.messages.some((m) => JSON.stringify(m).includes(secretPrompt)))

    // 检查主会话快照：仍然保持 0 条消息，零污染！
    const mainAfter = (await fixture.rpc(client, 'pi:snapshot', [], mainKey)).result as Snapshot
    assert.equal(mainAfter.messages.length, 0)

    // 递归检查永久 sessions 目录中绝无该临时文件与明文
    const permanentSessionsDir = path.join(fixture.server.host.root, 'data', 'sessions')
    const matchesInPermanent = await filesContaining(permanentSessionsDir, secretPrompt)
    assert.deepEqual(matchesInPermanent, [], '永久 sessions 目录中不应出现任何临时会话明文')

    // 检查 agent-permissions.json 中无临时 sessionFile
    const permissionsFile = path.join(fixture.server.host.root, 'data', 'state', 'agent-permissions.json')
    const permissionsContent = await readFile(permissionsFile, 'utf8').catch(() => '')
    assert.ok(!permissionsContent.includes(tempKey))
    assert.ok(!permissionsContent.includes('temporary-sessions'))

    // 关闭临时会话
    const closeRes = await fixture.rpc(client, 'temporary-session:close', [tempKey])
    assert.deepEqual(closeRes.result, { closed: true })

    // 关闭后临时会话也被彻底清扫
    const tempRoot = path.join(fixture.server.host.root, 'data', 'temporary-sessions')
    const remaining = await readdir(tempRoot).catch(() => [])
    assert.equal(remaining.length, 0)
  } finally {
    await fixture.dispose()
  }
})

test('appControl.deleteSessions 故障注入后保持 closing 状态，二次重试成功完成清理', async () => {
  const fixture = await setup(false)
  try {
    const client = 'test-retry-client'
    const openRes = await fixture.rpc(client, 'temporary-session:open', [])
    const opened = openRes.result as Snapshot
    const tempKey = opened.connection.sessionKey!
    const ref = opened.appSession!
    assert.ok(tempKey)

    // 注入故障：第一次调用 deleteSessions 时抛出异常
    const originalDeleteSessions = fixture.server.host.control.deleteSessions.bind(fixture.server.host.control)
    let failedOnce = false
    vi.spyOn(fixture.server.host.control, 'deleteSessions').mockImplementation(async (args) => {
      if (!failedOnce) {
        failedOnce = true
        throw new Error('模拟故障：appControl.deleteSessions 失败')
      }
      return originalDeleteSessions(args)
    })

    // 第一次调用 close：因故障失败
    const firstClose = await fixture.rpc(client, 'temporary-session:close', [tempKey])
    assert.ok(firstClose.error)

    // 处于 closing 状态：此时新的消息写操作被拦截
    const promptAttempt = await fixture.rpc(client, 'pi:prompt', [tempKey, '写操作测试', [], []], tempKey)
    const promptError =
      typeof promptAttempt.error === 'string'
        ? promptAttempt.error
        : ((promptAttempt.error as { message?: string })?.message ?? '')
    assert.match(promptError, /临时会话正在关闭/)

    for (const [method, args] of [
      ['sessions.get', [ref]],
      ['sessions.snapshot', [ref]],
      ['sessions.history', [ref]],
      ['sessions.configure', [ref, { thinkingLevel: 'off' }]],
      ['sessions.submit', [ref, { delivery: 'start', text: '不得发送' }]],
      ['goals.get', [ref]],
      ['goals.start', [ref, { objective: '不得启动' }]],
      ['files.list', [ref]],
      ['files.read', [ref, 'test.txt']],
      ['files.preview', [ref, 'test.png']],
      ['files.search', [ref, { query: 'test' }]],
      ['files.write', [ref, { relativePath: 'test.txt', content: '不得写入', revision: 'old' }]],
      ['terminal.open', [ref, {}]],
    ] as Array<[string, unknown[]]>) {
      const response = await fixture.server.host.control.dispatch({
        apiVersion: 2,
        hostId: fixture.server.host.hostId,
        clientId: client,
        method,
        args,
        idempotencyKey: crypto.randomUUID(),
      })
      assert.match(response.error?.message ?? '', /临时会话正在关闭/, method)
    }

    for (const [method, args] of [
      ['temporary-session:get', [tempKey]],
      ['temporary-session:open', []],
    ] as Array<[string, unknown[]]>) {
      const response = await fixture.rpc(client, method, args)
      const message =
        typeof response.error === 'string' ? response.error : ((response.error as { message?: string })?.message ?? '')
      assert.match(message, /临时会话正在关闭/, method)
    }

    // 第二次调用 close：重试成功，且因支持分步可重入，顺利清空
    const secondClose = await fixture.rpc(client, 'temporary-session:close', [tempKey])
    assert.deepEqual(secondClose.result, { closed: true })

    // 临时目录被成功彻底删除
    const tempRoot = path.join(fixture.server.host.root, 'data', 'temporary-sessions')
    const remaining = await readdir(tempRoot).catch(() => [])
    assert.equal(remaining.length, 0)

    // Control store 中临时会话已完全清除
    const controlSessions = fixture.server.host.control.store.state.sessions
    assert.ok(!controlSessions.some((s) => s.temporary))
  } finally {
    await fixture.dispose()
  }
})

test('有打开的临时会话时 prepareMaintenance 拒绝维护，提示先关闭临时会话', async () => {
  const fixture = await setup(false)
  try {
    const client = 'test-maint-client'
    await fixture.rpc(client, 'temporary-session:open', [])

    assert.throws(() => fixture.server.host.prepareMaintenance(), /有打开的临时会话，请先关闭临时会话后再维护存储/)
  } finally {
    await fixture.dispose()
  }
})

for (const operation of ['目标创建', '文件写入']) {
  test(`临时会话关闭等待在途${operation}结束，随后清除全部临时状态`, async () => {
    const fixture = await setup(operation === '目标创建')
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const waiting = Promise.withResolvers<void>()
    try {
      const client = 'temporary-operation-owner'
      const opened = (await fixture.rpc(client, 'temporary-session:open', [{ cwd: fixture.root }])).result as Snapshot
      const tempKey = opened.connection.sessionKey!
      const ref = opened.appSession!
      const file = path.join(fixture.root, 'concurrent.txt')
      await writeFile(file, '原始内容')
      const api = fixture.server.host.control.apiFor(client)
      const preview = await api.files.preview(ref, 'concurrent.txt')
      assert.equal(preview.kind, 'text')
      if (preview.kind !== 'text') throw new Error('测试文件必须能读取为文本')

      if (operation === '目标创建') {
        const start = GoalService.prototype.start
        vi.spyOn(GoalService.prototype, 'start').mockImplementation(async function (this: GoalService, ...args) {
          if (args[0].sessionId === ref.sessionId) {
            entered.resolve()
            await release.promise
          }
          return start.apply(this, args)
        })
      } else {
        const resolveRoot = fixture.server.host.control.resolveRoot
        vi.spyOn(fixture.server.host.control, 'resolveRoot').mockImplementation(async (...args) => {
          entered.resolve()
          await release.promise
          return resolveRoot(...args)
        })
      }
      const waitForOperations = fixture.server.host.control.waitForSessionOperations
      vi.spyOn(fixture.server.host.control, 'waitForSessionOperations').mockImplementation(async (id) => {
        if (id === ref.sessionId) waiting.resolve()
        await waitForOperations(id)
      })

      const pending = fixture.server.host.control.dispatch({
        apiVersion: 2,
        hostId: fixture.server.host.hostId,
        clientId: client,
        method: operation === '目标创建' ? 'goals.start' : 'files.write',
        args: [
          ref,
          operation === '目标创建'
            ? { objective: '临时并发目标内容' }
            : { relativePath: 'concurrent.txt', content: '不得在关闭后写入', revision: preview.revision },
        ],
        idempotencyKey: crypto.randomUUID(),
      })
      await entered.promise
      let closed = false
      const close = fixture.rpc(client, 'temporary-session:close', [tempKey]).then((response) => {
        closed = true
        return response
      })
      await waiting.promise
      assert.equal(closed, false, '在途操作结束前不能报告关闭成功')
      release.resolve()
      const result = await pending
      assert.ok(result.error, '关闭应阻止尚未完成的目标启动或文件写入')
      assert.deepEqual((await close).result, { closed: true })
      assert.equal(await readFile(file, 'utf8'), '原始内容')
      assert.deepEqual(await readdir(path.join(fixture.server.host.root, 'data', 'temporary-sessions')), [])
      assert.ok(
        !fixture.server.host.control.store.state.sessions.some((session) => session.sessionId === ref.sessionId),
      )
      assert.ok(
        !fixture.server.host.control.store.state.receipts.some(
          (receipt) => receipt.session.sessionId === ref.sessionId,
        ),
      )
      assert.ok(!JSON.stringify(fixture.server.host.control.store.state.operations).includes(ref.sessionId))
      assert.deepEqual(await filesContaining(fixture.server.host.root, '临时并发目标内容'), [])
    } finally {
      release.resolve()
      await fixture.dispose()
    }
  })
}

test('慢速附件上传流与关闭并发，close 完成后目录绝不重现', async () => {
  const fixture = await setup(false)
  try {
    const client = 'test-slow-upload-client'
    const openRes = await fixture.rpc(client, 'temporary-session:open', [])
    const tempKey = (openRes.result as Snapshot).connection.sessionKey!

    // 创建一个受控慢速可读流
    const slowStream = new Readable({
      async read() {
        await delay(50)
        this.push(Buffer.from('slow-chunk-1'))
        await delay(100)
        this.push(Buffer.from('slow-chunk-2'))
        this.push(null)
      },
    })

    // 发起在途慢速上传
    let uploadSettled = false
    const uploadPromise = fixture.server.host
      .uploadAttachment(
        {
          clientId: client,
          hostId: fixture.server.host.hostId,
          sessionKey: tempKey,
          name: 'test-slow.png',
        },
        slowStream,
      )
      .catch(() => {})
      .finally(() => {
        uploadSettled = true
      })

    // 上传在途时并发发起关闭
    await delay(20)
    const closeRes = await fixture.rpc(client, 'temporary-session:close', [tempKey])
    assert.deepEqual(closeRes.result, { closed: true })

    // 等待上传操作完全落定（被中止或结束）
    await uploadPromise
    assert.ok(uploadSettled)

    // 等待 150ms 确保慢流彻底结束
    await delay(150)

    // 验证临时根目录依然彻底不存在，未被慢流重新创建
    const tempRoot = path.join(fixture.server.host.root, 'data', 'temporary-sessions')
    const remaining = await readdir(tempRoot).catch(() => [])
    assert.equal(remaining.length, 0)
  } finally {
    await fixture.dispose()
  }
})

test('真实订阅断开后宽限超时自动清理临时会话', async () => {
  // 设置 200ms 的极短 clientGraceMs
  const fixture = await setup(false, 200)
  try {
    const client = 'ephemeral-disconnect-client'
    const unsubscribe = await fixture.server.host.subscribe(client, () => {})
    const openRes = await fixture.rpc(client, 'temporary-session:open', [])
    const tempKey = (openRes.result as Snapshot).connection.sessionKey!
    assert.ok(tempKey)

    const tempRoot = path.join(fixture.server.host.root, 'data', 'temporary-sessions')
    const foldersBefore = await readdir(tempRoot)
    assert.equal(foldersBefore.length, 1)

    // 取消订阅模拟客户端断线
    unsubscribe()

    // 等待 350ms 超过 200ms 宽限时间
    await delay(350)

    // 临时目录已被自动清扫彻底删除
    const foldersAfter = await readdir(tempRoot)
    assert.equal(foldersAfter.length, 0)
  } finally {
    await fixture.dispose()
  }
})

test('启动孤儿临时目录自动清理', async () => {
  const fixture = await setup(false)
  const root = fixture.server.host.root
  await fixture.server.dispose()

  // 模拟之前奔溃残留的孤儿临时文件夹
  const tempRoot = path.join(root, 'data', 'temporary-sessions')
  const orphanDir = path.join(tempRoot, 'orphan-123')
  await mkdir(path.join(orphanDir, 'sessions'), { recursive: true })
  await writeFile(path.join(orphanDir, 'sessions', 'test.jsonl'), '{"type":"session"}\n')

  // 重启 Host 服务，验证孤儿目录被自动清扫
  const { startHostServer } = await import('../src/server')
  const restarted = await startHostServer({
    dataRoot: root,
    token: 'test-token',
  })
  try {
    const entries = await readdir(tempRoot)
    assert.equal(entries.length, 0)
  } finally {
    await restarted.dispose()
    await fixture.dispose()
  }
})
