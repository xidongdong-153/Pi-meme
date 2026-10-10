import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { UsageService } from '../src/server/usage-service'

const date = (day: number, hour = 12, minute = 0) => new Date(2026, 9, day, hour, minute)
const header = { type: 'session', version: 3, id: 'session', cwd: '/fixture', timestamp: date(1).toISOString() }
const usage = (totalTokens: number) => ({ input: 2, output: 3, cacheRead: 4, cacheWrite: 5, totalTokens })
function user(id: string, at: Date, parentId: string | null = null) {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: at.toISOString(),
    message: { role: 'user', timestamp: at.getTime(), content: '测试任务' },
  }
}
function assistant(id: string, parentId: string, at: Date, count = 100, stopReason = 'stop') {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: at.toISOString(),
    message: { role: 'assistant', timestamp: at.getTime(), stopReason, usage: usage(count), content: [] },
  }
}

async function fixture(t: TestContext, now = date(5)) {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-usage-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = path.join(root, 'sessions')
  const project = path.join(directory, 'project')
  await mkdir(project, { recursive: true })
  const save = async (name: string, entries: unknown[]) => {
    const file = path.join(project, `${name}.jsonl`)
    await writeFile(file, [header, ...entries].map((entry) => JSON.stringify(entry)).join('\n'))
    return file
  }
  return { root, directory, project, save, service: new UsageService(directory, () => now) }
}

test('累计包含缓存，缺失 totalTokens 时求和，不重复累计 reasoning 和缓存子项', async (t) => {
  const { save, service } = await fixture(t)
  const fallback = assistant('b', 'u', date(2))
  Object.assign(fallback.message, {
    usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, reasoning: 5, cacheWrite1h: 8 },
  })
  await save('a', [user('u', date(1)), assistant('a', 'u', date(1), 14), fallback])
  const result = await service.getSnapshot()
  assert.equal(result.totalTokens, 114)
  assert.equal(result.peakDailyTokens, 100)
  assert.deepEqual(result.daily, [
    { date: '2026-10-01', tokens: 14 },
    { date: '2026-10-02', tokens: 100 },
  ])
  assert.deepEqual(result.warnings, [])
})

test('保留所有分支和摘要用量，分叉复制的记录只累计一次，新回复分别累计', async (t) => {
  const { save, service } = await fixture(t)
  const entries = [user('u', date(1)), assistant('a', 'u', date(1), 100)]
  await save('original', [...entries, assistant('b', 'u', date(2), 200)])
  await save('fork', [
    ...entries.map((entry) => ({ ...entry, parentId: null })),
    assistant('c', 'a', date(2), 50),
    { type: 'compaction', id: 'compact', parentId: 'c', timestamp: date(3).toISOString(), usage: usage(20) },
    { type: 'branch_summary', id: 'summary', parentId: 'compact', timestamp: date(3).toISOString(), usage: usage(30) },
    { type: 'usage', id: 'warm', parentId: 'summary', timestamp: date(3).toISOString(), usage: usage(40) },
  ])
  const result = await service.getSnapshot()
  assert.equal(result.totalTokens, 440)
  assert.equal(result.peakDailyTokens, 250)
  assert.equal(result.longestStreak, 3)
})

test('任务沿 parentId 计时，包含工具耗时和跨日时间，排除失败、取消和未结束任务', async (t) => {
  const { save, service } = await fixture(t)
  await save('tasks', [
    user('u', date(1, 23, 30)),
    assistant('tool', 'u', date(1, 23, 45), 10, 'toolUse'),
    {
      type: 'message',
      id: 'result',
      parentId: 'tool',
      timestamp: date(2, 0, 15).toISOString(),
      message: { role: 'toolResult' },
    },
    assistant('done', 'result', date(2, 0, 30), 10),
    assistant('branch', 'u', date(2, 0, 45), 10),
    user('failed-user', date(2)),
    assistant('failed', 'failed-user', date(3), 5, 'error'),
    user('cancel-user', date(3)),
    assistant('cancel', 'cancel-user', date(4), 5, 'aborted'),
    user('pending-user', date(4)),
    assistant('pending', 'pending-user', date(5), 5, 'toolUse'),
  ])
  assert.equal((await service.getSnapshot()).longestTaskMs, 75 * 60 * 1000)
})

test('使用消息时间作为起点，连续天数允许今天未活跃，零用量不算活跃', async (t) => {
  const { save, service } = await fixture(t)
  await save('days', [
    user('u', date(1)),
    assistant('a', 'u', date(1), 100),
    assistant('b', 'u', date(2), 100),
    assistant('c', 'u', date(3), 0),
    assistant('d', 'u', date(4), 100),
  ])
  let result = await service.getSnapshot()
  assert.equal(result.longestStreak, 2)
  assert.equal(result.currentStreak, 1)
  await save('today', [assistant('today', 'none', date(5), 100)])
  result = await service.getSnapshot()
  assert.equal(result.currentStreak, 2)
  assert.equal(result.longestStreak, 2)
})

test('没有今天或昨天活动时连续天数为零，跨月和跨年按本地日期连续计算', async (t) => {
  const now = new Date(2027, 0, 3, 12)
  const { save, service } = await fixture(t, now)
  await save('year', [
    assistant('dec', 'none', new Date(2026, 11, 31, 23, 59), 10),
    assistant('jan', 'none', new Date(2027, 0, 1, 0, 1), 20),
  ])
  const result = await service.getSnapshot()
  assert.equal(result.currentStreak, 0)
  assert.equal(result.longestStreak, 2)
  assert.deepEqual(
    result.daily.map((entry) => entry.date),
    ['2026-12-31', '2027-01-01'],
  )
})

test('缓存不改写历史，合并并发请求，新增、修改、删除后刷新统计', async (t) => {
  const { save, service } = await fixture(t)
  const file = await save('a', [assistant('a', 'none', date(1), 10)])
  const original = await readFile(file, 'utf8')
  const before = await stat(file)
  const first = service.getSnapshot()
  assert.equal(first, service.getSnapshot())
  assert.equal((await first).totalTokens, 10)
  assert.deepEqual(await service.getSnapshot(), await first)
  assert.equal(await readFile(file, 'utf8'), original)
  assert.equal((await stat(file)).mtimeMs, before.mtimeMs)
  await save('a', [assistant('a', 'none', date(1), 123)])
  const second = await save('b', [assistant('b', 'none', date(2), 20)])
  assert.equal((await service.getSnapshot()).totalTokens, 143)
  await rm(second)
  assert.equal((await service.getSnapshot()).totalTokens, 123)
  await rm(file)
  const empty = await service.getSnapshot()
  assert.equal(empty.totalTokens, 0)
  assert.equal(empty.longestTaskMs, null)
  assert.deepEqual(empty.daily, [])
})

test('损坏行、无效用量和日期提示统计不完整，保留有效记录，目录缺失为空', async (t) => {
  const { save, service, project, root } = await fixture(t)
  await save('valid', [assistant('a', 'none', date(1), 10)])
  await writeFile(
    path.join(project, 'broken.jsonl'),
    [
      JSON.stringify(header),
      '{broken',
      'null',
      JSON.stringify({ type: 'usage', timestamp: 'invalid', usage: usage(20) }),
      JSON.stringify({ type: 'usage', timestamp: date(1).toISOString(), usage: { input: -1 } }),
      JSON.stringify(assistant('b', 'none', date(1), 30)),
    ].join('\n'),
  )
  const result = await service.getSnapshot()
  assert.equal(result.totalTokens, 40)
  assert.equal(result.warnings.length, 1)
  const missing = await new UsageService(path.join(root, 'missing')).getSnapshot()
  assert.equal(missing.totalTokens, 0)
  assert.deepEqual(missing.warnings, [])
  const blocked = path.join(root, 'not-directory')
  await writeFile(blocked, '不是目录')
  await assert.rejects(new UsageService(blocked).getSnapshot(), /无法读取 Pi 会话目录/)
})
