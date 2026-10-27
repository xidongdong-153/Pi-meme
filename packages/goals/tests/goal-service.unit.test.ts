import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'vitest'
import { GoalService } from '../src/server/service'
import { goalEntryUsage, goalRunEntry, goalTokens, parseGoalCommand } from '@pi-meme/contracts/goal'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
const ref = { hostId: 'host', sessionId: 'session' }
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-goal-store-'))
  const sessionsDirectory = path.join(root, 'sessions')
  const file = path.join(root, 'state', 'goals.json')
  let now = 10000
  const options = { root, file, sessionsDirectory, now: () => now }
  const service = new GoalService(options)
  await service.init()
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return {
    root,
    file,
    service,
    options,
    advance: (ms: number) => {
      now += ms
    },
  }
}

test('命令只识别开头和完整别名，用量使用实际 Token 口径', () => {
  for (const alias of ['goal', '目标', '目标模式']) {
    assert.equal(parseGoalCommand(`/${alias}`)?.action, 'open')
    assert.deepEqual(parseGoalCommand(`/${alias} 完成任务`), { action: 'start', objective: '完成任务' })
  }
  assert.equal(parseGoalCommand('/goal resume')?.action, 'resume')
  assert.equal(parseGoalCommand('正文 /goal'), undefined)
  assert.equal(parseGoalCommand('/goalkeeper'), undefined)
  assert.equal(goalTokens({ totalTokens: 12, input: 100 }), 12)
  assert.equal(goalTokens({ input: 2, output: 3, cacheRead: 4, cacheWrite: 5 }), 14)
  assert.equal(goalTokens({ input: -1 }), undefined)
  assert.equal(
    goalEntryUsage({
      type: 'message',
      message: { role: 'assistant', content: [{ type: 'text', text: '实际输出' }], usage: { totalTokens: 0 } },
    }),
    undefined,
  )
  assert.equal(goalEntryUsage({ type: 'compaction', usage: { totalTokens: 0 } }), undefined)
  assert.deepEqual(
    goalEntryUsage({ type: 'message', message: { role: 'assistant', content: [], usage: { totalTokens: 0 } } }),
    { totalTokens: 0 },
  )
})

test('一个未完成目标、控制修订和恢复校验', async () => {
  const { service } = await fixture()
  await assert.rejects(async () => service.start(ref, { objective: '' }), /目标正文/)
  const goal = await service.start(ref, { objective: '完整目标' })
  await assert.rejects(service.start(ref, { objective: '替换目标' }), /未完成/)
  await assert.rejects(service.edit(ref, { ...goal, objective: '新目标' }), /暂停/)
  const paused = await service.stop(ref, 'paused', '用户暂停', goal)
  await assert.rejects(service.resume(ref, goal), /已更新/)
  const edited = await service.edit(ref, { ...paused, objective: '新目标' })
  assert.equal(edited.status, 'paused')
  assert.equal((await service.resume(ref, edited)).objective, '新目标')
})

test('用量按原生 entry 去重，包含缓存和失败调用，累计用量不限制续跑', async () => {
  const { service } = await fixture()
  await service.start(ref, { objective: '累计用量目标' })
  const run = (await service.begin(ref, false))!
  await service.usage(run, 'assistant', { totalTokens: 6 })
  await service.usage(run, 'assistant', { totalTokens: 6 })
  assert.equal(service.get(ref)?.tokensUsed, 6)
  await service.usage(run, 'compaction', { input: 2, cacheRead: 3 })
  assert.equal(service.get(ref)?.status, 'active')
  assert.equal(service.get(ref)?.tokensUsed, 11)
  assert.doesNotThrow(() => service.assertActive(run))
  await service.usage(run, 'partial', { totalTokens: 2 })
  assert.equal(service.get(ref)?.tokensUsed, 13)
})

test('缺少用量时标记统计不完整，仍可继续执行和手动恢复', async () => {
  const { service } = await fixture()
  await service.start(ref, { objective: '持续任务' })
  await service.usage((await service.begin(ref, false))!, 'unknown', undefined)
  assert.equal(service.get(ref)?.status, 'active')
  assert.equal(service.get(ref)?.usageIncomplete, true)
  await service.stop(ref, 'paused', '用户暂停')
  assert.equal((await service.resume(ref, service.get(ref)!)).status, 'active')
})

test('同一阻塞按轮去重，三轮停止，恢复重置审计', async () => {
  const { service } = await fixture()
  await service.start(ref, { objective: '原目标' })
  for (let i = 1; i <= 3; i++) {
    const run = (await service.begin(ref, false))!
    const report = {
      status: 'active' as const,
      summary: '服务未就绪，已重新检查',
      progress: 'blocked' as const,
      blockerKey: 'service-unavailable',
    }
    await service.update(run, report, false)
    await service.update(run, report, false)
    await service.settled(run)
    await service.settled(run)
    assert.equal(service.get(ref)?.blocker?.count, i)
  }
  assert.equal(service.get(ref)?.status, 'blocked')
  const resumed = await service.resume(ref, service.get(ref)!)
  assert.equal(resumed.blocker, undefined)
  const run = (await service.begin(ref, false))!
  await assert.rejects(
    async () =>
      service.update(run, { status: 'blocked', summary: '仍不可用', blockerKey: 'service-unavailable' }, false),
    /连续三轮/,
  )
})

test('完成要求证据与执行空闲；完成后的尾部用量仍累计', async () => {
  const { service } = await fixture()
  await service.start(ref, { objective: '原目标' })
  const run = (await service.begin(ref, false))!
  for (const evidence of [undefined, [], ['  ']])
    await assert.rejects(
      async () => service.update(run, { status: 'complete', summary: '已完成', evidence }, true),
      /证据/,
    )
  await assert.rejects(
    async () => service.update(run, { status: 'complete', summary: '已完成', evidence: ['命令退出码 0'] }, false),
    /子任务/,
  )
  await service.update(run, { status: 'complete', summary: '全部验收完成', evidence: ['命令退出码 0'] }, true)
  await service.usage(run, 'final', { totalTokens: 7 })
  assert.equal(service.get(ref)?.status, 'complete')
  assert.equal(service.get(ref)?.tokensUsed, 7)
})

test('并行执行时间不相加，暂停与等待用户不累计', async () => {
  const { service, advance } = await fixture()
  await service.start(ref, { objective: '原目标' })
  service.setRunning(ref, true)
  advance(100)
  service.setRunning(ref, true)
  advance(100)
  service.setRunning(ref, false)
  advance(500)
  assert.equal(service.get(ref)?.elapsedMs, 200)
  await service.stop(ref, 'paused', '用户暂停')
  advance(500)
  assert.equal(service.get(ref)?.elapsedMs, 200)
})

test('重启核对未记账原生记录，复制历史去重并保持暂停', async () => {
  const { service, options, file } = await fixture()
  await service.start(ref, { objective: '原目标' })
  const run = (await service.begin(ref, false))!
  await service.usage(run, 'recorded', { totalTokens: 3 })
  await mkdir(options.sessionsDirectory)
  const entries = [
    { type: 'custom', id: 'marker', customType: goalRunEntry, data: run },
    { type: 'message', id: 'recorded', message: { role: 'assistant', usage: { totalTokens: 3 } } },
    { type: 'message', id: 'missed', message: { role: 'assistant', usage: { totalTokens: 4 } } },
  ]
    .map((entry) => JSON.stringify(entry))
    .join('\n')
  await writeFile(path.join(options.sessionsDirectory, 'parent.jsonl'), entries)
  await writeFile(path.join(options.sessionsDirectory, 'fork.jsonl'), entries)
  const restored = new GoalService(options)
  await restored.init()
  assert.equal(restored.get(ref)?.tokensUsed, 7)
  assert.equal(restored.get(ref)?.status, 'paused')
  assert.equal(restored.get(ref)?.turns, 1)
  await restored.clear(ref, restored.get(ref)!)
  await restored.usage(run, 'late', { totalTokens: 99 })
  assert.equal(restored.get(ref), undefined)
  assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 1)
})

test('存储损坏不会被清空；原子写失败拒绝续跑', async () => {
  const { service, options, file } = await fixture()
  await service.start(ref, { objective: '原目标' })
  await writeFile(file, '{invalid')
  await assert.rejects(new GoalService(options).init())
  await writeFile(file, JSON.stringify({ version: 100, goals: {} }))
  await assert.rejects(new GoalService(options).init(), /版本/)
  await writeFile(file, JSON.stringify({ version: 1, goals: {} }))
  let fail = false
  const failing = new GoalService({
    ...options,
    write: async (file, data) => {
      if (fail) throw new Error('磁盘写入失败')
      await writeFile(file, data)
    },
  })
  await failing.init()
  await failing.start(ref, { objective: '写入失败目标' })
  const run = (await failing.begin(ref, false))!
  fail = true
  await assert.rejects(failing.stop(ref, 'paused', '暂停'), /保存失败/)
  assert.throws(() => failing.assertActive(run), /保存失败/)
  const persisted = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(persisted.goals.session.goal.status, 'active')
})

test('首轮尚未写入会话时保留可恢复输入；核对原生记录后改用持久引用', async () => {
  const { service, options, file } = await fixture()
  const input = {
    objective: '按图片完成任务',
    images: [{ type: 'image' as const, data: 'aW1hZ2U=', mimeType: 'image/png' }],
  }
  await service.start(ref, input)
  await service.begin(ref, false)
  const restarted = new GoalService(options)
  await restarted.init()
  assert.equal(restarted.get(ref)?.status, 'paused')
  assert.deepEqual(restarted.pendingInput(ref), input)
  await restarted.resume(ref, restarted.get(ref)!)
  const run = (await restarted.begin(ref, false))!
  await mkdir(options.sessionsDirectory)
  await writeFile(
    path.join(options.sessionsDirectory, 'initial.jsonl'),
    [
      { type: 'custom', id: 'marker', customType: goalRunEntry, data: run },
      {
        type: 'message',
        id: 'original',
        message: { role: 'user', content: [{ type: 'text', text: input.objective }, ...input.images] },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n'),
  )
  const reconciled = new GoalService(options)
  await reconciled.init()
  assert.equal(reconciled.get(ref)?.inputEntryId, 'original')
  assert.equal(reconciled.pendingInput(ref), undefined)
  const stored = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(stored.goals.session.pendingInput, undefined)
  assert.equal(reconciled.get(ref)?.tokensUsed, 0)
})

test('移除旧预算字段，预算停止的旧目标转为暂停并可手动恢复', async () => {
  const { service, options, file } = await fixture()
  await service.start(ref, { objective: '保留已有目标' })
  const state = JSON.parse(await readFile(file, 'utf8'))
  state.goals.session.goal.status = 'budget_limited'
  state.goals.session.goal.tokenBudget = 3
  state.goals.session.goal.tokensUsed = 5
  state.goals.session.pendingInput.tokenBudget = 3
  await writeFile(file, JSON.stringify(state))
  const restored = new GoalService(options)
  await restored.init()
  const goal = restored.get(ref)!
  assert.equal(goal.status, 'paused')
  assert.equal(goal.objective, '保留已有目标')
  assert.equal(goal.tokensUsed, 5)
  assert.equal(Object.hasOwn(goal, 'tokenBudget'), false)
  assert.equal(Object.hasOwn(restored.pendingInput(ref)!, 'tokenBudget'), false)
  assert.equal((await restored.resume(ref, goal)).status, 'active')
})

test('完成时仍核算当前轮最终回复的耗时，收尾后停止计时', async () => {
  const { service, advance } = await fixture()
  await service.start(ref, { objective: '完整交付' })
  const run = (await service.begin(ref, false))!
  service.setRunning(ref, true)
  advance(100)
  await service.update(run, { status: 'complete', summary: '验收通过', evidence: ['已逐项核对'] }, true)
  advance(50)
  await service.usage(run, 'final', { totalTokens: 1 })
  await service.settled(run)
  advance(100)
  assert.equal(service.get(ref)?.elapsedMs, 150)
})

test('不同的实质进展重置空转计数，连续重复进展停止续跑', async () => {
  const { service } = await fixture()
  await service.start(ref, { objective: '持续推进' })
  for (let i = 0; i < 4; i++) {
    const run = (await service.begin(ref, false))!
    await service.update(run, { status: 'active', progress: 'progress', summary: `完成第 ${i + 1} 项核对` }, false)
    await service.settled(run)
    assert.equal(service.get(ref)?.status, 'active')
  }
  for (let i = 0; i < 3; i++) {
    const run = (await service.begin(ref, false))!
    await service.update(run, { status: 'active', progress: 'progress', summary: '完成第 4 项核对' }, false)
    await service.settled(run)
  }
  assert.equal(service.get(ref)?.status, 'blocked')
})

test('deleteSessions 支持批量清理已删除会话的目标并停止计时，新路径 state/goals.json 优先', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-goal-delete-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const sessionsDirectory = path.join(root, 'sessions')
  const specificFile = path.join(root, 'state', 'goals.json')
  const service = new GoalService({ file: specificFile, sessionsDirectory })
  await service.init()

  const s1 = { hostId: 'h', sessionId: 's1' }
  const s2 = { hostId: 'h', sessionId: 's2' }
  await service.start(s1, { objective: '目标一' })
  await service.start(s2, { objective: '目标二' })
  assert.ok(service.get(s1))
  assert.ok(service.get(s2))

  // 清理 s1
  const deleted = await service.deleteSessions(['s1', 'non-existent'])
  assert.deepEqual(deleted, ['s1'])
  assert.equal(service.get(s1), undefined)
  assert.ok(service.get(s2))

  // 重启验证持久化保留 s2
  const restarted = new GoalService({ file: specificFile, sessionsDirectory })
  await restarted.init()
  assert.equal(restarted.get(s1), undefined)
  assert.ok(restarted.get(s2))
})

test('临时会话目标在内存正常运行，但绝不落盘持久化 goals.json，关闭后彻底清除', async () => {
  const { service, file } = await fixture()
  const persistentRef = { hostId: 'host', sessionId: 'persistent-session' }
  const temporaryRef = { hostId: 'host', sessionId: 'temporary-session', temporary: true }

  await service.start(persistentRef, { objective: '持久目标' })
  await service.start(temporaryRef, { objective: '临时机密目标' })

  // 内存中两者均正常可用
  assert.ok(service.get(persistentRef))
  assert.ok(service.get(temporaryRef))
  assert.equal(service.get(temporaryRef)?.objective, '临时机密目标')

  // 验证磁盘上的 goals.json 绝不包含临时目标明文
  const fileContent = JSON.parse(await readFile(file, 'utf8')) as { goals: Record<string, unknown> }
  assert.ok(fileContent.goals['persistent-session'])
  assert.equal(fileContent.goals['temporary-session'], undefined)

  // 清理临时会话
  const deleted = await service.deleteSessions(['temporary-session'])
  assert.deepEqual(deleted, ['temporary-session'])
  assert.equal(service.get(temporaryRef), undefined)
  assert.ok(service.get(persistentRef))
})
