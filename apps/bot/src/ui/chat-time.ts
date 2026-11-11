function calendarDay(date: Date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

function dayLabel(date: Date) {
  const today = new Date()
  if (calendarDay(date) === calendarDay(today)) return '今天'
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (calendarDay(date) === calendarDay(yesterday)) return '昨天'
  return date.toLocaleDateString('zh-CN', {
    ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' as const } : {}),
    month: 'long',
    day: 'numeric',
  })
}

export function formatChatTime(value: string, compact = false) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  const day = dayLabel(date)
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  if (compact) return day === '今天' ? time : day
  return `${day} ${time}`
}

export function hasTimeBreak(current: string, previous?: string) {
  if (!previous) return true
  const date = new Date(current)
  const before = new Date(previous)
  return calendarDay(date) !== calendarDay(before) || date.getTime() - before.getTime() >= 15 * 60 * 1000
}
