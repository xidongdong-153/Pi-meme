import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import type { FileEntry, SessionHeader } from '@earendil-works/pi-coding-agent'
import type { PiSessionSummary } from '@pi-meme/contracts/sessions'
import { readSessionHistory } from '@pi-meme/pi-runtime/session-history'

export {
  prefetchSessionHistory,
  readSessionHistory,
  type SessionHistoryData,
} from '@pi-meme/pi-runtime/session-history'

function sessionEntry(value: unknown): FileEntry | null {
  if (!value || typeof value !== 'object' || !('type' in value) || typeof value.type !== 'string') return null
  if (value.type === 'message' && (!('message' in value) || !value.message || typeof value.message !== 'object'))
    return null
  return value as FileEntry
}

type SummaryState = {
  header: SessionHeader | null
  name?: string
  firstMessage: string
  messageCount: number
  hasUserMessage: boolean
  completedAt: string | null
  completionSource?: { id: string; revision: string }
  /** 非线性分支或上下文变换必须复用正文投影，不能按物理文件顺序判断完成身份。 */
  appendSafe: boolean
  leafId: string | null
}
export type SessionSummaryIndex = {
  offset: number
  signature: string
  state: SummaryState
}
function applyLine(state: SummaryState, line: string) {
  let entry: FileEntry | null
  try {
    entry = sessionEntry(JSON.parse(line))
  } catch {
    return
  }
  if (!entry) return
  if (!state.header) {
    if (entry.type === 'session') state.header = entry
    return
  }
  if (
    !['message', 'model_change', 'thinking_level_change', 'usage', 'session_info'].includes(entry.type) ||
    typeof entry.id !== 'string' ||
    !('parentId' in entry) ||
    entry.parentId !== state.leafId
  )
    state.appendSafe = false
  state.leafId = entry.id ?? null
  if (entry.type === 'session_info') state.name = entry.name?.trim() || undefined
  if (entry.type !== 'message') return
  state.messageCount++
  if (entry.message.role === 'assistant' && entry.message.stopReason !== 'toolUse') {
    state.completedAt = entry.timestamp
    state.completionSource = entry.id ? { id: entry.id, revision: entry.id } : undefined
  }
  if (entry.message.role !== 'user') return
  state.hasUserMessage = true
  if (state.firstMessage) return
  const content = entry.message.content
  state.firstMessage =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? (content.find((part) => part.type === 'text')?.text ?? '')
        : ''
}
/** 只在完整换行处保存偏移；未结束的 UTF-8/JSON 行留给下一次追加读取。 */
export async function readSessionSummaryIndex(
  filePath: string,
  mtime: number,
  size: number,
  previous?: SessionSummaryIndex,
) {
  const handle = await open(filePath, 'r')
  try {
    let offset = 0
    let state: SummaryState = {
      header: null,
      firstMessage: '',
      messageCount: 0,
      hasUserMessage: false,
      completedAt: null,
      appendSafe: true,
      leafId: null,
    }
    if (previous && previous.offset <= size) {
      const signature = Buffer.alloc(Math.min(128, previous.offset))
      await handle.read(signature, 0, signature.length, previous.offset - signature.length)
      if (signature.toString('base64') === previous.signature) {
        offset = previous.offset
        state = { ...previous.state }
      }
    }
    let position = offset
    let tail: Buffer[] = []
    while (position < size) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, size - position))
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position)
      if (!bytesRead) break
      position += bytesRead
      const data = chunk.subarray(0, bytesRead)
      let start = 0
      for (let newline = data.indexOf(10, start); newline !== -1; newline = data.indexOf(10, start)) {
        const part = data.subarray(start, newline)
        applyLine(state, (tail.length ? Buffer.concat([...tail, part]) : part).toString('utf8'))
        tail = []
        offset = position - bytesRead + newline + 1
        start = newline + 1
      }
      if (start < bytesRead) tail.push(data.subarray(start))
    }
    const signature = Buffer.alloc(Math.min(128, offset))
    await handle.read(signature, 0, signature.length, offset - signature.length)
    const index: SessionSummaryIndex = { offset, signature: signature.toString('base64'), state }
    // 当前切片的完整 JSON 尾行可用于展示，但未换行前不能计入增量检查点。
    const view = { ...state }
    if (tail.length) applyLine(view, Buffer.concat(tail).toString('utf8'))
    if (!view.appendSafe) {
      // 普通线性追加不加载正文；分支、压缩、隐藏或编辑使用与聊天相同的 SDK 投影。
      const history = await readSessionHistory(filePath)
      const completed = history.messages.findLast(
        (message) => message.role === 'assistant' && message.stopReason !== 'toolUse',
      )
      const timestamp = completed && (completed.completedAt ?? completed.timestamp)
      view.completedAt =
        typeof timestamp === 'number' && Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null
      view.completionSource = completed?.sourceEntry
        ? { id: completed.sourceEntry.id, revision: completed.sourceEntry.revision }
        : undefined
    }
    const header = view.header
    const summary: PiSessionSummary | null = !view.hasUserMessage
      ? null
      : {
          id: header?.id ?? path.basename(filePath).split('_')[1]?.replace('.jsonl', '') ?? '',
          path: filePath,
          cwd: header?.cwd ?? '',
          name: view.name,
          firstMessage: view.firstMessage,
          parentSessionPath: header?.parentSession,
          created: header?.timestamp ?? new Date(mtime).toISOString(),
          modified: new Date(mtime).toISOString(),
          completedAt: view.completedAt,
          completionSource: view.completionSource,
          messageCount: view.messageCount,
        }
    return { index, summary }
  } finally {
    await handle.close()
  }
}
/** 只读取真实会话头，不能从 Pi 编码目录反推项目路径。 */
export async function readSessionCwd(filePath: string): Promise<string | undefined> {
  const input = createReadStream(filePath, { encoding: 'utf8' })
  const lines = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      try {
        const entry = sessionEntry(JSON.parse(line))
        if (entry?.type === 'session') return entry.cwd
      } catch {
        continue
      }
    }
  } finally {
    lines.close()
    input.destroy()
  }
}
