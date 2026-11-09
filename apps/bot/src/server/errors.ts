export class BotError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message)
  }
}
export function text(value: unknown, name: string, max = 8000, optional = false): string {
  if (optional && (value === undefined || value === null)) return ''
  if (typeof value !== 'string' || (!optional && !value.trim()) || value.length > max) {
    throw new BotError(400, 'invalid-input', `${name}须为${optional ? '不超过' : '1–'}${max}字符的文本`)
  }
  return value.trim()
}
export function ids(value: unknown, name: string, max = 32): string[] {
  if (
    !Array.isArray(value) ||
    value.length > max ||
    value.some((item) => typeof item !== 'string' || item.length > 128)
  ) {
    throw new BotError(400, 'invalid-input', `${name}无效`)
  }
  return [...new Set(value as string[])]
}
export function revision(current: { revision: number }, expected: unknown) {
  if (!Number.isInteger(expected) || !Number.isInteger(current.revision) || current.revision !== expected)
    throw new BotError(409, 'revision-conflict', '配置已改变，请重新读取后保存', { revision: current.revision })
}
export function requireItem<T>(item: T | undefined, name = '资源'): T {
  if (!item || typeof item !== 'object' || !Object.hasOwn(item, 'id'))
    throw new BotError(404, 'not-found', `${name}不存在`)
  return item
}
export function touch<T extends { revision: number; updatedAt: string }>(item: T): T {
  item.revision++
  item.updatedAt = new Date().toISOString()
  return item
}
