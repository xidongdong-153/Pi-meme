import { describe, expect, test } from 'vitest'
import { localTimeToInstant, missedOccurrences, nextOccurrence, validateRule } from '../src/shared/rules'

describe('定时规则', () => {
  test('按任务时区计算每天、工作日和每周多选星期', () => {
    const after = Date.parse('2026-10-23T02:00:00Z')
    expect(nextOccurrence({ kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' }, after)).toBe(
      '2026-10-24T01:00:00.000Z',
    )
    expect(nextOccurrence({ kind: 'weekdays', time: '09:00', timeZone: 'Asia/Shanghai' }, after)).toBe(
      '2026-10-26T01:00:00.000Z',
    )
    expect(nextOccurrence({ kind: 'weekly', time: '09:00', timeZone: 'Asia/Shanghai', weekdays: [0, 3] }, after)).toBe(
      '2026-10-25T01:00:00.000Z',
    )
  })
  test('单次必须晚于查询时间；间隔从固定锚点开始，不因查询时间漂移', () => {
    const at = '2026-10-25T01:00:00.000Z'
    expect(nextOccurrence({ kind: 'once', at, timeZone: 'UTC' }, Date.parse(at))).toBeUndefined()
    const rule = { kind: 'interval' as const, every: 2, unit: 'hours' as const, anchor: at, timeZone: 'UTC' }
    expect(nextOccurrence(rule, Date.parse(at))).toBe('2026-10-25T03:00:00.000Z')
    expect(nextOccurrence(rule, Date.parse('2026-10-25T03:30:00Z'))).toBe('2026-10-25T05:00:00.000Z')
    expect(missedOccurrences(rule, '2026-10-25T03:00:00Z', Date.parse('2026-10-25T10:00:00Z'))).toEqual({
      count: 4,
      next: '2026-10-25T11:00:00.000Z',
    })
  })
  test('跳过夏令时不存在的本地时间，重复的时间只运行第一次', () => {
    expect(localTimeToInstant('2026-03-08', '02:30', 'America/New_York')).toBeUndefined()
    expect(
      nextOccurrence(
        { kind: 'daily', time: '02:30', timeZone: 'America/New_York' },
        Date.parse('2026-03-08T05:00:00Z'),
      ),
    ).toBe('2026-03-09T06:30:00.000Z')
    expect(localTimeToInstant('2026-11-01', '01:30', 'America/New_York')).toBe('2026-11-01T05:30:00.000Z')
    expect(
      nextOccurrence(
        { kind: 'daily', time: '01:30', timeZone: 'America/New_York' },
        Date.parse('2026-11-01T05:31:00Z'),
      ),
    ).toBe('2026-11-02T06:30:00.000Z')
  })
  test('跨日历边界合并错过次数', () => {
    expect(
      missedOccurrences(
        { kind: 'daily', time: '09:00', timeZone: 'UTC' },
        '2026-12-30T09:00:00Z',
        Date.parse('2027-01-02T10:00:00Z'),
      ),
    ).toEqual({ count: 4, next: '2027-01-03T09:00:00.000Z' })
  })
  test('拒绝无效时区、时间、空星期和非整数间隔', () => {
    expect(() => validateRule({ kind: 'daily', time: '25:00', timeZone: 'UTC' })).toThrow('时间无效')
    expect(() => validateRule({ kind: 'daily', time: '09:00', timeZone: 'unknown' })).toThrow('时区无效')
    expect(() => validateRule({ kind: 'weekly', time: '09:00', timeZone: 'UTC', weekdays: [] })).toThrow('至少选择')
    expect(() =>
      validateRule({
        kind: 'interval',
        every: 0.5,
        unit: 'minutes',
        anchor: new Date().toISOString(),
        timeZone: 'UTC',
      }),
    ).toThrow('正整数')
  })
})
