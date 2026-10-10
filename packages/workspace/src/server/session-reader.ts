import { createReadStream } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import type { FileEntry, SessionHeader } from '@earendil-works/pi-coding-agent'
import type { PiSessionSummary } from '@pi-meme/contracts/sessions'

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

export async function readSessionSummary(filePath: string, mtime: number): Promise<PiSessionSummary | null> {
  const input = createReadStream(filePath, { encoding: 'utf8' })
  try {
    const rl = createInterface({
      input,
      crlfDelay: Infinity,
    })

    let header: SessionHeader | null = null
    let name: string | undefined
    let firstMessage = ''
    let messageCount = 0
    let hasUserMessage = false
    let completedAt: string | null = null

    for await (const line of rl) {
      if (!line.trim()) continue
      let entry: FileEntry | null
      try {
        entry = sessionEntry(JSON.parse(line))
      } catch {
        continue
      }

      if (!entry) continue
      if (!header) {
        if (entry.type === 'session') header = entry
        continue
      }

      if (entry.type === 'session_info') name = entry.name?.trim() || undefined

      if (entry.type === 'message') {
        messageCount++
        if (entry.message.role === 'assistant' && entry.message.stopReason !== 'toolUse') completedAt = entry.timestamp
        if (entry.message.role === 'user') hasUserMessage = true
        if (!firstMessage && entry.message && entry.message.role === 'user') {
          const content = entry.message.content
          if (typeof content === 'string') {
            firstMessage = content
          } else if (Array.isArray(content)) {
            const textObj = content.find((c) => c.type === 'text')
            if (textObj) firstMessage = textObj.text
          }
        }
      }
    }

    input.destroy()
    const id = header ? header.id : path.basename(filePath).split('_')[1]?.replace('.jsonl', '') || ''
    const cwd = header?.cwd || ''
    const created = header?.timestamp || new Date(mtime).toISOString()
    const modified = new Date(mtime).toISOString()

    if (!hasUserMessage) return null
    const summary: PiSessionSummary = {
      id,
      path: filePath,
      cwd,
      name,
      firstMessage,
      parentSessionPath: header?.parentSession,
      created,
      modified,
      completedAt,
      messageCount,
    }

    return summary
  } catch {
    return null
  } finally {
    input.destroy()
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
