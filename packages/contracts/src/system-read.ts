export const systemReadTextByteLimit = 48 * 1024
export const systemReadPageLimit = 100

export type ReadQuery = { cursor?: string; offset?: number; limit?: number; revision?: string }
export type ReadPage<T> = {
  items: T[]
  total: number
  revision: string
  nextCursor?: string
  observedAt: string
}
export type ReadPiece = {
  content: string
  offset: number
  total: number
  revision: string
  nextOffset?: number
  observedAt: string
}
export type ReadErrorCode =
  | 'invalid-input'
  | 'not-found'
  | 'not-supported'
  | 'not-loaded'
  | 'disabled'
  | 'disconnected'
  | 'permission-denied'
  | 'stale-cursor'
  | 'cancelled'
  | 'timeout'
  | 'internal-error'

export class SystemReadError extends Error {
  constructor(
    readonly code: ReadErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'SystemReadError'
  }
}

export function readRecord(value: unknown, keys: readonly string[], label = '读取参数'): Record<string, unknown> {
  if (value === undefined) return {}
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.keys(value).some(
      (key) => !keys.includes(key) || key === '__proto__' || key === 'constructor' || key === 'prototype',
    )
  )
    throw new SystemReadError('invalid-input', `${label}无效或包含未知字段`)
  return value as Record<string, unknown>
}

export function validateReadArguments(schema: Record<string, unknown> | undefined, args: unknown[]): void {
  const invalid = () => {
    throw new SystemReadError('invalid-input', '读取参数与 capabilities.describe 中的结构或范围不匹配')
  }
  const visit = (value: unknown, shape: Record<string, unknown> | undefined, depth: number): void => {
    if (depth > 16) invalid()
    if (shape?.enum && !(shape.enum as unknown[]).includes(value)) invalid()
    const alternatives = shape?.oneOf ?? shape?.anyOf
    if (Array.isArray(alternatives)) {
      const matches = alternatives.some((entry) => {
        try {
          visit(value, entry as Record<string, unknown>, depth + 1)
          return true
        } catch {
          return false
        }
      })
      if (!matches) invalid()
    }
    const expected = shape?.type
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
    const validType = (kind: unknown) => kind === actual || (kind === 'integer' && Number.isSafeInteger(value))
    if (expected !== undefined && !(Array.isArray(expected) ? expected.some(validType) : validType(expected))) invalid()
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) invalid()
      if (typeof shape?.minimum === 'number' && value < shape.minimum) invalid()
      if (typeof shape?.maximum === 'number' && value > shape.maximum) invalid()
    }
    if (typeof value === 'string') {
      if (typeof shape?.minLength === 'number' && value.length < shape.minLength) invalid()
      if (typeof shape?.maxLength === 'number' && value.length > shape.maxLength) invalid()
    }
    if (Array.isArray(value)) {
      if (typeof shape?.minItems === 'number' && value.length < shape.minItems) invalid()
      if (typeof shape?.maxItems === 'number' && value.length > shape.maxItems) invalid()
      const prefix = shape?.prefixItems
      for (let index = 0; index < value.length; index++) {
        const item = Array.isArray(prefix) ? prefix[index] : shape?.items
        visit(value[index], item && typeof item === 'object' ? (item as Record<string, unknown>) : undefined, depth + 1)
      }
    } else if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>
      const properties = (shape?.properties ?? {}) as Record<string, Record<string, unknown>>
      if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid()
      if (
        Array.isArray(shape?.required) &&
        shape.required.some((key) => typeof key !== 'string' || !Object.hasOwn(record, key))
      )
        invalid()
      for (const key of Object.keys(record)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) invalid()
        if (shape?.additionalProperties === false && !Object.hasOwn(properties, key)) invalid()
        visit(record[key], properties[key], depth + 1)
      }
    }
  }
  visit(args, schema, 0)
}

export function readString(value: unknown, label: string, max = 1024): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new SystemReadError('invalid-input', `${label}必须是 1 到 ${max} 字符的文本`)
  return value
}

export function readInteger(value: unknown, fallback: number, max: number, min = 0): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
    throw new SystemReadError('invalid-input', `读取范围必须是 ${min} 到 ${max} 之间的整数`)
  return value as number
}

/** A revision is a consistency token, never an authorization credential. */
export function readRevision(value: unknown): string {
  const text = JSON.stringify(value) ?? 'null'
  let first = 2166136261
  let second = 5381
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    first = Math.imul(first ^ code, 16777619)
    second = Math.imul(second, 33) ^ code
  }
  return `${text.length.toString(36)}-${(first >>> 0).toString(36)}-${(second >>> 0).toString(36)}`
}

function encodeCursor(value: unknown): string {
  return encodeURIComponent(JSON.stringify(value))
}

export function readPage<T>(
  items: readonly T[],
  query: ReadQuery = {},
  binding = '',
  revision = readRevision(items),
): ReadPage<T> {
  const limit = readInteger(query.limit, 20, systemReadPageLimit, 1)
  let offset = readInteger(query.offset, 0, Number.MAX_SAFE_INTEGER)
  if (query.revision !== undefined && query.revision !== revision)
    throw new SystemReadError('stale-cursor', '数据已变化，请重新读取')
  if (query.cursor !== undefined) {
    try {
      if (typeof query.cursor !== 'string' || query.cursor.length > 4096) throw new Error('invalid-cursor')
      const cursor = JSON.parse(decodeURIComponent(query.cursor)) as Record<string, unknown>
      if (cursor.binding !== binding || cursor.revision !== revision) throw new Error('stale-cursor')
      offset = readInteger(cursor.offset, 0, Number.MAX_SAFE_INTEGER)
    } catch {
      throw new SystemReadError('stale-cursor', '分页游标已过期或不属于此查询，请重新读取')
    }
  }
  const next = offset + limit
  return {
    items: items.slice(offset, next),
    total: items.length,
    revision,
    nextCursor: next < items.length ? encodeCursor({ binding, revision, offset: next }) : undefined,
    observedAt: new Date().toISOString(),
  }
}

export function readText(content: string, query: ReadQuery = {}, revision = readRevision(content)): ReadPiece {
  if (query.revision !== undefined && query.revision !== revision)
    throw new SystemReadError('stale-cursor', '正文已变化，请重新读取')
  const offset = readInteger(query.offset, 0, content.length)
  if (offset > 0 && /[\uDC00-\uDFFF]/.test(content[offset] ?? '') && /[\uD800-\uDBFF]/.test(content[offset - 1]))
    throw new SystemReadError('invalid-input', '正文偏移不能位于 Unicode 字符中间')
  const limit = readInteger(query.limit, 12_000, 20_000, 1)
  let end = Math.min(content.length, offset + limit)
  if (end < content.length && end > offset && /[\uD800-\uDBFF]/.test(content[end - 1])) end++
  const encoder = new TextEncoder()
  while (end > offset && encoder.encode(JSON.stringify(content.slice(offset, end))).length > 40 * 1024) {
    end = offset + Math.max(1, Math.floor((end - offset) * 0.8))
  }
  if (end < content.length && end > offset && /[\uD800-\uDBFF]/.test(content[end - 1])) end--
  return {
    content: content.slice(offset, end),
    offset,
    total: content.length,
    revision,
    nextOffset: end < content.length ? end : undefined,
    observedAt: new Date().toISOString(),
  }
}
