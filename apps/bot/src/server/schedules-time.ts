import type { Schedule } from '../shared/types.js'
import { BotError } from './errors.js'

type Rule = Pick<Schedule, 'kind' | 'timezone' | 'at' | 'time' | 'weekdays'>

function formatter(timezone: string) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
  } catch {
    throw new BotError(400, 'invalid-input', '请选择有效的 IANA 时区')
  }
}

function parts(format: Intl.DateTimeFormat, instant: number) {
  const values = Object.fromEntries(format.formatToParts(instant).map((part) => [part.type, part.value]))
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  }
}

export function validateRule(rule: Rule) {
  formatter(rule.timezone)
  if (!['once', 'daily', 'weekly'].includes(rule.kind))
    throw new BotError(400, 'invalid-input', '请选择单次、每天或每周')
  if (rule.kind === 'once') {
    const timestamp =
      typeof rule.at === 'string'
        ? /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i.exec(
            rule.at,
          )
        : null
    const date = timestamp ? new Date(`${timestamp[1]}-${timestamp[2]}-${timestamp[3]}T00:00:00Z`) : undefined
    if (
      !timestamp ||
      !date ||
      date.getUTCFullYear() !== Number(timestamp[1]) ||
      date.getUTCMonth() + 1 !== Number(timestamp[2]) ||
      date.getUTCDate() !== Number(timestamp[3]) ||
      !Number.isFinite(Date.parse(rule.at))
    ) {
      throw new BotError(400, 'invalid-input', '单次执行时间必须是有效的 ISO 日期，且包含明确时区')
    }
  } else if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(rule.time)) {
    throw new BotError(400, 'invalid-input', '执行时间格式为 HH:mm')
  }
  if (
    !Array.isArray(rule.weekdays) ||
    rule.weekdays.length > 7 ||
    rule.weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)
  ) {
    throw new BotError(400, 'invalid-input', '星期必须是 0–6 的整数')
  }
  if (rule.kind === 'weekly' && rule.weekdays.length === 0)
    throw new BotError(400, 'invalid-input', '每周计划至少选择一天')
}

/** Resolve each wall-clock date to its earliest matching UTC instant: gaps skip, folds run once. */
export function nextOccurrence(rule: Rule, after = Date.now()): string | undefined {
  validateRule(rule)
  if (rule.kind === 'once') return Date.parse(rule.at) > after ? new Date(rule.at).toISOString() : undefined
  const format = formatter(rule.timezone)
  const local = parts(format, after)
  const [hour, minute] = rule.time.split(':').map(Number)
  for (let delta = 0; delta < 9; delta++) {
    const day = new Date(Date.UTC(local.year, local.month - 1, local.day + delta))
    if (rule.kind === 'weekly' && !rule.weekdays.includes(day.getUTCDay())) continue
    const wall = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, minute)
    const offsets = new Set<number>()
    for (let sample = wall - 36 * 3_600_000; sample <= wall + 36 * 3_600_000; sample += 6 * 3_600_000) {
      const value = parts(format, sample)
      offsets.add(Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute, value.second) - sample)
    }
    const candidates = [...offsets]
      .map((offset) => wall - offset)
      .filter((instant) => {
        const value = parts(format, instant)
        return (
          value.year === day.getUTCFullYear() &&
          value.month === day.getUTCMonth() + 1 &&
          value.day === day.getUTCDate() &&
          value.hour === hour &&
          value.minute === minute
        )
      })
      .sort((a, b) => a - b)
    if (candidates[0] !== undefined && candidates[0] > after) return new Date(candidates[0]).toISOString()
  }
  return undefined
}

export function previewOccurrences(rule: Rule, count = 5) {
  const occurrences: string[] = []
  let after = Date.now()
  for (let index = 0; index < count; index++) {
    const next = nextOccurrence(rule, after)
    if (!next) break
    occurrences.push(next)
    after = Date.parse(next)
  }
  return { nextRunAt: occurrences[0], occurrences, timezone: rule.timezone }
}
