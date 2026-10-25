import type { ScheduleRule } from '@pi-meme/contracts/schedules'

const formatters = new Map<string, Intl.DateTimeFormat>()
function parts(timestamp: number, timeZone: string) {
  let formatter = formatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
    formatters.set(timeZone, formatter)
  }
  const values = Object.fromEntries(formatter.formatToParts(timestamp).map((part) => [part.type, part.value]))
  return { year: +values.year, month: +values.month, day: +values.day, hour: +values.hour, minute: +values.minute }
}

/** 夏令时空缺不返回时间，重复的本地时间只取第一次。 */
export function localTimeToInstant(date: string, time: string, timeZone: string): string | undefined {
  const [year, month, day] = date.split('-').map(Number)
  const [hour, minute] = time.split(':').map(Number)
  const wall = Date.UTC(year, month - 1, day, hour, minute)
  if (!Number.isFinite(wall)) throw new Error('日期或时间无效')
  const candidates = new Set<number>()
  for (let delta = -36; delta <= 36; delta += 6) {
    const sample = wall + delta * 3600000
    const p = parts(sample, timeZone)
    const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - sample
    const candidate = wall - offset
    const check = parts(candidate, timeZone)
    if (
      check.year === year &&
      check.month === month &&
      check.day === day &&
      check.hour === hour &&
      check.minute === minute
    )
      candidates.add(candidate)
  }
  return candidates.size ? new Date(Math.min(...candidates)).toISOString() : undefined
}

export function validateRule(rule: ScheduleRule) {
  if (!rule || typeof rule !== 'object' || typeof rule.timeZone !== 'string') throw new Error('定时规则无效')
  try {
    new Intl.DateTimeFormat('zh-CN', { timeZone: rule.timeZone }).resolvedOptions()
  } catch {
    throw new Error('时区无效，请使用 IANA 时区名称')
  }
  if (rule.kind === 'once') {
    if (!Number.isFinite(Date.parse(rule.at))) throw new Error('单次执行时间无效')
  } else if (rule.kind === 'interval') {
    if (
      !Number.isSafeInteger(rule.every) ||
      rule.every < 1 ||
      rule.every > 525600 ||
      !['minutes', 'hours'].includes(rule.unit) ||
      !Number.isFinite(Date.parse(rule.anchor))
    )
      throw new Error('执行间隔必须是正整数，且不超过 525600')
  } else if (['daily', 'weekdays', 'weekly'].includes(rule.kind)) {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(rule.time)) throw new Error('执行时间无效')
    if (
      rule.kind === 'weekly' &&
      (!Array.isArray(rule.weekdays) ||
        !rule.weekdays.length ||
        rule.weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6))
    )
      throw new Error('请至少选择一个有效的星期')
  } else throw new Error('不支持的重复规则')
}

export function nextOccurrence(rule: ScheduleRule, after: number): string | undefined {
  validateRule(rule)
  if (rule.kind === 'once') return Date.parse(rule.at) > after ? new Date(rule.at).toISOString() : undefined
  if (rule.kind === 'interval') {
    const anchor = Date.parse(rule.anchor)
    const step = rule.every * (rule.unit === 'minutes' ? 60000 : 3600000)
    return new Date(anchor + Math.max(1, Math.floor((after - anchor) / step) + 1) * step).toISOString()
  }
  const local = parts(after, rule.timeZone)
  const start = Date.UTC(local.year, local.month - 1, local.day)
  for (let day = 0; day < 15; day++) {
    const date = new Date(start + day * 86400000)
    const weekday = date.getUTCDay()
    if (rule.kind === 'weekdays' && (weekday === 0 || weekday === 6)) continue
    if (rule.kind === 'weekly' && !rule.weekdays!.includes(weekday)) continue
    const candidate = localTimeToInstant(date.toISOString().slice(0, 10), rule.time, rule.timeZone)
    if (candidate && Date.parse(candidate) > after) return candidate
  }
  throw new Error('无法计算下一次执行时间')
}

export function missedOccurrences(rule: ScheduleRule, first: string, through: number) {
  if (Date.parse(first) > through) return { count: 0, next: first }
  if (rule.kind === 'interval') {
    const step = rule.every * (rule.unit === 'minutes' ? 60000 : 3600000)
    const count = Math.floor((through - Date.parse(first)) / step) + 1
    return { count, next: new Date(Date.parse(first) + count * step).toISOString() }
  }
  let next: string | undefined = first
  let count = 0
  while (next && Date.parse(next) <= through) {
    count++
    next = nextOccurrence(rule, Date.parse(next))
  }
  return { count, next }
}

const weekdayNames = ['日', '一', '二', '三', '四', '五', '六']
export function describeRule(rule: ScheduleRule) {
  if (rule.kind === 'once') return `单次 · ${formatScheduleTime(rule.at, rule.timeZone)}`
  if (rule.kind === 'interval') return `每隔 ${rule.every} ${rule.unit === 'minutes' ? '分钟' : '小时'}`
  const prefix =
    rule.kind === 'daily'
      ? '每天'
      : rule.kind === 'weekdays'
        ? '工作日'
        : `每周${[...new Set(rule.weekdays)]
            .sort()
            .map((day) => weekdayNames[day])
            .join('、')}`
  return `${prefix} ${rule.time}`
}
export function formatScheduleTime(value: string, timeZone: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(value))
}
