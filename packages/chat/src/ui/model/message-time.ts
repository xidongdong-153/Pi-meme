const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'] as const
const DAY_MS = 86_400_000

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function clock(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 用本地年月日生成日序号，避免夏令时把相差不足 24 小时的两天算成同一天。 */
function localDayNumber(date: Date): number {
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS)
}

/**
 * 消息真实时间。
 * 今天只显示时分；昨天加「昨天」；过去 2 到 6 天显示星期；今年更早显示月日；跨年或未来日期显示年月日。
 */
export function formatMessageTime(timestamp: number, now = Date.now()): string {
  if (!Number.isFinite(timestamp) || !Number.isFinite(now)) return ''
  const date = new Date(timestamp)
  const current = new Date(now)
  if (Number.isNaN(date.getTime()) || Number.isNaN(current.getTime())) return ''
  const time = clock(date)
  const dayDiff = localDayNumber(current) - localDayNumber(date)
  if (dayDiff === 0) return time
  if (dayDiff === 1) return `昨天 ${time}`
  if (dayDiff > 1 && dayDiff < 7) return `${WEEKDAYS[date.getDay()]} ${time}`
  const month = date.getMonth() + 1
  const day = date.getDate()
  if (dayDiff > 0 && date.getFullYear() === current.getFullYear()) return `${month}月${day}日 ${time}`
  return `${date.getFullYear()}年${month}月${day}日 ${time}`
}

/** 悬停和读屏用的完整本地时间，不随相对日期缩短。 */
export function formatMessageTimeTitle(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return ''
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${WEEKDAYS[date.getDay()]} ${clock(date)}`
}
