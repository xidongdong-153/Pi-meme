import type { DailyTokenUsage } from '@pi-meme/contracts/usage'

export type ActivityPeriod = 'day' | 'week' | 'month'
export type ActivityCell = { date: string; endDate: string; tokens: number; inRange: boolean }

export function parseDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day)
}

export function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days)
}

function monday(date: Date): Date {
  return addDays(date, -((date.getDay() + 6) % 7))
}

export function activityRange(today: string): { start: string; end: string } {
  const end = parseDate(today)
  return { start: dateKey(new Date(end.getFullYear(), end.getMonth() - 11, 1)), end: today }
}

export function activityCells(daily: DailyTokenUsage[], today: string, period: ActivityPeriod): ActivityCell[] {
  const range = activityRange(today)
  const start = parseDate(range.start)
  const end = parseDate(range.end)
  const values = new Map(daily.map((day) => [day.date, day.tokens]))
  if (period === 'day') {
    const cells: ActivityCell[] = []
    const final = addDays(monday(end), 6)
    for (let cursor = monday(start); cursor <= final; cursor = addDays(cursor, 1)) {
      const date = dateKey(cursor)
      const inRange = date >= range.start && date <= range.end
      cells.push({ date, endDate: date, tokens: inRange ? (values.get(date) ?? 0) : 0, inRange })
    }
    return cells
  }
  const cells: ActivityCell[] = []
  for (let cursor = period === 'week' ? monday(start) : start; cursor <= end;) {
    const next = period === 'week' ? addDays(cursor, 7) : new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
    const date = dateKey(cursor) < range.start ? range.start : dateKey(cursor)
    const endDate = dateKey(addDays(next, -1)) > range.end ? range.end : dateKey(addDays(next, -1))
    let tokens = 0
    for (let day = parseDate(date); dateKey(day) <= endDate; day = addDays(day, 1))
      tokens += values.get(dateKey(day)) ?? 0
    cells.push({ date, endDate, tokens, inRange: true })
    cursor = next
  }
  return cells
}

export function compactTokens(tokens: number): string {
  if (tokens >= 100_000_000) return `${Number((tokens / 100_000_000).toFixed(1))}亿`
  if (tokens >= 10_000) return `${Number((tokens / 10_000).toFixed(1))}万`
  return tokens.toLocaleString('zh-CN')
}

export function taskDuration(milliseconds: number | null): string {
  if (milliseconds === null) return '—'
  if (milliseconds < 1000) return '不足 1 秒'
  const seconds = Math.floor(milliseconds / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  return `${hours} 小时${minutes % 60 ? ` ${minutes % 60} 分钟` : ''}`
}
