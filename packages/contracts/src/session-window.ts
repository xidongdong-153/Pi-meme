import type { PiMessage } from './pi'
import type { SessionMessagePage, SessionWindow } from './sessions'

/** 按原生 entry ID 分页；页首保留完整用户轮次，不截断助手与工具结果。 */
export function projectSessionWindow<T extends { messages: PiMessage[]; messagePage?: SessionMessagePage }>(
  value: T,
  input?: unknown,
): T & { messagePage?: SessionMessagePage } {
  if (input === undefined) return value
  const options = input as SessionWindow | null
  if (
    !options ||
    typeof options !== 'object' ||
    !Number.isInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 500 ||
    (options.before !== undefined && (typeof options.before !== 'string' || !options.before)) ||
    (options.from !== undefined && (typeof options.from !== 'string' || !options.from))
  )
    throw new Error('会话分页参数无效')
  const end = options.before
    ? value.messages.findIndex((message) => message.sourceEntry?.id === options.before)
    : value.messages.length
  if (end < 0) throw new Error('会话历史已更新，请重新加载')
  const retained = options.from ? value.messages.findIndex((message) => message.sourceEntry?.id === options.from) : -1
  let start = retained >= 0 && retained < end ? retained : Math.max(0, end - options.limit)
  while (start > 0 && value.messages[start]?.role !== 'user') start--
  // 旧记录缺少稳定 ID 时返回完整前缀，避免使用时间戳或数组位置充当游标。
  if (start > 0 && !value.messages[start]?.sourceEntry?.id) start = 0
  return {
    ...value,
    messages: value.messages.slice(start, end),
    messagePage: start > 0 ? { before: value.messages[start].sourceEntry!.id } : undefined,
  }
}
