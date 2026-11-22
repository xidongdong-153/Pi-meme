import type { DailyTokenUsage } from '@pi-meme/contracts/usage'

export type ActivityPeriod = 'day' | 'week' | 'month'
export type ActivityCell = { date: string; endDate: string; tokens: number; inRange: boolean; isFuture: boolean }

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

export function activityRange(year: number): { start: string; end: string } {
  return { start: `${year}-01-01`, end: `${year}-12-31` }
}

export function availableYears(daily: DailyTokenUsage[], today: string): number[] {
  const currentYear = parseDate(today).getFullYear()
  let minYear = currentYear
  for (const entry of daily) {
    if (entry.tokens <= 0) continue
    const year = parseDate(entry.date).getFullYear()
    if (Number.isFinite(year) && year < minYear) minYear = year
  }
  const years: number[] = []
  for (let year = minYear; year <= currentYear; year += 1) years.push(year)
  return years
}

export function activityCells(
  daily: DailyTokenUsage[],
  year: number,
  period: ActivityPeriod,
  today: string,
): ActivityCell[] {
  const range = activityRange(year)
  const start = parseDate(range.start)
  const end = parseDate(range.end)
  const values = new Map(daily.map((day) => [day.date, day.tokens]))

  if (period === 'day') {
    const cells: ActivityCell[] = []
    const final = addDays(monday(end), 6)
    for (let cursor = monday(start); cursor <= final; cursor = addDays(cursor, 1)) {
      const date = dateKey(cursor)
      const inRange = date >= range.start && date <= range.end
      const isFuture = inRange && date > today
      cells.push({ date, endDate: date, tokens: inRange && !isFuture ? (values.get(date) ?? 0) : 0, inRange, isFuture })
    }
    return cells
  }

  if (period === 'month') {
    const cells: ActivityCell[] = []
    for (let month = 0; month < 12; month += 1) {
      const monthStart = new Date(year, month, 1)
      const monthEnd = new Date(year, month + 1, 0)
      const date = dateKey(monthStart)
      const endDate = dateKey(monthEnd)
      const isFuture = date > today
      let tokens = 0
      if (!isFuture) {
        const effectiveEnd = endDate > today ? today : endDate
        for (let day = monthStart; dateKey(day) <= effectiveEnd; day = addDays(day, 1)) {
          tokens += values.get(dateKey(day)) ?? 0
        }
      }
      cells.push({ date, endDate, tokens, inRange: true, isFuture })
    }
    return cells
  }

  const cells: ActivityCell[] = []
  for (let cursor = monday(start); cursor <= end; cursor = addDays(cursor, 7)) {
    const next = addDays(cursor, 7)
    const date = dateKey(cursor) < range.start ? range.start : dateKey(cursor)
    const endDate = dateKey(addDays(next, -1)) > range.end ? range.end : dateKey(addDays(next, -1))
    const isFuture = date > today
    let tokens = 0
    if (!isFuture) {
      const effectiveEnd = endDate > today ? today : endDate
      for (let day = parseDate(date); dateKey(day) <= effectiveEnd; day = addDays(day, 1)) {
        tokens += values.get(dateKey(day)) ?? 0
      }
    }
    cells.push({ date, endDate, tokens, inRange: true, isFuture })
  }
  return cells
}

function formatChineseUnit(value: number, unit: string): string {
  const decimals = value >= 100 ? 0 : value >= 10 ? 1 : 2
  return `${Number(value.toFixed(decimals))}${unit}`
}

export function compactTokens(tokens: number): string {
  const n = Math.round(tokens)
  if (n <= 0) return '0'
  if (n >= 100_000_000) return formatChineseUnit(n / 100_000_000, '亿')
  if (n >= 10_000) {
    const wan = n / 10_000
    const decimals = wan >= 100 ? 0 : wan >= 10 ? 1 : 2
    const rounded = Number(wan.toFixed(decimals))
    if (rounded >= 10_000) return formatChineseUnit(rounded / 10_000, '亿')
    return `${rounded}万`
  }
  if (n >= 1_000) {
    const rounded = Number((n / 1_000).toFixed(1))
    if (rounded >= 10) return '1万'
    return `${rounded}千`
  }
  return String(n)
}

export function taskDuration(milliseconds: number | null): string {
  if (milliseconds === null) return '—'
  if (milliseconds < 1000) return '<1秒'
  const seconds = Math.floor(milliseconds / 1000)
  if (seconds < 60) return `${seconds}秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}分`
  const hours = Math.floor(minutes / 60)
  return `${hours}时${minutes % 60 ? `${minutes % 60}分` : ''}`
}
