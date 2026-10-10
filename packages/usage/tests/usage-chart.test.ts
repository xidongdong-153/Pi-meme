import assert from 'node:assert/strict'
import { test } from 'node:test'
import { activityCells, activityRange, compactTokens, taskDuration } from '../src/ui/usage-chart-model'

test('活动范围从 12 个月前的月初到今天，日图按周一对齐并隐藏范围外日期', () => {
  assert.deepEqual(activityRange('2026-10-02'), { start: '2025-11-01', end: '2026-10-02' })
  const cells = activityCells(
    [
      { date: '2026-10-02', tokens: 100 },
      { date: '2025-10-31', tokens: 999 },
    ],
    '2026-10-02',
    'day',
  )
  assert.equal(cells.length % 7, 0)
  assert.equal(cells[0].date, '2025-10-27')
  assert.equal(cells[0].inRange, false)
  assert.equal(cells.at(-1)?.date, '2026-10-04')
  assert.equal(cells.at(-1)?.inRange, false)
  assert.equal(
    cells.reduce((sum, cell) => sum + cell.tokens, 0),
    100,
  )
})

test('周月汇总与日图相同，边缘周只包含统计范围内的日期', () => {
  const daily = [
    { date: '2025-10-31', tokens: 999 },
    { date: '2025-11-01', tokens: 10 },
    { date: '2026-09-30', tokens: 20 },
    { date: '2026-10-01', tokens: 30 },
    { date: '2026-10-02', tokens: 40 },
    { date: '2026-10-03', tokens: 999 },
  ]
  for (const mode of ['day', 'week', 'month'] as const) {
    const cells = activityCells(daily, '2026-10-02', mode)
    assert.equal(
      cells.reduce((sum, cell) => sum + cell.tokens, 0),
      100,
    )
    if (mode !== 'day') {
      assert.equal(cells[0].date, '2025-11-01')
      assert.equal(cells.at(-1)?.endDate, '2026-10-02')
    }
    if (mode === 'month') {
      assert.equal(cells.length, 12)
      assert.equal(cells.at(-1)?.tokens, 70)
    }
  }
})

test('闰年日图保留二月二十九日，数字与任务耗时使用中文单位', () => {
  const cells = activityCells([{ date: '2024-02-29', tokens: 123 }], '2024-03-01', 'day')
  assert.equal(cells.find((cell) => cell.date === '2024-02-29')?.tokens, 123)
  assert.equal(compactTokens(0), '0')
  assert.equal(compactTokens(12345), '1.2万')
  assert.equal(compactTokens(1550000000), '15.5亿')
  assert.equal(taskDuration(null), '—')
  assert.equal(taskDuration(100), '不足 1 秒')
  assert.equal(taskDuration(75 * 60 * 1000), '1 小时 15 分钟')
})
