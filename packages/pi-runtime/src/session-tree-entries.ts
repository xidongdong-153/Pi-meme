import { homedir } from 'node:os'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import type { PiBranchEntry } from '@pi-meme/contracts/pi'
import { skillMessageText } from '@pi-meme/contracts/skills'

const PREVIEW_LIMIT = 500

type ToolCallInfo = { name: string; arguments: Record<string, unknown> }

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (block && typeof block === 'object' && 'type' in block && block.type === 'text') {
      text += (block as { text?: string }).text ?? ''
    }
  }
  return text
}

function normalize(text: string): string {
  return text.replace(/[\n\t]/g, ' ').trim()
}

function clip(text: string, limit = PREVIEW_LIMIT): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

function shortenPath(path: string): string {
  const home = homedir()
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path
}

/** 把工具调用压成一行摘要，格式对齐 Pi TUI 的 tree-selector。 */
function formatToolCall(name: string, args: Record<string, unknown>): string {
  const path = shortenPath(String(args.path ?? args.file_path ?? ''))
  switch (name) {
    case 'read': {
      const offset = typeof args.offset === 'number' ? args.offset : undefined
      const limit = typeof args.limit === 'number' ? args.limit : undefined
      let display = path
      if (offset !== undefined || limit !== undefined) {
        const start = offset ?? 1
        const end = limit !== undefined ? start + limit - 1 : ''
        display += `:${start}${end ? `-${end}` : ''}`
      }
      return `[read: ${display}]`
    }
    case 'write':
      return `[write: ${path}]`
    case 'edit':
      return `[edit: ${path}]`
    case 'grep':
      return `[grep: /${String(args.pattern ?? '')}/ in ${shortenPath(String(args.path ?? '.'))}]`
    case 'find':
      return `[find: ${String(args.pattern ?? '')} in ${shortenPath(String(args.path ?? '.'))}]`
    case 'ls':
      return `[ls: ${shortenPath(String(args.path ?? '.'))}]`
    case 'bash': {
      const raw = String(args.command ?? '')
      return `[bash: ${normalize(raw).slice(0, 50)}${raw.length > 50 ? '...' : ''}]`
    }
    default: {
      const json = JSON.stringify(args) ?? ''
      return `[${name}: ${json.slice(0, 40)}${json.length > 40 ? '...' : ''}]`
    }
  }
}

/** 先扫一遍助手消息里的 toolCall 块，工具结果条目才能还原成 [read: ...] 这类摘要。 */
function collectToolCalls(entries: readonly SessionEntry[]): Map<string, ToolCallInfo> {
  const calls = new Map<string, ToolCallInfo>()
  for (const entry of entries) {
    if (entry.type !== 'message' || entry.message.role !== 'assistant') continue
    for (const block of entry.message.content) {
      if (block.type === 'toolCall' && block.id) calls.set(block.id, { name: block.name, arguments: block.arguments })
    }
  }
  return calls
}

function entryPreview(entry: SessionEntry, toolCalls: Map<string, ToolCallInfo>): string {
  switch (entry.type) {
    case 'message': {
      const message = entry.message
      switch (message.role) {
        case 'user':
          return clip(skillMessageText(textFromContent(message.content)).trim())
        case 'assistant': {
          const text = textFromContent(message.content).trim()
          if (text) return clip(text)
          if (message.stopReason === 'aborted') return '(已中止)'
          if (message.errorMessage) return clip(normalize(message.errorMessage))
          return ''
        }
        case 'toolResult': {
          const call = message.toolCallId ? toolCalls.get(message.toolCallId) : undefined
          return call ? formatToolCall(call.name, call.arguments) : `[${message.toolName || 'tool'}]`
        }
        case 'system':
          return clip(normalize(textFromContent(message.content)))
        case 'bashExecution':
          return `[bash]: ${normalize(message.command)}`
        case 'custom':
          return `[${message.customType}]: ${clip(normalize(textFromContent(message.content)))}`
        default:
          return `[${message.role}]`
      }
    }
    case 'compaction':
      return `[compaction: ${Math.round(entry.tokensBefore / 1000)}k tokens]`
    case 'branch_summary':
      return `[branch summary]: ${clip(normalize(entry.summary))}`
    case 'custom_message':
      return `[${entry.customType}]: ${clip(normalize(textFromContent(entry.content)))}`
    case 'model_change':
      return `[model: ${entry.modelId}]`
    case 'thinking_level_change':
      return `[thinking: ${entry.thinkingLevel}]`
    case 'custom':
      return `[custom: ${entry.customType}]`
    case 'context_edit':
      return `[context ${entry.replacement === null ? 'omit' : 'replace'}: ${entry.targetId}]`
    case 'label':
      return `[label: ${entry.label ?? '(cleared)'}]`
    case 'session_info':
      return entry.name ? `[title: ${entry.name}]` : '[title: empty]'
    default:
      return ''
  }
}

/** 把会话条目投影成 Session Tree 需要的扁平结构，附带单行摘要 preview。 */
export function projectBranchEntries(entries: readonly SessionEntry[]): PiBranchEntry[] {
  const toolCalls = collectToolCalls(entries)
  return entries.map((entry) => ({
    id: entry.id,
    parentId: entry.parentId,
    timestamp: entry.timestamp,
    type: entry.type,
    role: entry.type === 'message' ? entry.message.role : undefined,
    messageTimestamp: entry.type === 'message' ? entry.message.timestamp : undefined,
    preview: entryPreview(entry, toolCalls) || undefined,
  }))
}
