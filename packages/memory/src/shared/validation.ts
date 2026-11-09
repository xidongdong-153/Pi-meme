import type { MemoryEntryInput, MemoryScope } from '@pi-meme/contracts/memory'

export const memoryLimits = {
  entries: 1000,
  stateBytes: 20 * 1024 * 1024,
  inputBytes: 64 * 1024,
  inputTokens: 12000,
  outputBytes: 16 * 1024,
  candidates: 10,
  maxTokens: 2000,
  callsPerDay: 20,
} as const

export function object(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('记忆参数必须是对象')
}
export function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error('记忆参数包含未知字段')
}
export function text(value: unknown, name: string, max: number): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0'))
    throw new Error(`${name}必须是1到${max}字符的文本`)
}
export function integer(value: unknown, name: string, min = 0, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${name}无效`)
}
export function scope(value: unknown): asserts value is MemoryScope {
  object(value)
  if (value.kind === 'global') keys(value, ['kind'])
  else if (value.kind === 'project') {
    keys(value, ['kind', 'projectId'])
    text(value.projectId, '项目标识', 256)
  } else throw new Error('记忆作用域无效')
}
export function entryInput(value: unknown): asserts value is MemoryEntryInput {
  object(value)
  keys(value, ['title', 'content', 'scope'])
  text(value.title, '记忆标题', 80)
  text(value.content, '记忆正文', 2000)
  scope(value.scope)
}
export function sameScope(a: MemoryScope, b: MemoryScope) {
  return a.kind === b.kind && (a.kind === 'global' || (b.kind === 'project' && a.projectId === b.projectId))
}
export function parseJson(textValue: string): unknown {
  if (new TextEncoder().encode(textValue).length > memoryLimits.outputBytes) throw new Error('模型输出超过16KiB')
  // Deliberately do not repair fences, partial JSON, or provider prose into accepted mutations.
  return JSON.parse(textValue) as unknown
}
