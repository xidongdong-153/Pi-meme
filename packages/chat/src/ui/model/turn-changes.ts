import type { PiMessage } from '@pi-meme/contracts/pi'
import type { ToolRun } from './types'

export type TurnChangeEntry =
  { toolCallId: string; kind: 'edit'; patch?: string } | { toolCallId: string; kind: 'write' }

export type TurnFileChange = {
  path: string
  entries: TurnChangeEntry[]
}

type FileCall = { id: string; name: 'edit' | 'write'; path: string }

function filePath(args: unknown) {
  if (!args || typeof args !== 'object') return
  const path = (args as { path?: unknown }).path
  return typeof path === 'string' && path ? path : undefined
}

function toolPatch(details: unknown) {
  if (!details || typeof details !== 'object') return
  const patch = (details as { patch?: unknown }).patch
  return typeof patch === 'string' && patch.trim() ? patch : undefined
}

function liveDetails(result: unknown) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return
  return (result as { details?: unknown }).details
}

/** 最后一条用户消息之后，本会话成功的 edit / write。顺序按工具调用，不按结果到达。 */
export function collectTurnChanges(
  messages: readonly PiMessage[],
  tools: Readonly<Record<string, ToolRun>>,
): TurnFileChange[] {
  let start = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      start = index + 1
      break
    }
  }
  const slice = messages.slice(start)
  const calls: FileCall[] = []
  for (const message of slice) {
    if (message.role !== 'assistant') continue
    for (const part of message.content) {
      if (part.type !== 'toolCall' || (part.name !== 'edit' && part.name !== 'write')) continue
      const path = filePath(part.arguments)
      if (!path) continue
      calls.push({ id: part.id, name: part.name, path })
    }
  }
  const results = new Map<string, Extract<PiMessage, { role: 'toolResult' }>>()
  for (const message of slice) {
    if (message.role === 'toolResult') results.set(message.toolCallId, message)
  }
  const files = new Map<string, TurnFileChange>()
  for (const call of calls) {
    const result = results.get(call.id)
    const details = result ? result.details : liveDetails(tools[call.id]?.result)
    if (result ? result.isError : tools[call.id]?.status !== 'success') continue
    let file = files.get(call.path)
    if (!file) {
      file = { path: call.path, entries: [] }
      files.set(call.path, file)
    }
    file.entries.push(
      call.name === 'write'
        ? { toolCallId: call.id, kind: 'write' }
        : { toolCallId: call.id, kind: 'edit', patch: toolPatch(details) },
    )
  }
  return [...files.values()]
}
